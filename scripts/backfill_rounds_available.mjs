/**
 * backfill_rounds_available.mjs
 * Sets roundsAvailable = quantity * roundsPerUnit on any ammo record
 * where roundsAvailable is currently null/unset.
 *
 * Usage:
 *   node backfill_rounds_available.mjs --env=sandbox --user=you@example.com --pass=yourpassword [--dry-run]
 *   node backfill_rounds_available.mjs --env=prod    --user=you@example.com --pass=yourpassword [--dry-run]
 */

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";

// ── Config ────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const userArg = process.argv
  .find((a) => a.startsWith("--user="))
  ?.split("=")[1];
const passArg = process.argv
  .find((a) => a.startsWith("--pass="))
  ?.split("=")[1];
const DELAY_MS = 120;

if (!userArg || !passArg) {
  console.error(
    "Usage: node backfill_rounds_available.mjs --env=sandbox|prod --user=you@example.com --pass=yourpassword [--dry-run]",
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

// ── GraphQL ───────────────────────────────────────────────────────────────────

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

const LIST_AMMO = `
  query ListAmmo($nextToken: String) {
    listinventoryAmmos(limit: 500, nextToken: $nextToken) {
      items {
        id
        caliber
        quantity
        roundsPerUnit
        roundsAvailable
      }
      nextToken
    }
  }`;

const UPDATE_AMMO = `
  mutation UpdateAmmo($input: UpdateinventoryAmmoInput!) {
    updateinventoryAmmo(input: $input) { id roundsAvailable }
  }`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function listAllAmmo() {
  const records = [];
  let nextToken = null;
  do {
    const data = await gql(LIST_AMMO, nextToken ? { nextToken } : {});
    records.push(...data.listinventoryAmmos.items);
    nextToken = data.listinventoryAmmos.nextToken;
  } while (nextToken);
  return records;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Ammo roundsAvailable backfill${DRY_RUN ? " (DRY RUN)" : ""}`);

  process.stdout.write(`Authenticating as ${userArg}… `);
  JWT = await getJwt();
  console.log("✓");

  process.stdout.write("Fetching all ammo records… ");
  const records = await listAllAmmo();
  console.log(`${records.length} records found`);

  const toUpdate = records.filter((r) => r.roundsAvailable == null);
  console.log(
    `${toUpdate.length} records need backfill (roundsAvailable is null)\n`,
  );

  if (toUpdate.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  let updated = 0,
    skipped = 0,
    errors = 0;

  for (const r of toUpdate) {
    const total = (r.quantity ?? 0) * (r.roundsPerUnit ?? 1);

    if (total === 0) {
      console.log(
        `  SKIP  ${r.caliber ?? "unknown"} (id: ${r.id}) — quantity or roundsPerUnit is 0, can't compute total`,
      );
      skipped++;
      continue;
    }

    console.log(
      `  ${DRY_RUN ? "DRY " : ""}UPDATE  ${r.caliber ?? "unknown"} — qty ${r.quantity} × ${r.roundsPerUnit ?? 1} rpu = ${total} rounds  (id: ${r.id})`,
    );

    if (!DRY_RUN) {
      try {
        await gql(UPDATE_AMMO, { input: { id: r.id, roundsAvailable: total } });
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

  console.log(
    `\n─────────────────────────────────────────────────────────────────`,
  );
  console.log(
    `  Updated: ${updated}  |  Skipped: ${skipped}  |  Errors: ${errors}`,
  );
  if (DRY_RUN) console.log("  (Dry run — nothing was written to the database)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
