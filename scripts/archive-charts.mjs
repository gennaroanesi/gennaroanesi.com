/**
 * archive-charts.mjs
 *
 * Fetches FAA approach chart PDFs from aeronav.faa.gov and uploads them to S3,
 * then updates the flight record with the archived S3 keys.
 *
 * The FAA publishes charts under a 28-day cycle:
 *   https://aeronav.faa.gov/d-tpp/{CYCLE}/{pdf_name}
 *
 * Charts are public domain — no restrictions on archival or redistribution.
 * Old cycles disappear from aeronav after ~1-2 cycles, so we archive at
 * import time to preserve the chart that was current when the flight occurred.
 *
 * S3 key format:  public/flights/charts/{pdf_name_lowercase}
 * (cycle-independent — same pdfName across cycles means same chart revision)
 *
 * Usage (standalone backfill):
 *   node scripts/archive-charts.mjs --env=prod --user=x --pass=y
 *   node scripts/archive-charts.mjs --env=prod --user=x --pass=y --flight-id=abc123
 *
 * Programmatic (from import_flights.mjs):
 *   import { archiveChartsForFlight } from "./archive-charts.mjs";
 *   await archiveChartsForFlight(jwt, flightId, approachTypes, appsyncUrl, apiKey);
 */

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";

// ── Config ────────────────────────────────────────────────────────────────────

const REGION      = "us-east-1";
const BUCKET      = "gennaroanesi.com";
const CHART_PREFIX = "public/flights/charts/";
const FAA_BASE    = "https://aeronav.faa.gov/d-tpp";
const DELAY_MS    = 300; // be polite to FAA servers

// ── Approach type → d-TPP procedureName matcher ──────────────────────────────
// ForeFlight stores: "VOR-A@KILE", "ILS OR LOC RWY 13L@KGRK", etc.
// InstrumentApproach.procedureName matches d-TPP chart names like:
//   "VOR-A", "ILS OR LOC RWY 13L", "RNAV (GPS) RWY 18", etc.
//
// We do a fuzzy match: strip the @ICAO suffix, then find the closest
// procedureName in the DB for that airport.

function parseApproachType(raw) {
  // raw = "VOR-A@KILE" or "ILS OR LOC RWY 13L@KGRK"
  const atIdx = raw.lastIndexOf("@");
  if (atIdx === -1) return null;
  return {
    type: raw.slice(0, atIdx).trim(),   // "VOR-A"
    icao: raw.slice(atIdx + 1).trim(),  // "KILE"
  };
}

// Normalize both sides for fuzzy matching
function normalizeProc(s) {
  return s.toUpperCase().replace(/\s+/g, " ").trim();
}

function matchesProcedure(approachType, procedureName) {
  const a = normalizeProc(approachType);
  const p = normalizeProc(procedureName);
  // Exact match
  if (a === p) return true;
  // ForeFlight shortens: "ILS OR LOC RWY 13L" vs "ILS OR LOC RWY 13L" — fine
  // "VOR RWY 18" vs "VOR RWY 18" — fine
  // Partial: if d-TPP name starts with the ForeFlight type
  if (p.startsWith(a)) return true;
  if (a.startsWith(p)) return true;
  return false;
}

// ── GraphQL helpers ───────────────────────────────────────────────────────────

async function gql(url, authHeader, query, variables = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    const msg = json.errors.map((e) => e.message).join("; ");
    throw new Error(`GraphQL error: ${msg}`);
  }
  return json.data;
}

// Query InstrumentApproach table for a given airport, get pdfName + chartCycle.
// Uses filter-based scan since the airportId GSI may not exist yet.
// Once .secondaryIndexes((index) => [index("airportId")]) is deployed,
// swap to: listInstrumentApproachByAirportId(airportId: $airportId)
async function lookupChart(appsyncUrl, apiKey, airportId, approachType) {
  const data = await gql(
    appsyncUrl,
    { "x-api-key": apiKey },
    `query ListIAP($filter: ModelInstrumentApproachFilterInput) {
      listInstrumentApproaches(filter: $filter, limit: 200) {
        items { procedureName pdfName chartCycle }
      }
    }`,
    { filter: { airportId: { eq: airportId } } }
  );

  const items = data?.listInstrumentApproaches?.items ?? [];
  if (items.length === 0) {
    // Try with "K" prefix stripped (some airports stored as FAA 3-letter)
    const faaId = airportId.startsWith("K") ? airportId.slice(1) : airportId;
    if (faaId !== airportId) {
      return lookupChart(appsyncUrl, apiKey, faaId, approachType);
    }
    return null;
  }

  const match = items.find((item) =>
    matchesProcedure(approachType, item.procedureName)
  );
  return match ?? null;
}

