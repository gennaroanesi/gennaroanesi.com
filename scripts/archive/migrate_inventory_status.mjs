/**
 * migrate_inventory_status.mjs
 * One-shot backfill: sets `status` on every inventoryItem record.
 *   active === false  →  status = "SOLD"
 *   active !== false  →  status = "OWNED"
 *
 * Idempotent — skips records that already have a status set.
 *
 * Usage:
 *   node migrate_inventory_status.mjs --env=sandbox --user=you@example.com --pass=yourpassword [--dry-run]
 *   node migrate_inventory_status.mjs --env=prod    --user=you@example.com --pass=yourpassword [--dry-run]
 */

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const userArg = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const passArg = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];
const DELAY_MS = 120;

if (!userArg || !passArg) {
  console.error(
    "Usage: node migrate_inventory_status.mjs --env=sandbox|prod --user=you@example.com --pass=yourpassword [--dry-run]",
  );
  process.exit(1);
}

const { region: REGION, clientId: CLIENT_ID, appsyncUrl: APPSYNC_URL } = getConfig();

async function getJwt() {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const res = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
    }),
  );
  if (!res.AuthenticationResult?.IdToken) {
    throw new Error(
      "Auth failed — check username/password. Challenge: " + res.ChallengeName,
    );
  }
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

const LIST_ITEMS = `
  query ListItems($nextToken: String) {
    listinventoryItems(limit: 500, nextToken: $nextToken) {
      items {
        id
        name
        active
        status
      }
      nextToken
    }
  }`;

const UPDATE_ITEM = `
  mutation UpdateItem($input: UpdateinventoryItemInput!) {
    updateinventoryItem(input: $input) { id status }
  }`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function listAllItems() {
  const records = [];
  let nextToken = null;
  do {
    const data = await gql(LIST_ITEMS, nextToken ? { nextToken } : {});
    records.push(...data.listinventoryItems.items);
    nextToken = data.listinventoryItems.nextToken;
  } while (nextToken);
  return records;
}

async function main() {
  console.log(`inventoryItem status backfill${DRY_RUN ? " (DRY RUN)" : ""}`);

  process.stdout.write(`Authenticating as ${userArg}… `);
  JWT = await getJwt();
  console.log("✓");

  process.stdout.write("Fetching all inventoryItem records… ");
  const records = await listAllItems();
  console.log(`${records.length} records found`);

  const toUpdate = records.filter((r) => r.status == null);
  console.log(`${toUpdate.length} records need backfill (status is null)\n`);

  if (toUpdate.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  let updated = 0, errors = 0;

  for (const r of toUpdate) {
    const newStatus = r.active === false ? "SOLD" : "OWNED";
    console.log(`  ${DRY_RUN ? "DRY " : ""}UPDATE  ${r.name ?? "(no name)"} — active=${r.active} → status=${newStatus}  (id: ${r.id})`);

    if (!DRY_RUN) {
      try {
        await gql(UPDATE_ITEM, { input: { id: r.id, status: newStatus } });
        updated++;
      } catch (e) {
        console.error(`  ✗ Error updating ${r.id}: ${e.message}`);
        errors++;
      }
      await sleep(DELAY_MS);
    } else {
      updated++;
    }
  }

  console.log(`\n─────────────────────────────────────────────────────────────────`);
  console.log(`  Updated: ${updated}  |  Errors: ${errors}`);
  if (DRY_RUN) console.log("  (Dry run — nothing was written to the database)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
