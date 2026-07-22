/**
 * reclassify_sf_trades.mjs
 *
 * One-off cleanup of SimpleFIN-imported brokerage transactions that predate the
 * BUY/SELL classifier in sf:pull. Two safe fixes, applied ONLY to rows whose
 * notes start with "sf:" (SimpleFIN-sourced) on BROKERAGE/RETIREMENT accounts —
 * never the hand-entered / CSV trades:
 *
 *   1. Trades: if the row's description maps to a ticker (security_ticker_map),
 *      retype it BUY (amount < 0) / SELL (amount > 0), set the ticker, and set
 *      category "Investments". quantity/price stay null (SF gives neither).
 *   2. De-pollute income: any remaining sf: row still categorized "Income" is
 *      recategorized "Investments" — brokerage cash inflows aren't real income
 *      and were inflating the P&L.
 *
 *   node --env-file=.env.local scripts/reclassify_sf_trades.mjs            # prod dry-run
 *   node --env-file=.env.local scripts/reclassify_sf_trades.mjs --apply
 *   node --env-file=.env.local scripts/reclassify_sf_trades.mjs --env=sandbox
 */
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";
import { loadTickerRules, resolveTicker } from "./_trade_classify.mjs";

const APPLY = process.argv.includes("--apply");
const cfg = getConfig();
const RULES = loadTickerRules();

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
    method: "POST", headers: { "Content-Type": "application/json", Authorization: JWT },
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

const UPDATE_TX = `mutation($i:UpdateFinanceTransactionInput!){updateFinanceTransaction(input:$i){id}}`;

async function main() {
  console.log(`Reclassify SF trades — ${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}\n`);
  JWT = await getJwt();

  const accts = await pageAll(`query($next:String){listFinanceAccounts(limit:500,nextToken:$next){items{id name type} nextToken}}`, "listFinanceAccounts");
  const invested = new Map(accts.filter((a) => ["BROKERAGE", "RETIREMENT"].includes(a.type)).map((a) => [a.id, a.name]));

  const plan = [];        // trades → BUY/SELL
  const depollute = [];   // Income → Investments
  for (const accountId of invested.keys()) {
    const txs = await pageAll(
      `query($a:ID!,$next:String){listFinanceTransactions(filter:{accountId:{eq:$a}},limit:1000,nextToken:$next){items{id date amount type category description ticker notes} nextToken}}`,
      "listFinanceTransactions", { a: accountId });
    for (const t of txs) {
      if (!(t.notes || "").startsWith("sf:")) continue;      // SF-sourced only
      const ticker = resolveTicker([t.description], RULES);
      if (ticker && (t.type === "INCOME" || t.type === "EXPENSE")) {
        const side = t.amount < 0 ? "BUY" : "SELL";
        plan.push({ accName: invested.get(accountId), t, side, ticker });
      } else if (t.category === "Income") {
        depollute.push({ accName: invested.get(accountId), t });
      }
    }
  }

  console.log(`Trades to retype (BUY/SELL): ${plan.length}`);
  for (const p of plan) {
    console.log(`  ${p.accName.slice(0,16).padEnd(16)} ${p.t.date}  ${(p.t.type+"→"+p.side).padEnd(12)} ${p.ticker.padEnd(6)} ${String(p.t.amount).padStart(10)}  ${(p.t.description||"").slice(0,32)}`);
  }
  console.log(`\nIncome→Investments (de-pollute): ${depollute.length}`);
  for (const d of depollute) {
    console.log(`  ${d.accName.slice(0,16).padEnd(16)} ${d.t.date}  ${String(d.t.amount).padStart(10)}  ${(d.t.description||"").slice(0,32)}`);
  }

  if (!APPLY) { console.log("\nDry-run complete. Re-run with --apply to write."); return; }

  let ok = 0, fail = 0;
  console.log("\nWriting…");
  for (const p of plan) {
    try { await gql(UPDATE_TX, { i: { id: p.t.id, type: p.side, ticker: p.ticker, category: "Investments" } }); ok++; }
    catch (e) { console.error(`  ✗ ${p.t.id}: ${e.message}`); fail++; }
  }
  for (const d of depollute) {
    try { await gql(UPDATE_TX, { i: { id: d.t.id, category: "Investments" } }); ok++; }
    catch (e) { console.error(`  ✗ ${d.t.id}: ${e.message}`); fail++; }
  }
  console.log(`\nDone. Updated ${ok}, failed ${fail}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
