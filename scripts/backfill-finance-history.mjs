/**
 * backfill-finance-history.mjs
 *
 * Seeds historical financeHoldingSnapshot (and optionally financeGoalSnapshot)
 * rows so the Review page's period gains, top movers, and goal-evolution charts
 * are populated immediately instead of only going forward.
 *
 * WHY this exists: the daily financeSnapshots Lambda only knows *current* quotes,
 * so it can't write accurate historical market values. This script sources
 * historical daily closes from Yahoo Finance and reconstructs each position's
 * quantity as of each date by undoing trades that happened after that date.
 *
 * HOLDING SNAPSHOTS (always):
 *   qty(account, ticker, date) = currentQty
 *                                − Σ BUY.qty (trades after date)
 *                                + Σ SELL.qty (trades after date)
 *   marketValue = qty × close(ticker, date)
 *   Caveat: positions added WITHOUT a BUY transaction (e.g. manually-entered RSU
 *   lots) are treated as present for the whole range. costBasis is left null for
 *   backfilled rows (we don't fabricate historical basis).
 *
 * GOAL SNAPSHOTS (--goals): requires historical financeAccountSnapshot balances
 *   to already exist for the range (run the financeSnapshots Lambda with
 *   {fromDate,toDate,backfillMode:"reconstructed"} first). Goal currentAmount per
 *   date = computeGoalAllocations over (snapshot cash balance + reconstructed
 *   holding market values), same algorithm as the app. Dates lacking an account
 *   snapshot are skipped with a warning.
 *
 * Usage:
 *   node backfill-finance-history.mjs \
 *     --env=sandbox|prod \
 *     --user=you@example.com --pass=yourpassword \
 *     --from=2026-01-01 --to=2026-06-01 \
 *     [--goals] [--dry-run]
 *
 * Idempotent: upserts by (accountId,ticker,date) / (goalId,date).
 */

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";

// ── Args ──────────────────────────────────────────────────────────────────────

const DRY_RUN  = process.argv.includes("--dry-run");
const DO_GOALS = process.argv.includes("--goals");
const userArg  = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const passArg  = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];
const fromArg  = process.argv.find((a) => a.startsWith("--from="))?.split("=")[1];
const toArg    = process.argv.find((a) => a.startsWith("--to="))?.split("=")[1];
const DELAY_MS = 80;

if (!userArg || !passArg || !fromArg || !toArg) {
  console.error("Usage: node backfill-finance-history.mjs --env=… --user=… --pass=… --from=YYYY-MM-DD --to=YYYY-MM-DD [--goals] [--dry-run]");
  process.exit(1);
}
if (fromArg > toArg) { console.error("--from must be <= --to"); process.exit(1); }

const { region: REGION, clientId: CLIENT_ID, appsyncUrl: APPSYNC_URL } = getConfig();

// ── Date helpers ────────────────────────────────────────────────────────────

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function enumerateDates(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Auth + GraphQL ──────────────────────────────────────────────────────────

async function getJwt() {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const res = await cognito.send(new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
  }));
  if (!res.AuthenticationResult?.IdToken) throw new Error("Auth failed. Challenge: " + res.ChallengeName);
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

async function listAll(queryName, query, filter) {
  const out = [];
  let nextToken = null;
  do {
    const data = await gql(query, { ...(filter ? { filter } : {}), ...(nextToken ? { nextToken } : {}) });
    const conn = data[queryName];
    out.push(...conn.items);
    nextToken = conn.nextToken;
  } while (nextToken);
  return out;
}

