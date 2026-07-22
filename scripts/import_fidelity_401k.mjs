/**
 * import_fidelity_401k.mjs
 *
 * One-off: import the Fidelity (META 401k) positions into financeHolding using
 * live SimpleFIN share counts, and register a MANUAL per-share price so the
 * holding values correctly despite the fund's opaque, non-market symbol (e.g.
 * "O5L8" = Vanguard Target 2060, which Yahoo can't quote).
 *
 * For each SimpleFIN holding on the Fidelity account (shares > 0):
 *   i.   upsert financeHolding  (quantity = SF shares; NO financeHoldingLot)
 *   ii.  cost basis left null (401k reports none → avoid a bogus 100% "gain")
 *   iii. price = SF market_value / shares
 *   iv.  upsert financeTickerQuote (source="manual") so the value survives the
 *        Yahoo refresh (refreshAllQuotes skips manual overrides)
 *
 * source=SIMPLEFIN on the holding so a future sf:pull keeps the share count
 * fresh as contributions land; the manual quote is never touched by sync.
 *
 *   node --env-file=.env.local scripts/import_fidelity_401k.mjs            # prod dry-run
 *   node --env-file=.env.local scripts/import_fidelity_401k.mjs --apply    # prod write
 *   node --env-file=.env.local scripts/import_fidelity_401k.mjs --env=sandbox
 *
 * Requires COGNITO_USER/PASSWORD + SIMPLEFIN_ACCESS_URL in .env.local.
 */
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";
import { fetchAccounts } from "./_simplefin.mjs";

const APPLY = process.argv.includes("--apply");
const cfg = getConfig();
const nowIso = new Date().toISOString();

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

async function main() {
  if (!process.env.SIMPLEFIN_ACCESS_URL) throw new Error("Missing SIMPLEFIN_ACCESS_URL");
  console.log(`Fidelity 401k import — ${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}\n`);
  JWT = await getJwt();

  // Find the Fidelity finance account (mapped RETIREMENT/BROKERAGE with a simplefinAccountId).
  const accts = [];
  let n = null;
  do {
    const d = await gql(`query($n:String){listFinanceAccounts(limit:500,nextToken:$n){items{id name type simplefinAccountId currentBalance} nextToken}}`, { n });
    accts.push(...d.listFinanceAccounts.items); n = d.listFinanceAccounts.nextToken;
  } while (n);
  const fidelity = accts.find((a) => /fidelity/i.test(a.name || "") && a.simplefinAccountId);
  if (!fidelity) throw new Error("No Fidelity account with a simplefinAccountId found.");
  console.log(`Target account: ${fidelity.name} (${fidelity.id})  type=${fidelity.type}  sf=${fidelity.simplefinAccountId}\n`);

  // Live SimpleFIN holdings for just that account.
  const { accounts } = await fetchAccounts(process.env.SIMPLEFIN_ACCESS_URL, {
    accountIds: [fidelity.simplefinAccountId],
    pending: true,
  });
  const sfAcc = accounts.find((a) => a.id === fidelity.simplefinAccountId);
  if (!sfAcc) throw new Error("SimpleFIN returned no matching account.");
  const positions = (sfAcc.holdings ?? []).filter((h) => (h.symbol ?? "").trim() && Math.abs(h.shares ?? 0) > 1e-9);
  if (positions.length === 0) { console.log("No priced-by-shares positions on the Fidelity account."); return; }

  // Existing rows to make this idempotent.
  const existingHoldings = [];
  n = null;
  do {
    const d = await gql(`query($a:ID!,$n:String){listFinanceHoldings(filter:{accountId:{eq:$a}},limit:500,nextToken:$n){items{id ticker quantity} nextToken}}`, { a: fidelity.id, n });
    existingHoldings.push(...d.listFinanceHoldings.items); n = d.listFinanceHoldings.nextToken;
  } while (n);
  const holdingByTicker = new Map(existingHoldings.map((h) => [(h.ticker ?? "").toUpperCase(), h]));

  const plan = [];
  for (const h of positions) {
    const ticker = h.symbol.trim().toUpperCase();
    const shares = h.shares;
    const mv = h.marketValue ?? 0;
    const price = shares !== 0 ? mv / shares : 0;
    const existQ = await gql(`query($t:String!){getFinanceTickerQuote(ticker:$t){ticker price source}}`, { t: ticker });
    plan.push({ ticker, shares, mv, price, holding: holdingByTicker.get(ticker) ?? null, quote: existQ.getFinanceTickerQuote ?? null, desc: h.description });
  }

  for (const p of plan) {
    console.log(`  ${p.ticker.padEnd(8)} ${(p.desc || "").slice(0, 26).padEnd(26)}  ${p.shares.toFixed(4).padStart(12)} sh  MV ${p.mv.toFixed(2).padStart(12)}  → price ${p.price.toFixed(4)}`);
    console.log(`     holding: ${p.holding ? `update ${p.holding.id} (qty ${p.holding.quantity} → ${p.shares})` : "create"}   quote: ${p.quote ? `update (${p.quote.source} ${p.quote.price} → manual ${p.price.toFixed(4)})` : "create manual"}`);
  }

  if (!APPLY) { console.log("\nDry-run complete. Re-run with --apply to write."); return; }

  console.log("\nWriting…");
  for (const p of plan) {
    // Holding — quantity from SF; cost basis null (unknown for 401k).
    if (p.holding) {
      await gql(`mutation($i:UpdateFinanceHoldingInput!){updateFinanceHolding(input:$i){id}}`, {
        i: { id: p.holding.id, quantity: p.shares, costBasisTotal: null, avgCostBasis: null, source: "SIMPLEFIN", marketValueReported: p.mv, updatedAt: nowIso },
      });
      console.log(`  ~ holding ${p.ticker} updated`);
    } else {
      await gql(`mutation($i:CreateFinanceHoldingInput!){createFinanceHolding(input:$i){id}}`, {
        i: { accountId: fidelity.id, ticker: p.ticker, quantity: p.shares, costBasisTotal: null, avgCostBasis: null, source: "SIMPLEFIN", marketValueReported: p.mv, updatedAt: nowIso },
      });
      console.log(`  + holding ${p.ticker} created`);
    }
    // Manual price override (PK = ticker).
    if (p.quote) {
      await gql(`mutation($i:UpdateFinanceTickerQuoteInput!){updateFinanceTickerQuote(input:$i){ticker}}`, {
        i: { ticker: p.ticker, price: p.price, currency: "USD", source: "manual", fetchedAt: nowIso },
      });
      console.log(`  ~ quote ${p.ticker} set to manual ${p.price.toFixed(4)}`);
    } else {
      await gql(`mutation($i:CreateFinanceTickerQuoteInput!){createFinanceTickerQuote(input:$i){ticker}}`, {
        i: { ticker: p.ticker, price: p.price, currency: "USD", source: "manual", fetchedAt: nowIso },
      });
      console.log(`  + quote ${p.ticker} created manual ${p.price.toFixed(4)}`);
    }
  }
  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
