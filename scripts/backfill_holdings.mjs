/**
 * backfill_holdings.mjs
 *
 * One-time seed of the new `financeHolding` model (current vested positions)
 * from the existing `financeHoldingLot` rows. After this runs, financeHolding is
 * the source of truth for value + unrealized gains; lots become optional tax-lot
 * detail. Going forward, SimpleFIN pulls (sf:pull) keep SF-mapped accounts' holdings
 * fresh and manual trades write them directly — this script is not re-run in the
 * normal flow.
 *
 * For each BROKERAGE/RETIREMENT account, aggregates its VESTED lots per ticker:
 *   quantity       = Σ vested lot.quantity
 *   costBasisTotal = Σ vested lot.costBasis   (null if any vested lot lacks one)
 *   avgCostBasis   = costBasisTotal / quantity (when known)
 *   assetType      = first vested lot's assetType
 *   source         = SIMPLEFIN if the account has a simplefinAccountId (so the
 *                    next sf:pull owns/refreshes it), else MANUAL
 *
 * Unvested RSU lots (isVested === false) are intentionally excluded — they carry
 * no current value and stay in the lot model for the forward projection.
 *
 * Idempotent: skips any (account, ticker) that already has a financeHolding row,
 * so re-running never clobbers SF-synced or manually-edited data.
 *
 *   node --env-file=.env.local scripts/backfill_holdings.mjs            # prod dry-run
 *   node --env-file=.env.local scripts/backfill_holdings.mjs --apply    # prod write
 *   node --env-file=.env.local scripts/backfill_holdings.mjs --env=sandbox
 *
 * Requires COGNITO_USER + COGNITO_PASSWORD in .env.local (finance* is admin-only).
 * Targets prod by default via aws-config.mjs; pass --env=sandbox to switch.
 */
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";

const APPLY = process.argv.includes("--apply");
const cfg = getConfig();

const isVested = (l) => l.isVested !== false; // mirrors isLotVested in finance-core

let JWT;
async function getJwt() {
  const c = new CognitoIdentityProviderClient({ region: cfg.region });
  const r = await c.send(new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH", ClientId: cfg.clientId,
    AuthParameters: { USERNAME: process.env.COGNITO_USER, PASSWORD: process.env.COGNITO_PASSWORD },
  }));
  if (!r.AuthenticationResult?.IdToken) throw new Error("Auth failed: " + r.ChallengeName);
  return r.AuthenticationResult.IdToken;
}
async function gql(query, variables = {}) {
  const r = await fetch(cfg.appsyncUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: JWT },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
}
async function pageAll(query, key, vars = {}) {
  const out = []; let n = null;
  do { const d = await gql(query, { ...vars, next: n }); out.push(...d[key].items); n = d[key].nextToken; } while (n);
  return out;
}

const CREATE_HOLDING = `
  mutation CreateHolding($input: CreateFinanceHoldingInput!) {
    createFinanceHolding(input: $input) { id }
  }`;

async function main() {
  console.log(`Holdings backfill — ${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}\n`);
  JWT = await getJwt();

  const accounts = await pageAll(
    `query($next:String){listFinanceAccounts(limit:500,nextToken:$next){items{id name type simplefinAccountId} nextToken}}`,
    "listFinanceAccounts");
  const lots = await pageAll(
    `query($next:String){listFinanceHoldingLots(limit:1000,nextToken:$next){items{id accountId ticker assetType quantity costBasis isVested} nextToken}}`,
    "listFinanceHoldingLots");
  const existing = await pageAll(
    `query($next:String){listFinanceHoldings(limit:1000,nextToken:$next){items{id accountId ticker} nextToken}}`,
    "listFinanceHoldings");

  const invested = new Set(accounts.filter((a) => a.type === "BROKERAGE" || a.type === "RETIREMENT").map((a) => a.id));
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const existingKey = new Set(existing.map((h) => `${h.accountId}|${(h.ticker ?? "").toUpperCase()}`));

  // Aggregate vested lots per (accountId, ticker).
  const agg = new Map(); // key → { accountId, ticker, quantity, costBasis, hasCost, assetType }
  for (const l of lots) {
    if (!invested.has(l.accountId)) continue;
    if (!isVested(l)) continue;
    const ticker = (l.ticker ?? "").trim().toUpperCase();
    if (!ticker) continue;
    const key = `${l.accountId}|${ticker}`;
    const a = agg.get(key) ?? { accountId: l.accountId, ticker, quantity: 0, costBasis: 0, hasCost: true, assetType: null };
    a.quantity += l.quantity ?? 0;
    if (l.costBasis == null) a.hasCost = false;
    else a.costBasis += l.costBasis;
    if (!a.assetType && l.assetType) a.assetType = l.assetType;
    agg.set(key, a);
  }

  const now = new Date().toISOString();
  const toCreate = [];
  let skippedExisting = 0;
  let skippedZero = 0;
  for (const a of agg.values()) {
    if (existingKey.has(`${a.accountId}|${a.ticker}`)) { skippedExisting++; continue; }
    if (Math.abs(a.quantity) < 1e-9) { skippedZero++; continue; }
    const acct = acctById.get(a.accountId);
    const source = acct?.simplefinAccountId ? "SIMPLEFIN" : "MANUAL";
    const costBasisTotal = a.hasCost ? a.costBasis : null;
    const avgCostBasis = a.hasCost && Math.abs(a.quantity) > 1e-9 ? a.costBasis / a.quantity : null;
    toCreate.push({
      input: {
        accountId:      a.accountId,
        ticker:         a.ticker,
        assetType:      a.assetType ?? null,
        quantity:       a.quantity,
        costBasisTotal,
        avgCostBasis,
        source,
        updatedAt:      now,
      },
      acctName: acct?.name ?? a.accountId,
    });
  }

  console.log(`Invested accounts: ${invested.size}`);
  console.log(`Vested (account,ticker) positions found: ${agg.size}`);
  console.log(`  skipped — already have a holding: ${skippedExisting}`);
  console.log(`  skipped — net-zero quantity:       ${skippedZero}`);
  console.log(`  to create:                          ${toCreate.length}\n`);

  for (const c of toCreate) {
    const i = c.input;
    console.log(
      `  + ${c.acctName.slice(0, 28).padEnd(28)}  ${i.ticker.padEnd(8)}  ` +
      `${String(i.quantity.toFixed(4)).padStart(12)} sh  ` +
      `cost ${i.costBasisTotal != null ? i.costBasisTotal.toFixed(2) : "—"}  ` +
      `[${i.source}]`,
    );
  }

  if (!APPLY) {
    console.log("\nDry-run complete. Re-run with --apply to write.");
    return;
  }

  let ok = 0, fail = 0;
  console.log("\nWriting holdings…");
  for (const c of toCreate) {
    try { await gql(CREATE_HOLDING, { input: c.input }); ok++; }
    catch (e) { console.error(`  ✗ ${c.acctName} ${c.input.ticker}: ${e.message}`); fail++; }
  }
  console.log(`\nDone. Holdings created: ${ok}, failed: ${fail}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
