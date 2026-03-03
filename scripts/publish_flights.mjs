/**
 * publish_flights.mjs
 * Publishes the N most recent flights (by date).
 *
 * Usage:
 *   node scripts/publish_flights.mjs --user=you@example.com --pass=yourpassword --count=5
 *   node scripts/publish_flights.mjs --user=you@example.com --pass=yourpassword --count=5 --dry-run
 */

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getConfig } from "./aws-config.mjs";
import { archiveChartsForFlight } from "./archive-charts.mjs";

const userArg  = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const passArg  = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];
const countArg = parseInt(process.argv.find((a) => a.startsWith("--count="))?.split("=")[1] ?? "5");
const dryRun   = process.argv.includes("--dry-run");

if (!userArg || !passArg) {
  console.error("Usage: node publish_flights.mjs --user=x --pass=y --count=5 [--dry-run]");
  process.exit(1);
}

const { region: REGION, clientId: CLIENT_ID, appsyncUrl: APPSYNC_URL } = getConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _outputs = JSON.parse(
  readFileSync(path.join(__dirname, "..", "amplify_outputs.json"), "utf8")
);
const API_KEY = _outputs?.data?.api_key ?? null;

async function getJwt() {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const res = await cognito.send(new InitiateAuthCommand({
    AuthFlow:       "USER_PASSWORD_AUTH",
    ClientId:       CLIENT_ID,
    AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
  }));
  if (!res.AuthenticationResult?.IdToken)
    throw new Error("Auth failed. Challenge: " + res.ChallengeName);
  return res.AuthenticationResult.IdToken;
}

async function gql(jwt, query, variables = {}) {
  const res = await fetch(APPSYNC_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: jwt },
    body:    JSON.stringify({ query, variables }),
  });
  return res.json();
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Main ──────────────────────────────────────────────────────────────────────

const jwt = await getJwt();
console.log("✓ Authenticated\n");

// Fetch all flights, paginating
const all = [];
let nextToken = null;
do {
  const result = await gql(jwt, `
    query List($nextToken: String) {
      listFlights(limit: 1000, nextToken: $nextToken) {
        items { id date from to totalTime published approachTypes approachChartKeys }
        nextToken
      }
    }
  `, { nextToken });
  all.push(...(result.data?.listFlights?.items ?? []));
  nextToken = result.data?.listFlights?.nextToken ?? null;
} while (nextToken);

console.log(`Fetched ${all.length} total flights\n`);

// Sort by date descending, take N most recent
const sorted  = all.sort((a, b) => b.date.localeCompare(a.date));
const toPublish = sorted.slice(0, countArg);

console.log(`Publishing ${toPublish.length} most recent flights${dryRun ? " (DRY RUN)" : ""}:\n`);

let updated = 0, skipped = 0, errored = 0;

for (const f of toPublish) {
  if (f.published) {
    console.log(`  SKIP   ${f.date}  ${f.from} → ${f.to}  (already published)`);
    skipped++;
    continue;
  }

  if (dryRun) {
    console.log(`  DRY    ${f.date}  ${f.from} → ${f.to}`);
    updated++;
    continue;
  }

  // Archive charts before publishing — ensures chart is captured while cycle is live
  const needsCharts = f.approachTypes &&
    (!f.approachChartKeys || f.approachChartKeys.length === 0);
  if (needsCharts && API_KEY) {
    console.log(`  [chart] Archiving charts for ${f.date} ${f.from}→${f.to}…`);
    await archiveChartsForFlight(
      jwt, f.id, f.approachTypes, APPSYNC_URL, API_KEY, { verbose: true },
    );
  }

  const result = await gql(jwt, `
    mutation Publish($input: UpdateFlightInput!) {
      updateFlight(input: $input) { id published }
    }
  `, { input: { id: f.id, published: true } });

  if (result.errors) {
    console.error(`  ERR    ${f.date}  ${f.from} → ${f.to}`, result.errors[0]?.message);
    errored++;
  } else {
    console.log(`  OK     ${f.date}  ${f.from} → ${f.to}`);
    updated++;
  }

  await delay(120);
}

console.log(`\n── Summary ──`);
console.log(`  ${dryRun ? "Would publish" : "Published"} : ${updated}`);
console.log(`  Skipped                    : ${skipped}`);
if (!dryRun) console.log(`  Errored                    : ${errored}`);
