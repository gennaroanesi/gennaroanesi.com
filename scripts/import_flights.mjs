/**
 * import_flights.mjs
 * Parses a ForeFlight CSV export and upserts records into the `flight` model.
 *
 * Usage:
 *   node import_flights.mjs --env=sandbox --user=you@example.com --pass=yourpassword --file=ForeFlight_Export.csv
 *   node import_flights.mjs --env=prod    --user=you@example.com --pass=yourpassword --file=ForeFlight_Export.csv
 *   node import_flights.mjs --env=sandbox --user=you@example.com --pass=yourpassword --file=ForeFlight_Export.csv --dry-run
 *
 * Upsert key: date + from + to + aircraftId  (skips duplicates already in DB)
 * All flights imported as published=false — publish manually via admin UI.
 */

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { getConfig } from "./aws-config.mjs";

// ── Config ────────────────────────────────────────────────────────────────────

const { region: REGION, clientId: CLIENT_ID, appsyncUrl: APPSYNC_URL } = getConfig();
const DELAY_MS = 120; // ms between mutations

// ── Args ──────────────────────────────────────────────────────────────────────

const userArg = process.argv
  .find((a) => a.startsWith("--user="))
  ?.split("=")[1];
const passArg = process.argv
  .find((a) => a.startsWith("--pass="))
  ?.split("=")[1];
const fileArg = process.argv
  .find((a) => a.startsWith("--file="))
  ?.split("=")[1];
const dryRun = process.argv.includes("--dry-run");

if (!userArg || !passArg || !fileArg) {
  console.error(
    "Usage: node import_flights.mjs --env=sandbox|prod --user=x --pass=y --file=ForeFlight.csv [--dry-run]",
  );
  process.exit(1);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getJwt() {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const res = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
    }),
  );
  if (!res.AuthenticationResult?.IdToken)
    throw new Error("Auth failed. Challenge: " + res.ChallengeName);
  return res.AuthenticationResult.IdToken;
}

// ── GraphQL helpers ───────────────────────────────────────────────────────────

async function gql(jwt, query, variables = {}) {
  const res = await fetch(APPSYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: jwt },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fetch existing flights for dedup ─────────────────────────────────────────

async function fetchExistingKeys(jwt) {
  const keys = new Set();
  let nextToken = null;
  do {
    const result = await gql(
      jwt,
      `
      query List($nextToken: String) {
        listFlights(limit: 1000, nextToken: $nextToken) {
          items { date from to aircraftId }
          nextToken
        }
      }
    `,
      { nextToken },
    );
    for (const item of result.data?.listFlights?.items ?? []) {
      keys.add(`${item.date}|${item.from}|${item.to}|${item.aircraftId}`);
    }
    nextToken = result.data?.listFlights?.nextToken ?? null;
  } while (nextToken);
  return keys;
}

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const lines = [];
    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => lines.push(line));
    rl.on("close", () => resolve(lines));
    rl.on("error", reject);
  });
}

