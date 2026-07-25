/**
 * backup_holding_lots.mjs
 *
 * Read-only snapshot of every financeHoldingLot in an env → a timestamped JSON
 * file. Run before schema/data changes that could conceivably touch lots so we
 * can restore. Defaults to prod (aws-config.mjs).
 *
 *   node --env-file=.env.local scripts/backup_holding_lots.mjs            # prod
 *   node --env-file=.env.local scripts/backup_holding_lots.mjs --env=sandbox
 *
 * Requires COGNITO_USER + COGNITO_PASSWORD in .env.local (financeHoldingLot is
 * admin-only, so this authenticates against the env's Cognito pool for a JWT).
 */
import { writeFileSync, mkdirSync } from "fs";
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";

const cfg = getConfig();

async function getJwt() {
  const c = new CognitoIdentityProviderClient({ region: cfg.region });
  const r = await c.send(new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: cfg.clientId,
    AuthParameters: { USERNAME: process.env.COGNITO_USER, PASSWORD: process.env.COGNITO_PASSWORD },
  }));
  if (!r.AuthenticationResult?.IdToken) throw new Error("Auth failed: " + r.ChallengeName);
  return r.AuthenticationResult.IdToken;
}

async function main() {
  if (!process.env.COGNITO_USER || !process.env.COGNITO_PASSWORD) {
    console.error("Missing COGNITO_USER / COGNITO_PASSWORD in .env.local");
    process.exit(1);
  }
  const jwt = await getJwt();

  const query = `
    query($next: String) {
      listFinanceHoldingLots(limit: 1000, nextToken: $next) {
        items {
          id accountId ticker assetType quantity costBasis purchaseDate
          notes isVested vestDate createdAt updatedAt
        }
        nextToken
      }
    }`;

  const lots = [];
  let next = null;
  do {
    const r = await fetch(cfg.appsyncUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: jwt },
      body: JSON.stringify({ query, variables: { next } }),
    });
    const j = await r.json();
    if (j.errors?.length) throw new Error(j.errors[0].message);
    lots.push(...j.data.listFinanceHoldingLots.items);
    next = j.data.listFinanceHoldingLots.nextToken;
  } while (next);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = "scripts/data/backups";
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/holding_lots_${cfg.env}_${stamp}.json`;
  writeFileSync(path, JSON.stringify({ env: cfg.env, capturedAt: new Date().toISOString(), count: lots.length, lots }, null, 2));

  const byAccount = {};
  for (const l of lots) byAccount[l.accountId] = (byAccount[l.accountId] ?? 0) + 1;
  console.log(`Backed up ${lots.length} holding lot(s) from ${cfg.env} → ${path}`);
  console.log(`Accounts: ${Object.keys(byAccount).length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
