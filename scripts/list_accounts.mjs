/**
 * list_accounts.mjs
 * Lists all financeAccount records with their IDs, names, types, and balances.
 * Handy for grabbing an account ID to pass to other scripts.
 *
 * Usage:
 *   node list_accounts.mjs --env=sandbox|prod --user=you@example.com --pass=yourpassword
 */

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";

// ── Args ──────────────────────────────────────────────────────────────────────

const userArg = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const passArg = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];

if (!userArg || !passArg) {
  console.error(
    "Usage: node list_accounts.mjs --env=sandbox|prod --user=you@example.com --pass=yourpassword",
  );
  process.exit(1);
}

const { region: REGION, clientId: CLIENT_ID, appsyncUrl: APPSYNC_URL } = getConfig();

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
    throw new Error(
      "Auth failed — check username/password. Challenge: " + res.ChallengeName,
    );
  return res.AuthenticationResult.IdToken;
}

let JWT;

async function gql(query, variables = {}) {
  const res = await fetch(APPSYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: JWT },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

// ── GraphQL ───────────────────────────────────────────────────────────────────

const LIST_ACCOUNTS = `
  query ListAccounts($nextToken: String) {
    listFinanceAccounts(limit: 200, nextToken: $nextToken) {
      items {
        id
        name
        type
        currentBalance
        currency
        active
      }
      nextToken
    }
  }`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  JWT = await getJwt();

  const records = [];
  let nextToken = null;
  do {
    const data = await gql(LIST_ACCOUNTS, nextToken ? { nextToken } : {});
    records.push(...data.listFinanceAccounts.items);
    nextToken = data.listFinanceAccounts.nextToken;
  } while (nextToken);

  if (records.length === 0) {
    console.log("No accounts found.");
    return;
  }

  // Sort: active first, then by type, then by name
  records.sort((a, b) => {
    if ((a.active ?? true) !== (b.active ?? true)) return (a.active ?? true) ? -1 : 1;
    if ((a.type ?? "") !== (b.type ?? "")) return (a.type ?? "").localeCompare(b.type ?? "");
    return (a.name ?? "").localeCompare(b.name ?? "");
  });

  // Column widths
  const idW   = Math.max(2, ...records.map((r) => (r.id ?? "").length));
  const nameW = Math.max(4, ...records.map((r) => (r.name ?? "").length));
  const typeW = Math.max(4, ...records.map((r) => (r.type ?? "").length));

  const header =
    "ID".padEnd(idW) + "  " +
    "NAME".padEnd(nameW) + "  " +
    "TYPE".padEnd(typeW) + "  " +
    "BALANCE".padStart(14) + "  " +
    "ACTIVE";
  console.log(header);
  console.log("-".repeat(header.length));

  for (const r of records) {
    const bal = (r.currentBalance ?? 0).toFixed(2);
    const cur = r.currency ?? "USD";
    const balStr = `${bal} ${cur}`.padStart(14);
    console.log(
      (r.id ?? "").padEnd(idW) + "  " +
      (r.name ?? "").padEnd(nameW) + "  " +
      (r.type ?? "").padEnd(typeW) + "  " +
      balStr + "  " +
      ((r.active ?? true) ? "yes" : "no"),
    );
  }
  console.log(`\n${records.length} account(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
