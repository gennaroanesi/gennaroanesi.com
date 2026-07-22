/**
 * simplefin_pull.mjs
 *
 * Pull transactions from SimpleFIN Bridge and upsert them into
 * financeTransaction. Reads the SimpleFIN→finance account mapping from
 * financeAccount.simplefinAccountId (set via the account edit UI on
 * /finance/accounts/[id]).
 *
 * Usage:
 *   npm run sf:pull                                      # print-only, no writes
 *   npm run sf:pull -- --days=7
 *   npm run sf:pull -- --start=2026-07-01 --end=2026-07-18
 *   npm run sf:pull -- --account=<financeAccountId>      # limit to one account
 *   npm run sf:pull -- --apply                           # actually write
 *
 * Auth:
 *   - COGNITO_USER + COGNITO_PASSWORD in .env.local (both modes need JWT
 *     because finance* models are admin-only). Or override per-call:
 *     --user=... --pass=...
 *   - Uses client-side InitiateAuth; no AWS credentials required.
 *
 * Requires:
 *   - SIMPLEFIN_ACCESS_URL in .env.local
 *
 * Behavior:
 *   - Only accounts with financeAccount.simplefinAccountId set are pulled.
 *   - Dedup via importHash(date, amount, description) — matches CSV importer,
 *     so a SimpleFIN pull won't duplicate a prior CSV row.
 *   - Auto-categorizes via CATEGORY_RULES (same code path as the review page).
 *   - Detects self-transfers: two mapped accounts, same date, exact-opposite
 *     amounts → both rows marked TRANSFER with toAccountId cross-refs and
 *     category "Transfers" (excluded from P&L).
 *   - Investment accounts (BROKERAGE/RETIREMENT) get category "Investments"
 *     when no rule matches — keeps cash-side movements out of expense totals.
 */

import { readFileSync } from "fs";

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";

import { fetchAccounts, maskAccessUrl } from "./_simplefin.mjs";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  })
);

const APPLY = args.apply === "true";
const DAYS = args.days ? parseInt(args.days, 10) : 14;
const START = args.start ?? isoDaysAgo(DAYS);
const END = args.end ?? isoToday();
const ACCOUNT_FILTER = args.account ?? null;
// Cognito user + password (your website login). Read from .env.local
// (COGNITO_USER / COGNITO_PASSWORD) by default; --user / --pass override.
// Client-side InitiateAuth — no AWS creds required.
const USER = args.user ?? process.env.COGNITO_USER;
const PASS = args.pass ?? process.env.COGNITO_PASSWORD;

if (!USER || !PASS) {
  console.error("Missing Cognito credentials. Set COGNITO_USER + COGNITO_PASSWORD in .env.local, or pass --user + --pass.");
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────

const accessUrl = process.env.SIMPLEFIN_ACCESS_URL;
if (!accessUrl) {
  console.error("Missing SIMPLEFIN_ACCESS_URL in .env.local");
  process.exit(1);
}

const outputs = JSON.parse(readFileSync("./amplify_outputs.json", "utf8"));
const REGION = outputs.auth.aws_region;
const CLIENT_ID = outputs.auth.user_pool_client_id;
const APPSYNC_URL = outputs.data.url;
const APPSYNC_KEY = outputs.data.api_key;

// ── Category rules (mirror components/finance/categories.ts logic) ────────────

const CATEGORY_RULES_RAW = JSON.parse(
  readFileSync("./components/finance/category-rules.json", "utf8")
);
const CATEGORY_RULES = CATEGORY_RULES_RAW.rules ?? [];
const INVESTMENT_CATEGORY = "Investments";

function patternMatches(pattern, text) {
  const p = pattern.trim();
  if (!p) return false;
  const rx = p.match(/^\/(.+)\/([imsu]*)$/);
  if (rx) {
    try { return new RegExp(rx[1], rx[2]).test(text); } catch { /* fall through */ }
  }
  return text.toLowerCase().includes(p.toLowerCase());
}

function inferCategory(tx) {
  if (tx.type === "TRANSFER") return "Transfers";
  const desc = (tx.description ?? "").trim();
  if (desc) {
    for (const r of CATEGORY_RULES) {
      if (patternMatches(r.pattern, desc)) return r.category;
    }
  }
  if (tx.type === "INCOME") return "Income";
  return null;
}

// ── Auth / GraphQL ────────────────────────────────────────────────────────────

let JWT;

async function getJwt() {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const res = await cognito.send(new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: USER, PASSWORD: PASS },
  }));
  if (!res.AuthenticationResult?.IdToken) {
    throw new Error("Auth failed. Challenge: " + res.ChallengeName);
  }
  return res.AuthenticationResult.IdToken;
}