const Q_LOTS = `query Q($nextToken: String) { listFinanceHoldingLots(limit: 500, nextToken: $nextToken) { items { id accountId ticker quantity costBasis isVested } nextToken } }`;
const Q_TRADES = `query Q($filter: ModelFinanceTransactionFilterInput, $nextToken: String) { listFinanceTransactions(filter: $filter, limit: 500, nextToken: $nextToken) { items { id accountId ticker quantity type date } nextToken } }`;
const Q_ACCOUNTS = `query Q($nextToken: String) { listFinanceAccounts(limit: 500, nextToken: $nextToken) { items { id name type active currentBalance } nextToken } }`;
const Q_GOALS = `query Q($nextToken: String) { listFinanceSavingsGoals(limit: 500, nextToken: $nextToken) { items { id name targetAmount currentAmount } nextToken } }`;
const Q_MAPS = `query Q($nextToken: String) { listFinanceGoalFundingSources(limit: 500, nextToken: $nextToken) { items { id goalId accountId priority } nextToken } }`;
const Q_ACCT_SNAPS = `query Q($filter: ModelFinanceAccountSnapshotFilterInput, $nextToken: String) { listFinanceAccountSnapshots(filter: $filter, limit: 500, nextToken: $nextToken) { items { id accountId date balance } nextToken } }`;
const Q_HOLD_SNAPS = `query Q($filter: ModelFinanceHoldingSnapshotFilterInput, $nextToken: String) { listFinanceHoldingSnapshots(filter: $filter, limit: 500, nextToken: $nextToken) { items { id accountId ticker date } nextToken } }`;
const Q_GOAL_SNAPS = `query Q($filter: ModelFinanceGoalSnapshotFilterInput, $nextToken: String) { listFinanceGoalSnapshots(filter: $filter, limit: 500, nextToken: $nextToken) { items { id goalId date } nextToken } }`;

const M_CREATE_HOLD = `mutation M($input: CreateFinanceHoldingSnapshotInput!) { createFinanceHoldingSnapshot(input: $input) { id } }`;
const M_UPDATE_HOLD = `mutation M($input: UpdateFinanceHoldingSnapshotInput!) { updateFinanceHoldingSnapshot(input: $input) { id } }`;
const M_CREATE_GOAL = `mutation M($input: CreateFinanceGoalSnapshotInput!) { createFinanceGoalSnapshot(input: $input) { id } }`;
const M_UPDATE_GOAL = `mutation M($input: UpdateFinanceGoalSnapshotInput!) { updateFinanceGoalSnapshot(input: $input) { id } }`;

// ── Yahoo historical closes ───────────────────────────────────────────────────

async function fetchCloses(ticker, fromIso, toIso) {
  // Pad a few days on each side so forward-fill has a seed for the first dates.
  const p1 = Math.floor(new Date(`${addDays(fromIso, -7)}T00:00:00Z`).getTime() / 1000);
  const p2 = Math.floor(new Date(`${addDays(toIso, 2)}T00:00:00Z`).getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (finance-backfill)" } });
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result?.timestamp) return new Map();
  const ts = result.timestamp;
  const closeArr = result.indicators?.adjclose?.[0]?.adjclose ?? result.indicators?.quote?.[0]?.close ?? [];
  const m = new Map();
  for (let i = 0; i < ts.length; i++) {
    const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    const c = closeArr[i];
    if (c != null) m.set(d, c);
  }
  return m;
}

/** Forward-fill a close for `date` from the most recent known close on/before it. */
function closeAt(closeMap, date) {
  let cur = date;
  for (let i = 0; i < 10; i++) {     // look back up to 10 days for weekends/holidays
    if (closeMap.has(cur)) return closeMap.get(cur);
    cur = addDays(cur, -1);
  }
  return null;
}

// ── Goal allocation (JS port of computeGoalAllocations) ────────────────────────

