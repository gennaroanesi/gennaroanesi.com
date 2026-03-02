/**
 * list_airports.mjs
 * Lists all unique from/to airports in your logbook with flight counts.
 * Helps identify which airports need coordinates added to the flying page.
 *
 * Usage:
 *   node scripts/list_airports.mjs --user=you@example.com --pass=yourpassword
 */

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";

const userArg = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const passArg = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];

if (!userArg || !passArg) {
  console.error("Usage: node list_airports.mjs --user=x --pass=y [--env=prod]");
  process.exit(1);
}

const { region: REGION, clientId: CLIENT_ID, appsyncUrl: APPSYNC_URL } = getConfig();

async function getJwt() {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const res = await cognito.send(new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH", ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
  }));
  if (!res.AuthenticationResult?.IdToken)
    throw new Error("Auth failed: " + res.ChallengeName);
  return res.AuthenticationResult.IdToken;
}

async function gql(jwt, query, variables = {}) {
  const res = await fetch(APPSYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: jwt },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

const jwt = await getJwt();
console.log("✓ Authenticated\n");

const all = [];
let nextToken = null;
do {
  const result = await gql(jwt, `
    query List($nextToken: String) {
      listFlights(limit: 1000, nextToken: $nextToken) {
        items { from to }
        nextToken
      }
    }
  `, { nextToken });
  all.push(...(result.data?.listFlights?.items ?? []));
  nextToken = result.data?.listFlights?.nextToken ?? null;
} while (nextToken);

// Count appearances
const counts = {};
for (const f of all) {
  for (const apt of [f.from, f.to]) {
    if (apt) counts[apt] = (counts[apt] ?? 0) + 1;
  }
}

// Sort by frequency
const sorted = Object.entries(counts).sort(([, a], [, b]) => b - a);

console.log(`── ${sorted.length} unique airports ──\n`);
for (const [apt, count] of sorted) {
  console.log(`  ${apt.padEnd(6)}  ${count} flights`);
}