async function gql(query, variables = {}, { auth = "jwt" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth === "jwt") headers["Authorization"] = JWT;
  else headers["x-api-key"] = APPSYNC_KEY;
  const res = await fetch(APPSYNC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

// ── Data helpers ──────────────────────────────────────────────────────────────

const LIST_ACCOUNTS = `
  query ListAccounts($next: String) {
    listFinanceAccounts(limit: 500, nextToken: $next) {
      items { id name type simplefinAccountId currentBalance }
      nextToken
    }
  }`;

async function fetchMappedAccounts() {
  const rows = [];
  let next = null;
  do {
    const data = await gql(LIST_ACCOUNTS, { next });
    rows.push(...(data.listFinanceAccounts.items ?? []));
    next = data.listFinanceAccounts.nextToken;
  } while (next);
  return rows.filter((a) => a.simplefinAccountId && a.simplefinAccountId.trim());
}

const LIST_TX_HASHES = `
  query ListTxHashes($accountId: ID!, $fromIso: String!, $next: String) {
    listFinanceTransactions(
      filter: {
        accountId: { eq: $accountId },
        date:      { ge: $fromIso }
      },
      limit: 1000,
      nextToken: $next
    ) {
      items { id importHash date amount }
      nextToken
    }
  }`;

/**
 * For each mapped account in the window, build two dedup indexes:
 *   - hashes: existing importHash values (catches same-source re-runs)
 *   - dateAmt: existing "date|amount" keys (catches cross-source dupes where
 *     SF's payee-style description differs from a prior CSV's bank-statement
 *     description → different importHash but same real transaction)
 * The dateAmt index is per-account; keys stay `date|amount.toFixed(2)`.
 */
async function fetchExistingDedupIndex(accountId, fromIso) {
  const hashes = new Set();
  const dateAmt = new Set();
  let next = null;
  do {
    const data = await gql(LIST_TX_HASHES, { accountId, fromIso, next });
    for (const it of data.listFinanceTransactions.items ?? []) {
      if (it.importHash) hashes.add(it.importHash);
      if (it.date != null && it.amount != null) {
        dateAmt.add(`${it.date}|${Number(it.amount).toFixed(2)}`);
      }
    }
    next = data.listFinanceTransactions.nextToken;
  } while (next);
  return { hashes, dateAmt };
}

const CREATE_TX = `
  mutation CreateTx($input: CreateFinanceTransactionInput!) {
    createFinanceTransaction(input: $input) {
      id
    }
  }`;

const UPDATE_ACCOUNT = `
  mutation UpdateAccount($input: UpdateFinanceAccountInput!) {
    updateFinanceAccount(input: $input) {
      id
      currentBalance
      balanceUpdatedAt
      lastSimplefinSyncAt
    }
  }`;

// ── Holdings (current positions) ───────────────────────────────────────────────
// financeHolding is the source of truth for a brokerage/retirement account's
// current VESTED positions. Each SimpleFIN pull upserts one row per (accountId,
// ticker) from the SF holdings array. source=SIMPLEFIN marks these as sync-owned;
// we never touch source=MANUAL rows (hand-entered / RSU lots live elsewhere).

const LIST_HOLDINGS = `
  query ListHoldings($accountId: ID!, $next: String) {
    listFinanceHoldings(
      filter: { accountId: { eq: $accountId } },
      limit: 500,
      nextToken: $next
    ) {
      items { id accountId ticker quantity costBasisTotal avgCostBasis source marketValueReported }
      nextToken
    }
  }`;

const CREATE_HOLDING = `
  mutation CreateHolding($input: CreateFinanceHoldingInput!) {
    createFinanceHolding(input: $input) { id }
  }`;

const UPDATE_HOLDING = `
  mutation UpdateHolding($input: UpdateFinanceHoldingInput!) {
    updateFinanceHolding(input: $input) { id }
  }`;

const DELETE_HOLDING = `
  mutation DeleteHolding($input: DeleteFinanceHoldingInput!) {
    deleteFinanceHolding(input: $input) { id }
  }`;

async function fetchExistingHoldings(accountId) {
  const rows = [];
  let next = null;
  do {
    const data = await gql(LIST_HOLDINGS, { accountId, next });
    rows.push(...(data.listFinanceHoldings.items ?? []));
    next = data.listFinanceHoldings.nextToken;
  } while (next);
  return rows;
}

/**
 * Collapse a SimpleFIN account's raw holdings into one desired financeHolding
 * per ticker. SF sometimes emits duplicate/garbage rows (e.g. the Equity Awards
 * account returns the same META position many times with shares=0); aggregating
 * by symbol and dropping zero-share results filters those out. Returns a Map
 * keyed by UPPERCASE ticker.
 */
function desiredHoldingsFromSf(sfAcc) {
  const byTicker = new Map();
  for (const h of sfAcc.holdings ?? []) {
    const ticker = (h.symbol ?? "").trim().toUpperCase();
    if (!ticker) continue; // no symbol → can't key a holding on it
    const agg = byTicker.get(ticker) ?? { ticker, shares: 0, costBasis: 0, marketValue: 0, hasCost: false };
    agg.shares += h.shares ?? 0;
    // SimpleFIN reports 0.00 cost_basis for positions where basis is unknown
    // (e.g. 401k funds). Treat only a positive basis as real so we don't overwrite
    // a null with 0 and manufacture a full-market-value "gain".
    if (h.costBasis != null && h.costBasis > 0) { agg.costBasis += h.costBasis; agg.hasCost = true; }
    if (h.marketValue != null) agg.marketValue += h.marketValue;
    byTicker.set(ticker, agg);
  }
  // Drop zero/near-zero-share aggregates (the SF garbage rows).
  for (const [k, v] of [...byTicker]) {
    if (Math.abs(v.shares) < 1e-9) byTicker.delete(k);
  }
  return byTicker;
}

// ── Hash + draft building ─────────────────────────────────────────────────────

function importHash(date, amount, description) {
  const raw = [date, Number(amount).toFixed(2), (description ?? "").trim().toLowerCase()].join("|");
  return Buffer.from(raw, "utf8").toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}

function sfTxToDraft(sfTx, financeAccount) {
  const description = sfTx.payee || sfTx.description || "(no description)";
  let type = sfTx.amount >= 0 ? "INCOME" : "EXPENSE";
  let category = inferCategory({ type, description });
  // Investment accounts: default any un-categorized rows to "Investments"
  // so they drop out of the review's P&L (matches your existing convention).
  if (!category && (financeAccount.type === "BROKERAGE" || financeAccount.type === "RETIREMENT")) {
    category = INVESTMENT_CATEGORY;
  }
  return {
    accountId:  financeAccount.id,
    date:       sfTx.posted,
    amount:     sfTx.amount,
    description,
    type,
    status:     sfTx.pending ? "PENDING" : "POSTED",
    category:   category ?? null,
    importHash: importHash(sfTx.posted, sfTx.amount, description),
    // Trace back to the SF tx id for debugging future dedup issues.
    notes:      `sf:${sfTx.id}`,
  };
}

/**
 * Walk all drafts and find pairs that look like a self-transfer:
 *   - same posted date
 *   - exact opposite amounts
 *   - both accounts are mapped (i.e., in our set)
 *   - different accounts
 * Mark both rows as TRANSFER + set toAccountId + category "Transfers".
 * Runs greedily — first match wins; each row can pair with at most one other.
 */
function markSelfTransfers(drafts) {
  const usedIdxs = new Set();
  let paired = 0;
  for (let i = 0; i < drafts.length; i++) {
    if (usedIdxs.has(i)) continue;
    const a = drafts[i];
    for (let j = i + 1; j < drafts.length; j++) {
      if (usedIdxs.has(j)) continue;
      const b = drafts[j];
      if (a.date !== b.date) continue;
      if (a.accountId === b.accountId) continue;
      if (Math.abs(a.amount + b.amount) > 0.005) continue;
      // Pair found.
      a.type = "TRANSFER"; a.toAccountId = b.accountId; a.category = "Transfers";
      b.type = "TRANSFER"; b.toAccountId = a.accountId; b.category = "Transfers";
      // Rebuild hashes since type has changed (importHash is on amount/desc, not type,
      // so it stays the same — but the description-only hash still uniquely identifies
      // each side). No update needed to the hash.
      usedIdxs.add(i); usedIdxs.add(j);
      paired++;
      break;
    }
  }
  return paired;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Access URL:  ${maskAccessUrl(accessUrl)}`);
  console.log(`Window:      ${START} → ${END}`);
  console.log(`Cognito user: ${USER}`);
  console.log(`Mode:        ${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}`);
  console.log();

  console.log("Authenticating…");
  JWT = await getJwt();

  console.log("Fetching mapped accounts from AppSync…");
  const mapped = await fetchMappedAccounts();
  if (mapped.length === 0) {
    console.error("No accounts have simplefinAccountId set. Fill it in on /finance/accounts/[id].");
    process.exit(1);
  }
  const wanted = ACCOUNT_FILTER ? mapped.filter((a) => a.id === ACCOUNT_FILTER) : mapped;
  if (wanted.length === 0) {
    console.error(`No mapped account with id=${ACCOUNT_FILTER}. Known:\n  ` +
      mapped.map((a) => `${a.id}  ${a.name}`).join("\n  "));
    process.exit(1);
  }
  const sfIds = wanted.map((a) => a.simplefinAccountId);
  const byId = new Map(wanted.map((a) => [a.simplefinAccountId, a]));

  console.log(`Mapped: ${mapped.length} account(s), pulling ${wanted.length}.`);
  for (const a of wanted) console.log(`  ${a.name.padEnd(50)}  ${a.simplefinAccountId}  → ${a.id}`);
  console.log();

  console.log("Fetching from SimpleFIN…");
  const { errors, accounts } = await fetchAccounts(accessUrl, {
    start:      START,
    end:        END,
    pending:    true,
    accountIds: sfIds,
  });
  if (errors.length) {
    console.log("Bridge-level errors:");
    for (const e of errors) console.log("  · " + e);
    console.log();
  }

  const drafts = [];
  for (const sfAcc of accounts) {
    const finAcc = byId.get(sfAcc.id);
    if (!finAcc) continue;
    for (const t of sfAcc.transactions) {
      drafts.push(sfTxToDraft(t, finAcc));
    }
  }
  console.log(`Prepared ${drafts.length} draft transaction(s) from SF.`);

  const pairs = markSelfTransfers(drafts);
  if (pairs > 0) console.log(`Marked ${pairs} self-transfer pair(s) (${pairs * 2} rows → TRANSFER).`);

  console.log("\nChecking existing transactions for dedup…");
  // Per-account indexes so a same date+amount hit on account A doesn't
  // accidentally suppress a real tx on account B.
  const indexByAccount = new Map();
  for (const a of wanted) {
    indexByAccount.set(a.id, await fetchExistingDedupIndex(a.id, START));
  }
  const fresh = drafts.filter((d) => {
    const idx = indexByAccount.get(d.accountId);
    if (!idx) return true;
    if (idx.hashes.has(d.importHash)) return false;
    if (idx.dateAmt.has(`${d.date}|${d.amount.toFixed(2)}`)) return false;
    return true;
  });
  const dupCount = drafts.length - fresh.length;
  console.log(`  ${dupCount} already-imported (skipped — hash or date+amount match)`);
  console.log(`  ${fresh.length} new`);

  // Per-account counters for the sync-details stamp on each mapped account.
  // Every mapped account gets an entry — even ones with zero SF activity —
  // so the lastSimplefinSyncAt timestamp reflects "we checked".
  const perAccountSummary = new Map();
  for (const a of wanted) {
    perAccountSummary.set(a.id, { txTotal: 0, txNew: 0, duplicates: 0 });
  }
  for (const d of drafts) {
    const s = perAccountSummary.get(d.accountId);
    if (s) s.txTotal++;
  }
  for (const d of fresh) {
    const s = perAccountSummary.get(d.accountId);
    if (s) s.txNew++;
  }
  for (const [id, s] of perAccountSummary) {
    s.duplicates = s.txTotal - s.txNew;
  }

  if (fresh.length > 0) {
    console.log("\nSample of first 10 new drafts:");
    for (const d of fresh.slice(0, 10)) {
      console.log(
        `  ${d.date}  ${d.status.padEnd(7)}  ${d.type.padEnd(8)}  ` +
        `${String(d.amount.toFixed(2)).padStart(9)}  ` +
        `${(d.category ?? "-").padEnd(22)}  ` +
        `${d.description.slice(0, 40).padEnd(40)}  ` +
        `${d.toAccountId ? `→${d.toAccountId.slice(0, 8)}` : ""}`
      );
    }
    if (fresh.length > 10) console.log(`  … and ${fresh.length - 10} more`);
  }

  // ── Balance diffs ────────────────────────────────────────────────────
  // SimpleFIN's `balance` is authoritative for standard cash/debt accounts.
  // Skipped for BROKERAGE + RETIREMENT because SF reports CASH balance there
  // (holdings live separately), and:
  //   - BROKERAGE.currentBalance per the schema comment is meant to be cash
  //     alone with holdings layered via financeHoldingLot — but users often
  //     store total value; without knowing which semantic each account uses,
  //     safer to leave alone.
  //   - RETIREMENT.currentBalance is typically total value (no per-lot
  //     tracking), so overwriting with SF's cash-only figure would wipe out
  //     the invested portion.
  // Runs on every pull, not just when new txs land. Skip < $0.01 drift.
  const SKIP_BALANCE_TYPES = new Set(["BROKERAGE", "RETIREMENT"]);
  const balanceUpdates = [];
  const skippedBalance = [];
  for (const sfAcc of accounts) {
    const finAcc = byId.get(sfAcc.id);
    if (!finAcc) continue;
    if (SKIP_BALANCE_TYPES.has(finAcc.type)) {
      skippedBalance.push({ finAcc, sfBalance: sfAcc.balance });
      continue;
    }
    const current = finAcc.currentBalance ?? 0;
    const target = sfAcc.balance;
    if (Math.abs(current - target) < 0.005) continue;
    balanceUpdates.push({ finAcc, current, target });
  }

  if (balanceUpdates.length > 0) {
    console.log(`\nBalance updates (${balanceUpdates.length}):`);
    for (const u of balanceUpdates) {
      const delta = u.target - u.current;
      const sign = delta >= 0 ? "+" : "";
      console.log(
        `  ${u.finAcc.name.padEnd(50)}  ` +
        `${u.current.toFixed(2).padStart(12)}  →  ${u.target.toFixed(2).padStart(12)}  ` +
        `(${sign}${delta.toFixed(2)})`
      );
    }
  } else {
    console.log("\nAll (non-investment) account balances already in sync with SimpleFIN.");
  }

  if (skippedBalance.length > 0) {
    console.log(`\nSkipped balance update for ${skippedBalance.length} investment account(s) (SF reports cash-only):`);
    for (const s of skippedBalance) {
      console.log(`  ${s.finAcc.name.padEnd(50)}  SF cash: ${s.sfBalance.toFixed(2).padStart(12)}  (kept local currentBalance)`);
    }
  }

  // ── Holdings (current positions) ─────────────────────────────────────
  // Upsert one financeHolding per (account, ticker) for invested accounts,
  // straight from SimpleFIN's holdings array. SF is authoritative for these
  // vested positions: we match existing rows by ticker (any source), write
  // source=SIMPLEFIN, and delete SF-owned rows for positions that vanished
  // (sold out). MANUAL rows SF can't see are left untouched.
  const holdingCreates = [];
  const holdingUpdates = [];
  const holdingDeletes = [];
  for (const sfAcc of accounts) {
    const finAcc = byId.get(sfAcc.id);
    if (!finAcc) continue;
    if (!SKIP_BALANCE_TYPES.has(finAcc.type)) continue; // BROKERAGE/RETIREMENT only
    const desired  = desiredHoldingsFromSf(sfAcc);
    const existing = await fetchExistingHoldings(finAcc.id);
    const existingByTicker = new Map(existing.map((h) => [(h.ticker ?? "").toUpperCase(), h]));

    for (const [ticker, d] of desired) {
      const avg = d.hasCost && Math.abs(d.shares) > 1e-9 ? d.costBasis / d.shares : null;
      const fields = {
        quantity:            d.shares,
        costBasisTotal:      d.hasCost ? d.costBasis : null,
        avgCostBasis:        avg,
        source:              "SIMPLEFIN",
        marketValueReported: d.marketValue,
      };
      const ex = existingByTicker.get(ticker);
      if (ex) holdingUpdates.push({ finAcc, ticker, id: ex.id, fields, prev: ex });
      else    holdingCreates.push({ finAcc, ticker, fields });
    }
    // SF-owned positions that are no longer present → sold out → delete.
    for (const [ticker, ex] of existingByTicker) {
      if (desired.has(ticker)) continue;
      if (ex.source !== "SIMPLEFIN") continue; // don't touch manual rows
      holdingDeletes.push({ finAcc, ticker, id: ex.id });
    }
  }

  const holdingChanges = holdingCreates.length + holdingUpdates.length + holdingDeletes.length;
  if (holdingChanges > 0) {
    console.log(`\nHolding updates (${holdingChanges}):  ${holdingCreates.length} new, ${holdingUpdates.length} updated, ${holdingDeletes.length} removed`);
    for (const c of holdingCreates) {
      console.log(`  + ${c.finAcc.name.slice(0, 28).padEnd(28)}  ${c.ticker.padEnd(8)}  ${String((c.fields.quantity ?? 0).toFixed(4)).padStart(12)} sh  cost ${c.fields.costBasisTotal != null ? c.fields.costBasisTotal.toFixed(2) : "—"}`);
    }
    for (const u of holdingUpdates) {
      const dq = (u.fields.quantity ?? 0) - (u.prev.quantity ?? 0);
      const sign = dq >= 0 ? "+" : "";
      console.log(`  ~ ${u.finAcc.name.slice(0, 28).padEnd(28)}  ${u.ticker.padEnd(8)}  ${String((u.fields.quantity ?? 0).toFixed(4)).padStart(12)} sh  (${sign}${dq.toFixed(4)})`);
    }
    for (const d of holdingDeletes) {
      console.log(`  − ${d.finAcc.name.slice(0, 28).padEnd(28)}  ${d.ticker.padEnd(8)}  (sold out)`);
    }
  } else {
    console.log("\nAll holdings already in sync with SimpleFIN.");
  }

  if (!APPLY) {
    console.log("\nDry-run complete. Re-run with --apply to write.");
    return;
  }

  // ── Writes ───────────────────────────────────────────────────────────
  let txOk = 0;
  let txFail = 0;
  if (fresh.length > 0) {
    console.log("\nInserting transactions…");
    for (const d of fresh) {
      try {
        await gql(CREATE_TX, { input: d });
        txOk++;
        if (txOk % 25 === 0) console.log(`  wrote ${txOk}/${fresh.length}`);
      } catch (e) {
        console.error(`  ✗ ${d.date} ${d.description.slice(0, 40)}: ${e.message}`);
        txFail++;
      }
    }
  }

  // ── Per-account update: balance (when applicable) + sync timestamps ──
  // One update() call per mapped account combines any balance change with
  // the stamp fields, so we don't triple-mutate the same record.
  const nowIso = new Date().toISOString();
  const balanceUpdateById = new Map(balanceUpdates.map((u) => [u.finAcc.id, u]));
  let acctOk = 0;
  let acctFail = 0;
  let balOk = 0;
  console.log("\nStamping accounts…");
  for (const a of wanted) {
    const summary = perAccountSummary.get(a.id);
    const balUpd = balanceUpdateById.get(a.id);
    const details = {
      fromIso:         START,
      toIso:           END,
      txTotal:         summary?.txTotal ?? 0,
      txNew:           summary?.txNew ?? 0,
      duplicates:      summary?.duplicates ?? 0,
      balanceUpdated:  !!balUpd,
      balanceSkipped:  SKIP_BALANCE_TYPES.has(a.type),
    };
    const input = {
      id:                        a.id,
      lastSimplefinSyncAt:       nowIso,
      lastSimplefinSyncDetails:  JSON.stringify(details),
      ...(balUpd
        ? { currentBalance: balUpd.target, balanceUpdatedAt: nowIso }
        : {}),
    };
    try {
      await gql(UPDATE_ACCOUNT, { input });
      acctOk++;
      if (balUpd) balOk++;
    } catch (e) {
      console.error(`  ✗ ${a.name}: ${e.message}`);
      acctFail++;
    }
  }

  // ── Holdings writes ──────────────────────────────────────────────────
  let holdOk = 0;
  let holdFail = 0;
  if (holdingChanges > 0) {
    console.log("\nWriting holdings…");
    for (const c of holdingCreates) {
      try {
        await gql(CREATE_HOLDING, { input: { accountId: c.finAcc.id, ticker: c.ticker, updatedAt: nowIso, ...c.fields } });
        holdOk++;
      } catch (e) {
        console.error(`  ✗ create ${c.finAcc.name} ${c.ticker}: ${e.message}`);
        holdFail++;
      }
    }
    for (const u of holdingUpdates) {
      try {
        await gql(UPDATE_HOLDING, { input: { id: u.id, updatedAt: nowIso, ...u.fields } });
        holdOk++;
      } catch (e) {
        console.error(`  ✗ update ${u.finAcc.name} ${u.ticker}: ${e.message}`);
        holdFail++;
      }
    }
    for (const d of holdingDeletes) {
      try {
        await gql(DELETE_HOLDING, { input: { id: d.id } });
        holdOk++;
      } catch (e) {
        console.error(`  ✗ delete ${d.finAcc.name} ${d.ticker}: ${e.message}`);
        holdFail++;
      }
    }
  }

  console.log(`\nDone. Transactions: ${txOk} written, ${txFail} failed. Accounts stamped: ${acctOk} ok (${balOk} with balance write), ${acctFail} failed. Holdings: ${holdOk} written, ${holdFail} failed.`);
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function isoToday() { return new Date().toISOString().slice(0, 10); }
function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