function allocateGoals(accounts, goals, mappings, totalValueByAccount) {
  const allocatedByGoal = new Map();
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const goalById = new Map(goals.map((g) => [g.id, g]));
  const byAccount = new Map();
  for (const m of mappings) {
    if (!m.accountId) continue;
    (byAccount.get(m.accountId) ?? byAccount.set(m.accountId, []).get(m.accountId)).push(m);
  }
  const entries = [...byAccount.entries()].sort((a, b) => {
    const d = a[1].length - b[1].length;
    if (d !== 0) return d;
    return (accountById.get(a[0])?.name ?? "").localeCompare(accountById.get(b[0])?.name ?? "");
  });
  for (const [accountId, accMaps] of entries) {
    const acc = accountById.get(accountId);
    if (!acc || acc.active === false || acc.type === "CREDIT" || acc.type === "LOAN") continue;
    let remaining = Math.max(0, totalValueByAccount.get(accountId) ?? 0);
    const sorted = [...accMaps].sort((a, b) => ((a.priority ?? 100) - (b.priority ?? 100)) || (a.id ?? "").localeCompare(b.id ?? ""));
    for (const m of sorted) {
      const goal = goalById.get(m.goalId);
      if (!goal) continue;
      const already = allocatedByGoal.get(goal.id) ?? 0;
      const need = Math.max(0, (goal.targetAmount ?? 0) - already);
      const take = Math.min(remaining, need);
      if (take > 0) { allocatedByGoal.set(goal.id, already + take); remaining -= take; }
    }
  }
  return allocatedByGoal;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Authenticating…");
  JWT = await getJwt();

  const dates = enumerateDates(fromArg, toArg);
  console.log(`Backfilling ${dates.length} days (${fromArg} → ${toArg})\n`);

  console.log("Loading lots + trades…");
  const lots = await listAll("listFinanceHoldingLots", Q_LOTS);
  const trades = (await listAll("listFinanceTransactions", Q_TRADES, { or: [{ type: { eq: "BUY" } }, { type: { eq: "SELL" } }] }));
  console.log(`  ${lots.length} lots, ${trades.length} trades`);

  // Current quantity + avg-cost per (accountId, ticker).
  const key = (acct, tk) => `${acct}::${(tk ?? "").toUpperCase()}`;
  const qtyNow = new Map();
  for (const l of lots) {
    if (!l.accountId || !l.ticker) continue;
    qtyNow.set(key(l.accountId, l.ticker), (qtyNow.get(key(l.accountId, l.ticker)) ?? 0) + (l.quantity ?? 0));
  }

  // Group trades by account+ticker, sorted by date asc.
  const tradesByKey = new Map();
  for (const t of trades) {
    if (!t.accountId || !t.ticker || !t.date) continue;
    const k = key(t.accountId, t.ticker);
    (tradesByKey.get(k) ?? tradesByKey.set(k, []).get(k)).push(t);
  }

  // Distinct tickers to price.
  const tickers = [...new Set([...qtyNow.keys()].map((k) => k.split("::")[1]).filter(Boolean))];
  console.log(`  ${tickers.length} tickers to price: ${tickers.join(", ")}\n`);

  console.log("Fetching historical closes from Yahoo…");
  const closesByTicker = new Map();
  for (const tk of tickers) {
    const m = await fetchCloses(tk, fromArg, toArg);
    closesByTicker.set(tk, m);
    console.log(`  ${tk}: ${m.size} daily closes`);
    await sleep(250);
  }
  console.log("");

  // Preload existing snapshots in range for idempotency.
  const existingHold = new Set(
    (await listAll("listFinanceHoldingSnapshots", Q_HOLD_SNAPS, { date: { between: [fromArg, toArg] } }))
      .map((s) => `${s.accountId}::${(s.ticker ?? "").toUpperCase()}::${s.date}`),
  );

  // Build holding-snapshot rows.
  const holdRows = [];      // { id?, payload }
  const holdMarketByAcctDate = new Map();   // accountId::date -> Σ marketValue (for goals)
  const existingHoldId = new Map();
  if (!DRY_RUN) {
    // Need ids to update existing rows — fetch with ids.
    const rows = await listAll("listFinanceHoldingSnapshots", Q_HOLD_SNAPS, { date: { between: [fromArg, toArg] } });
    for (const r of rows) existingHoldId.set(`${r.accountId}::${(r.ticker ?? "").toUpperCase()}::${r.date}`, r.id);
  }

  for (const [k, baseQty] of qtyNow) {
    const [accountId, ticker] = k.split("::");
    const closes = closesByTicker.get(ticker) ?? new Map();
    const ktrades = (tradesByKey.get(k) ?? []).slice().sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
    for (const date of dates) {
      // qty at end of `date` = current − Σ(BUY after date) + Σ(SELL after date)
      let qty = baseQty;
      for (const t of ktrades) {
        if ((t.date ?? "") > date) {
          if (t.type === "BUY") qty -= (t.quantity ?? 0);
          else if (t.type === "SELL") qty += (t.quantity ?? 0);
        }
      }
      if (Math.abs(qty) < 1e-9) continue;   // not held on this date
      const price = closeAt(closes, date);
      if (price == null) continue;          // no price → skip
      const marketValue = qty * price;
      holdMarketByAcctDate.set(`${accountId}::${date}`, (holdMarketByAcctDate.get(`${accountId}::${date}`) ?? 0) + marketValue);
      holdRows.push({
        existsKey: `${accountId}::${ticker}::${date}`,
        payload: { accountId, ticker, date, quantity: qty, price, marketValue, costBasis: null, capturedAt: new Date().toISOString() },
      });
    }
  }
  console.log(`Prepared ${holdRows.length} holding-snapshot rows (${existingHold.size} already exist in range).`);

  // ── Goals (optional) ────────────────────────────────────────────────────────
  let goalRows = [];
  if (DO_GOALS) {
    console.log("\nLoading accounts/goals/mappings + account snapshots for goal backfill…");
    const accounts = await listAll("listFinanceAccounts", Q_ACCOUNTS);
    const goals = await listAll("listFinanceSavingsGoals", Q_GOALS);
    const mappings = await listAll("listFinanceGoalFundingSources", Q_MAPS);
    const acctSnaps = await listAll("listFinanceAccountSnapshots", Q_ACCT_SNAPS, { date: { between: [fromArg, toArg] } });
    const cashByAcctDate = new Map();
    for (const s of acctSnaps) cashByAcctDate.set(`${s.accountId}::${s.date}`, s.balance ?? 0);

    const existingGoalId = new Map();
    const gRows = await listAll("listFinanceGoalSnapshots", Q_GOAL_SNAPS, { date: { between: [fromArg, toArg] } });
    for (const r of gRows) existingGoalId.set(`${r.goalId}::${r.date}`, r.id);

    let missingCashDays = 0;
    for (const date of dates) {
      // Total value per account = cash snapshot + Σ holding market value that day.
      const totalByAccount = new Map();
      let anyCash = false;
      for (const acc of accounts) {
        const cash = cashByAcctDate.get(`${acc.id}::${date}`);
        if (cash != null) anyCash = true;
        const holdings = holdMarketByAcctDate.get(`${acc.id}::${date}`) ?? 0;
        totalByAccount.set(acc.id, (cash ?? acc.currentBalance ?? 0) + holdings);
      }
      if (!anyCash) { missingCashDays++; continue; }   // no reconstructed balances for this day
      const allocated = allocateGoals(accounts, goals, mappings, totalByAccount);
      for (const g of goals) {
        const hasMapping = mappings.some((m) => m.goalId === g.id);
        const amount = hasMapping ? (allocated.get(g.id) ?? 0) : (g.currentAmount ?? 0);
        goalRows.push({
          id: existingGoalId.get(`${g.id}::${date}`) ?? null,
          payload: { goalId: g.id, date, currentAmount: amount, targetAmount: g.targetAmount ?? null, capturedAt: new Date().toISOString() },
        });
      }
    }
    if (missingCashDays > 0) {
      console.warn(`  ⚠ ${missingCashDays}/${dates.length} days had no financeAccountSnapshot — skipped for goals. Run the Lambda's reconstructed backfill first.`);
    }
    console.log(`Prepared ${goalRows.length} goal-snapshot rows.`);
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN — no writes. Sample holding rows:");
    for (const r of holdRows.slice(0, 8)) {
      console.log(`  ${r.payload.date}  ${r.payload.ticker.padEnd(6)} qty=${r.payload.quantity.toFixed(3)} @ ${r.payload.price.toFixed(2)} = ${r.payload.marketValue.toFixed(2)}`);
    }
    return;
  }

  // Write holdings.
  console.log("\nWriting holding snapshots…");
  let ok = 0, fail = 0;
  for (let i = 0; i < holdRows.length; i++) {
    const r = holdRows[i];
    const existingId = existingHoldId.get(r.existsKey);
    try {
      if (existingId) await gql(M_UPDATE_HOLD, { input: { id: existingId, ...r.payload } });
      else await gql(M_CREATE_HOLD, { input: r.payload });
      ok++;
      if ((i + 1) % 100 === 0) console.log(`  …${i + 1}/${holdRows.length}`);
    } catch (e) { fail++; console.warn(`  ! ${r.existsKey} failed: ${e.message}`); }
    await sleep(DELAY_MS);
  }
  console.log(`Holdings: ${ok} written, ${fail} failed.`);

  // Write goals.
  if (DO_GOALS && goalRows.length) {
    console.log("\nWriting goal snapshots…");
    let gok = 0, gfail = 0;
    for (let i = 0; i < goalRows.length; i++) {
      const r = goalRows[i];
      try {
        if (r.id) await gql(M_UPDATE_GOAL, { input: { id: r.id, ...r.payload } });
        else await gql(M_CREATE_GOAL, { input: r.payload });
        gok++;
        if ((i + 1) % 100 === 0) console.log(`  …${i + 1}/${goalRows.length}`);
      } catch (e) { gfail++; console.warn(`  ! goal ${r.payload.goalId} ${r.payload.date} failed: ${e.message}`); }
      await sleep(DELAY_MS);
    }
    console.log(`Goals: ${gok} written, ${gfail} failed.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
