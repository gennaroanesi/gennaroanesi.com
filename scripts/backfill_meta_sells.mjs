/**
 * backfill_meta_sells.mjs
 *
 * Surgical backfill of META RSU-sale proceeds that are missing from the ledger
 * (the DB's brokerage history only starts 2026-05-13; Jan/Feb and most of late
 * May are absent). Adds ONLY the missing SELL rows so RSU income is complete for
 * the funding analysis.
 *
 * Deliberately narrow:
 *   - Adds the missing META SELL transactions only. Not the buys, transfers,
 *     dividends or the vest lots — those don't affect RSU income, and importing
 *     them wholesale would duplicate the existing May trades (entered with a
 *     different split) and disturb the account balance.
 *   - Does NOT create a vest holding lot: the Feb-vest shares were sold, so a
 *     standing lot would be phantom holdings. The vest is represented by its
 *     sales.
 *   - Does NOT touch currentBalance. These are historical inflows already
 *     reflected in today's balance; re-adjusting would double-count.
 *   - consumedCostBasis = proceeds, so realized gain ≈ $0 (RSU sold at/near
 *     vest). Category "Investments" keeps them out of the consumption P&L.
 *
 * Dedup: skips any date that already has a META sell in the DB (05/13, 05/18),
 * and skips any row whose importHash already exists.
 *
 *   node --env-file=.env.local scripts/backfill_meta_sells.mjs           # dry-run
 *   node --env-file=.env.local scripts/backfill_meta_sells.mjs --apply
 */
import { readFileSync } from "fs";
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";

const APPLY = process.argv.includes("--apply");
const o = JSON.parse(readFileSync("./amplify_outputs.json", "utf8"));

// Missing META sells from the Schwab Individual_...956 export (date MM/DD, qty,
// price, fees, proceeds). 05/13 + 05/18 are already in the DB and omitted here.
const SELLS = [
  ["01/30/2026", 20, 718.235, 0,    14364.70],
  ["02/02/2026", 18, 710.00,  0,    12780.00],
  ["02/02/2026", 18, 709.20,  0,    12765.60],
  ["02/18/2026", 30, 640.00,  0.01, 19199.99],
  ["02/25/2026", 30, 648.025, 0.01, 19440.74],
  ["05/20/2026", 15, 605.00,  0.19,  9074.81],
  ["05/22/2026", 26, 610.00,  0.34, 15859.66],
  ["05/22/2026", 15, 608.00,  0.19,  9119.81],
  ["05/26/2026", 10, 611.00,  0.13,  6109.87],
  ["05/27/2026", 10, 636.35,  0.13,  6363.37],
];
const iso = (mmddyyyy) => { const [m, d, y] = mmddyyyy.split("/"); return `${y}-${m}-${d}`; };
const money = (x) => "$" + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function importHash(date, amount, description) {
  const raw = [date, Number(amount).toFixed(2), (description ?? "").trim().toLowerCase()].join("|");
  return Buffer.from(raw, "utf8").toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}

let JWT;
async function getJwt() {
  const c = new CognitoIdentityProviderClient({ region: o.auth.aws_region });
  const r = await c.send(new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH", ClientId: o.auth.user_pool_client_id,
    AuthParameters: { USERNAME: process.env.COGNITO_USER, PASSWORD: process.env.COGNITO_PASSWORD },
  }));
  if (!r.AuthenticationResult?.IdToken) throw new Error("Auth failed: " + r.ChallengeName);
  return r.AuthenticationResult.IdToken;
}
async function gql(query, variables = {}) {
  const r = await fetch(o.data.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: JWT }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
}
async function pageAll(query, key, vars = {}) { const out = []; let n = null; do { const d = await gql(query, { ...vars, next: n }); out.push(...d[key].items); n = d[key].nextToken; } while (n); return out; }

async function main() {
  console.log(`META sell backfill — ${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}\n`);
  JWT = await getJwt();

  const accts = await pageAll(`query($next:String){listFinanceAccounts(limit:500,nextToken:$next){items{id name type} nextToken}}`, "listFinanceAccounts");
  const schwab = accts.find((a) => /schwab brok/i.test(a.name || ""));
  if (!schwab) throw new Error("Schwab Brokerage account not found");
  console.log(`Target account: ${schwab.name} (${schwab.id})\n`);

  const existing = await pageAll(
    `query($next:String){listFinanceTransactions(filter:{date:{ge:"2026-01-01"}},limit:1000,nextToken:$next){items{amount type ticker description date importHash} nextToken}}`,
    "listFinanceTransactions");
  const metaSellDates = new Set(existing.filter((t) => t.type === "SELL" && /meta/i.test(t.ticker || t.description || "")).map((t) => t.date));
  const hashes = new Set(existing.map((t) => t.importHash).filter(Boolean));
  console.log(`DB already has META sells on: ${[...metaSellDates].sort().join(", ") || "(none)"}\n`);

  const drafts = [];
  const skipped = [];
  for (const [mmdd, qty, price, fees, amount] of SELLS) {
    const date = iso(mmdd);
    const description = `Sell ${qty} META`;
    const hash = importHash(date, amount, description);
    if (metaSellDates.has(date)) { skipped.push({ date, amount, reason: "date already has a META sell" }); continue; }
    if (hashes.has(hash)) { skipped.push({ date, amount, reason: "importHash exists" }); continue; }
    drafts.push({
      accountId: schwab.id,
      amount,                       // positive = cash in
      type: "SELL",
      category: "Investments",
      description,
      date,
      status: "POSTED",
      ticker: "META",
      quantity: qty,
      price,
      fees: fees > 0 ? fees : null,
      consumedCostBasis: amount,    // sold at/near vest → realized gain ≈ $0
      lotId: null,
      lotConsumptions: null,
      importHash: hash,
      notes: "schwab-backfill",
    });
  }

  console.log(`To add: ${drafts.length} sells, ${money(drafts.reduce((s, d) => s + d.amount, 0))}`);
  for (const d of drafts) console.log(`  ${d.date}  ${String(d.quantity).padStart(3)} sh  ${money(d.amount).padStart(12)}`);
  if (skipped.length) { console.log(`\nSkipped ${skipped.length}:`); for (const s of skipped) console.log(`  ${s.date}  ${money(s.amount).padStart(12)}  (${s.reason})`); }

  const rsuBefore = existing.filter((t) => t.type === "SELL" && /meta/i.test(t.ticker || t.description || "")).reduce((s, t) => s + (t.amount || 0), 0);
  console.log(`\nRSU (META sells) income:  before ${money(rsuBefore)}  →  after ${money(rsuBefore + drafts.reduce((s, d) => s + d.amount, 0))}`);
  console.log(`Balance: NOT adjusted (historical inflows already reflected in current balance).`);

  if (!APPLY) { console.log(`\nDry-run. Re-run with --apply to write.`); return; }

  console.log(`\nWriting…`);
  let ok = 0, fail = 0;
  for (const d of drafts) {
    try { await gql(`mutation($i:CreateFinanceTransactionInput!){createFinanceTransaction(input:$i){id}}`, { i: d }); ok++; }
    catch (e) { console.error(`  ✗ ${d.date}: ${e.message}`); fail++; }
    await new Promise((r) => setTimeout(r, 90));
  }
  console.log(`\nDone: ${ok} added, ${fail} failed. Balance untouched.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