// Update flight record with chart S3 keys
async function updateFlightChartKeys(appsyncUrl, jwtOrApiKey, isJwt, flightId, keys) {
  const authHeader = isJwt
    ? { Authorization: jwtOrApiKey }
    : { "x-api-key": jwtOrApiKey };

  await gql(
    appsyncUrl,
    authHeader,
    `mutation UpdateFlight($input: UpdateFlightInput!) {
      updateFlight(input: $input) { id approachChartKeys }
    }`,
    { input: { id: flightId, approachChartKeys: keys } }
  );
}

// ── S3 helpers ────────────────────────────────────────────────────────────────

const s3 = new S3Client({ region: REGION });

async function s3KeyExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function uploadToS3(key, pdfBuffer) {
  await s3.send(
    new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      Body:        pdfBuffer,
      ContentType: "application/pdf",
    })
  );
}

// ── Core archival function ────────────────────────────────────────────────────

/**
 * Archive approach charts for a single flight.
 *
 * @param {string}   jwt          - Cognito JWT (for flight update mutation)
 * @param {string}   flightId     - DynamoDB flight record ID
 * @param {string}   approachTypes - raw string e.g. "VOR-A@KILE, ILS OR LOC RWY 13L@KGRK"
 * @param {string}   appsyncUrl   - AppSync GraphQL endpoint
 * @param {string}   apiKey       - AppSync API key (for InstrumentApproach reads)
 * @param {object}   [opts]
 * @param {boolean}  [opts.verbose=true]
 * @returns {Promise<string[]>}  - S3 keys of archived charts
 */
export async function archiveChartsForFlight(
  jwt,
  flightId,
  approachTypes,
  appsyncUrl,
  apiKey,
  opts = {}
) {
  const verbose = opts.verbose ?? true;
  const log = verbose ? console.log : () => {};

  if (!approachTypes) return [];

  // Parse all approach entries from the comma-separated string
  const entries = approachTypes
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseApproachType)
    .filter(Boolean);

  if (entries.length === 0) return [];

  const archivedKeys = [];
  const seen = new Set(); // deduplicate by pdfName

  for (const { type, icao } of entries) {
    log(`  [chart] Looking up ${type} @ ${icao}…`);

    let record;
    try {
      record = await lookupChart(appsyncUrl, apiKey, icao, type);
    } catch (err) {
      log(`  [chart] ⚠  DB lookup failed: ${err.message}`);
      continue;
    }

    if (!record?.pdfName || !record?.chartCycle) {
      log(`  [chart] ⚠  No chart record found for ${type} @ ${icao}`);
      continue;
    }

    const { pdfName, chartCycle } = record;
    const pdfNameLower = pdfName.toLowerCase();

    if (seen.has(pdfNameLower)) {
      log(`  [chart] ↩  ${pdfNameLower} already processed this run`);
      const existingKey = `${CHART_PREFIX}${pdfNameLower}`;
      if (!archivedKeys.includes(existingKey)) archivedKeys.push(existingKey);
      continue;
    }
    seen.add(pdfNameLower);

    const s3Key = `${CHART_PREFIX}${pdfNameLower}`;

    // Skip if already archived
    if (await s3KeyExists(s3Key)) {
      log(`  [chart] ✓  ${pdfNameLower} already in S3`);
      archivedKeys.push(s3Key);
      continue;
    }

    // Fetch from FAA
    const faaUrl = `${FAA_BASE}/${chartCycle}/${pdfNameLower}`;
    log(`  [chart] ↓  Fetching ${faaUrl}`);

    let pdfBuffer;
    try {
      const res = await fetch(faaUrl);
      if (!res.ok) {
        log(`  [chart] ✗  FAA returned ${res.status} for ${pdfNameLower}`);
        // Try cycle +1 as fallback (chart may have rolled to next cycle)
        const nextCycle = String(parseInt(chartCycle) + 1).padStart(4, "0");
        const fallbackUrl = `${FAA_BASE}/${nextCycle}/${pdfNameLower}`;
        log(`  [chart] ↓  Trying fallback ${fallbackUrl}`);
        const res2 = await fetch(fallbackUrl);
        if (!res2.ok) {
          log(`  [chart] ✗  Fallback also failed (${res2.status}) — skipping`);
          continue;
        }
        pdfBuffer = Buffer.from(await res2.arrayBuffer());
      } else {
        pdfBuffer = Buffer.from(await res.arrayBuffer());
      }
    } catch (err) {
      log(`  [chart] ✗  Fetch error: ${err.message}`);
      continue;
    }

    // Upload to S3
    try {
      await uploadToS3(s3Key, pdfBuffer);
      log(`  [chart] ✓  Uploaded ${pdfNameLower} → s3://${BUCKET}/${s3Key}`);
      archivedKeys.push(s3Key);
    } catch (err) {
      log(`  [chart] ✗  S3 upload failed: ${err.message}`);
      continue;
    }

    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  // Persist keys on the flight record
  if (archivedKeys.length > 0) {
    try {
      await updateFlightChartKeys(appsyncUrl, jwt, true, flightId, archivedKeys);
      log(`  [chart] ✓  Updated flight ${flightId} with ${archivedKeys.length} chart key(s)`);
    } catch (err) {
      log(`  [chart] ⚠  Failed to update flight record: ${err.message}`);
    }
  }

  return archivedKeys;
}