// Splits a CSV row respecting quoted fields (ForeFlight uses "" for quotes inside quotes)
function splitRow(row) {
  const fields = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuote && row[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

// ── Approach parser ───────────────────────────────────────────────────────────
// ForeFlight format: "count;type;runway;airport;;"  e.g. "1;ILS OR LOC RWY 33;33;KGRK;;"

function parseApproaches(fields) {
  const approachCols = [
    "Approach1",
    "Approach2",
    "Approach3",
    "Approach4",
    "Approach5",
    "Approach6",
  ];
  const results = [];
  for (const col of approachCols) {
    const val = fields[col];
    if (!val) continue;
    const parts = val.split(";");
    const count = parseInt(parts[0]) || 0;
    const type = parts[1]?.trim() || "";
    const arpt = parts[3]?.trim() || "";
    if (count > 0 && type) results.push(`${type}@${arpt}`);
  }
  return {
    approaches: results.length,
    approachTypes: results.length > 0 ? results.join(", ") : null,
  };
}

// ── flightType inference ──────────────────────────────────────────────────────

function inferFlightType(f) {
  const comments = (
    (f.InstructorComments || "") +
    " " +
    (f.PilotComments || "")
  ).toLowerCase();
  if (f["Checkride (FAA)"] === "1" || comments.includes("checkride"))
    return "CHECKRIDE";
  if (parseFloat(f.Solo || "0") > 0) return "SOLO";
  if (parseFloat(f.CrossCountry || "0") > 0) return "CROSS_COUNTRY";
  if (comments.includes("discovery") || comments.includes("intro"))
    return "INTRO";
  if (parseFloat(f.DualReceived || "0") > 0) return "TRAINING";
  return "OTHER";
}

// ── conditions inference ──────────────────────────────────────────────────────

function inferConditions(f) {
  if (parseFloat(f.ActualInstrument || "0") > 0) return "IMC";
  if (parseFloat(f.IFR || "0") > 0) return "IFR";
  return "VFR";
}

// ── milestone inference ───────────────────────────────────────────────────────

function inferMilestone(f) {
  const comments = (
    (f.InstructorComments || "") +
    " " +
    (f.PilotComments || "")
  ).toLowerCase();
  if (f["Checkride (FAA)"] === "1") return "Checkride";
  if (f["IPC (FAA)"] === "1") return "IPC";
  if (f["Flight Review (FAA)"] === "1") return "Flight Review";
  if (comments.includes("first solo")) return "First Solo";
  if (comments.includes("solo") && f.Solo > 0) return null;
  return null;
}

// ── float / int helpers ───────────────────────────────────────────────────────

const f2 = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};
const i2 = (v) => {
  const n = parseInt(v);
  return isNaN(n) ? null : n;
};
const str = (v) => (v && v.trim() !== "" ? v.trim() : null);

// ── Row → flight record ───────────────────────────────────────────────────────

function rowToFlight(headers, values) {
  const f = {};
  headers.forEach((h, i) => {
    f[h] = values[i] ?? "";
  });

  // Skip ground-only entries (no From/To and zero total time)
  if (!str(f.From) && !str(f.To) && f2(f.TotalTime) === 0) return null;
  // Skip rows with no date
  if (!str(f.Date)) return null;

  const { approaches, approachTypes } = parseApproaches(f);

  // Combine all landings
  const dayLandings =
    (i2(f["Landing Full-Stop Day"]) ?? 0) +
    (i2(f["Landing Touch-and-Go Day"]) ?? 0);
  const nightLandings =
    (i2(f["Landing Full-Stop Night"]) ?? 0) +
    (i2(f["Landing Touch-and-Go Night"]) ?? 0);

  // Notes: prefer InstructorComments, fall back to PilotComments
  const notes = str(f.InstructorComments) ?? str(f.PilotComments) ?? null;

  return {
    date: f.Date,
    from: str(f.From) ?? "",
    to: str(f.To) ?? "",
    route: str(f.Route),
    aircraftId: str(f.AircraftID),
    aircraftType: null, // resolved from Aircraft Table after parsing

    totalTime: f2(f.TotalTime),
    pic: f2(f.PIC),
    sic: f2(f.SIC),
    solo: f2(f.Solo),
    night: f2(f.Night),
    actualIMC: f2(f.ActualInstrument),
    simulatedIMC: f2(f.SimulatedInstrument),
    crossCountry: f2(f.CrossCountry),
    dualReceived: f2(f.DualReceived),
    dualGiven: f2(f.DualGiven),

    dayLandings: dayLandings || null,
    nightLandings: nightLandings || null,
    approaches,
    approachTypes,

    flightType: inferFlightType(f),
    conditions: inferConditions(f),

    kmlS3Key: null,

    title: null,
    milestone: inferMilestone(f),
    notes,
    published: false,
  };
}

// ── GraphQL mutation ──────────────────────────────────────────────────────────

const CREATE_FLIGHT = `
  mutation CreateFlight($input: CreateFlightInput!) {
    createFlight(input: $input) {
      id
      date
      from
      to
      aircraftId
    }
  }
`;

// ── Main ──────────────────────────────────────────────────────────────────────

const jwt = await getJwt();
console.log("✓ Authenticated\n");

// Parse the CSV
const lines = await parseCSV(fileArg);

// Find the "Flights Table" section
const flightsStart = lines.findIndex((l) => l.startsWith("Flights Table"));
const aircraftStart = lines.findIndex((l) => l.startsWith("Aircraft Table"));

// Parse aircraft table for type lookup
const aircraftMap = {};
const aircraftHeaderLine = lines[aircraftStart + 1];
const aircraftHeaders = splitRow(aircraftHeaderLine);
for (let i = aircraftStart + 2; i < lines.length; i++) {
  const row = lines[i].trim();
  if (!row || row.startsWith("Flights Table")) break;
  const vals = splitRow(row);
  const rec = {};
  aircraftHeaders.forEach((h, idx) => {
    rec[h] = vals[idx] ?? "";
  });
  if (rec.AircraftID)
    aircraftMap[rec.AircraftID] = rec.TypeCode || rec.Model || null;
}

// Parse flight rows
const headerLine = lines[flightsStart + 1];
const headers = splitRow(headerLine);

const flights = [];
for (let i = flightsStart + 2; i < lines.length; i++) {
  const row = lines[i].trim();
  if (!row) continue;
  const vals = splitRow(row);
  const flight = rowToFlight(headers, vals);
  if (!flight) continue;
  // Resolve aircraft type from aircraft table
  flight.aircraftType = aircraftMap[flight.aircraftId] ?? null;
  flights.push(flight);
}

console.log(`Parsed ${flights.length} flight rows from CSV\n`);

// Fetch existing keys for dedup
console.log("Fetching existing flights from DB for dedup check...");
const existingKeys = await fetchExistingKeys(jwt);
console.log(`Found ${existingKeys.size} existing flights in DB\n`);

// Import
let created = 0,
  skipped = 0,
  errored = 0;

for (const flight of flights) {
  const key = `${flight.date}|${flight.from}|${flight.to}|${flight.aircraftId}`;

  if (existingKeys.has(key)) {
    console.log(
      `  SKIP  ${flight.date}  ${flight.from} → ${flight.to}  (already exists)`,
    );
    skipped++;
    continue;
  }

  if (dryRun) {
    console.log(
      `  DRY   ${flight.date}  ${flight.from} → ${flight.to}  ${flight.aircraftId ?? ""}  ${flight.totalTime}h  [${flight.flightType}]`,
    );
    created++;
    continue;
  }

  const result = await gql(jwt, CREATE_FLIGHT, { input: flight });

  if (result.errors) {
    console.error(
      `  ERR   ${flight.date}  ${flight.from} → ${flight.to}`,
      result.errors[0]?.message,
    );
    errored++;
  } else {
    console.log(
      `  OK    ${flight.date}  ${flight.from} → ${flight.to}  ${flight.aircraftId ?? ""}  ${flight.totalTime}h  [${flight.flightType}]`,
    );
    created++;
  }

  await delay(DELAY_MS);
}

console.log(`\n── Summary ──`);
console.log(`  ${dryRun ? "Would create" : "Created"} : ${created}`);
console.log(`  Skipped  : ${skipped}`);
if (!dryRun) console.log(`  Errored  : ${errored}`);
