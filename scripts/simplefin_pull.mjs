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
 *   npm run sf:pull -- --apply --user=you@x --pass=...   # actually write
 *
 * Requires:
 *   - SIMPLEFIN_ACCESS_URL in .env.local
 *   - --user + --pass Cognito credentials for --apply mode
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
const USER = args.user;
const PASS = args.pass;

if (APPLY && (!USER || !PASS)) {
  console.error("--apply requires --user=you@example.com --pass=yourpass");
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
      items { id name type simplefinAccountId }
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
  query ListTxHashes($accountId: ID!, $fromIso: AWSDate!, $next: String) {
    listFinanceTransactions(
      filter: {
        accountId: { eq: $accountId },
        date:      { ge: $fromIso }
      },
      limit: 1000,
      nextToken: $next
    ) {
      items { id importHash date }
      nextToken
    }
  }`;

async function fetchExistingHashes(accountId, fromIso) {
  const hashes = new Set();
  let next = null;
  do {
    const data = await gql(LIST_TX_HASHES, { accountId, fromIso, next });
    for (const it of data.listFinanceTransactions.items ?? []) {
      if (it.importHash) hashes.add(it.importHash);
    }
    next = data.listFinanceTransactions.nextToken;
  } while (next);
  return hashes;
}

const CREATE_TX = `
  mutation CreateTx($input: CreateFinanceTransactionInput!) {
    createFinanceTransaction(input: $input) {
      id
    }
  }`;

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
  console.log(`Mode:        ${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}`);
  console.log();

  console.log("Fetching mapped accounts from AppSync…");
  if (APPLY) JWT = await getJwt();
  else JWT = null; // reads via API key work for finance* models? Depends on model auth.
  // finance* models are admins-only, so we need JWT even for reads. Auth upfront:
  if (!JWT) JWT = await getJwt();
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

  console.log("\nChecking existing importHashes for dedup…");
  const dupHashes = new Set();
  for (const a of wanted) {
    const hashes = await fetchExistingHashes(a.id, START);
    for (const h of hashes) dupHashes.add(h);
  }
  const fresh = drafts.filter((d) => !dupHashes.has(d.importHash));
  const dupCount = drafts.length - fresh.length;
  console.log(`  ${dupCount} already-imported (skipped)`);
  console.log(`  ${fresh.length} new`);

  if (fresh.length === 0) {
    console.log("\nNothing to insert. Done.");
    return;
  }

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

  if (!APPLY) {
    console.log("\nDry-run complete. Re-run with --apply --user --pass to write.");
    return;
  }

  console.log("\nInserting…");
  let ok = 0;
  let fail = 0;
  for (const d of fresh) {
    try {
      await gql(CREATE_TX, { input: d });
      ok++;
      if (ok % 25 === 0) console.log(`  wrote ${ok}/${fresh.length}`);
    } catch (e) {
      console.error(`  ✗ ${d.date} ${d.description.slice(0, 40)}: ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone. Wrote ${ok}, failed ${fail}.`);
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