// ── Standalone / backfill entrypoint ─────────────────────────────────────────

async function main() {
  const { appsyncUrl, clientId, region, apiKey } = getConfig();
  if (!apiKey) throw new Error("No apiKey configured for this environment in aws-config.mjs");

  const userArg = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
  const passArg = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];
  const flightIdArg = process.argv.find((a) => a.startsWith("--flight-id="))?.split("=")[1];

  if (!userArg || !passArg) {
    console.error("Usage: node archive-charts.mjs --env=prod --user=x --pass=y [--flight-id=id]");
    process.exit(1);
  }

  // Auth
  const cognito = new CognitoIdentityProviderClient({ region });
  const authRes = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
    })
  );
  const jwt = authRes.AuthenticationResult?.IdToken;
  if (!jwt) throw new Error("Auth failed");
  console.log("✓ Authenticated\n");

  // Fetch flights that have approaches but no charts yet (or specific flight)
  let flights = [];
  if (flightIdArg) {
    const data = await gql(
      appsyncUrl,
      { Authorization: jwt },
      `query GetFlight($id: ID!) {
        getFlight(id: $id) { id approachTypes approachChartKeys }
      }`,
      { id: flightIdArg }
    );
    if (data?.getFlight) flights = [data.getFlight];
  } else {
    // Paginate all flights, filter to those with approaches and no charts
    let token = null;
    do {
      const data = await gql(
        appsyncUrl,
        { Authorization: jwt },
        `query List($nextToken: String) {
          listFlights(limit: 1000, nextToken: $nextToken) {
            items { id approachTypes approachChartKeys }
            nextToken
          }
        }`,
        { nextToken: token }
      );
      const items = data?.listFlights?.items ?? [];
      flights.push(
        ...items.filter(
          (f) =>
            f.approachTypes &&
            (!f.approachChartKeys || f.approachChartKeys.length === 0)
        )
      );
      token = data?.listFlights?.nextToken ?? null;
    } while (token);
  }

  console.log(`Flights to process: ${flights.length}\n`);

  let total = 0;
  for (const flight of flights) {
    console.log(`Flight ${flight.id} — ${flight.approachTypes}`);
    const keys = await archiveChartsForFlight(
      jwt,
      flight.id,
      flight.approachTypes,
      appsyncUrl,
      apiKey
    );
    total += keys.length;
    console.log();
  }

  console.log(`\n✅  Done — ${total} chart(s) archived across ${flights.length} flight(s)`);
}

// Only run main() when executed directly
if (process.argv[1] && process.argv[1].endsWith("archive-charts.mjs")) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}
