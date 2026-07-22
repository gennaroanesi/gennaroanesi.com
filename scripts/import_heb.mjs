/**
 * import_heb.mjs
 *
 * Import an H-E-B credit card "Activity" CSV export into financeTransaction.
 * Mirrors the "H-E-B Card" format handled by parseBankCsv in the /finance
 * Import UI, so a later switch to the UI flow stays consistent (same importHash,
 * same sign convention, same category inference).
 *
 * H-E-B CSV shape:
 *   Date,Amount,Type,Merchant,Category,Method
 *   "YYYY/MM/DD, HH:MM:SS",$198.23,TRANSACTION,H-E-B #591,"Grocery Stores, Supermarkets",Contactless
 *
 *   - Date is Y/M/D order with a time suffix.
 *   - Amount: H-E-B exports purchases as POSITIVE and payments/refunds/rewards
 *     as NEGATIVE — the opposite of our app convention. We negate so money
 *     leaving you is negative (EXPENSE) and money coming in is positive (INCOME).
 *   - Type PAYMENT / REWARD are debt paydown → category "Credit Card Payment"
 *     (excluded from P&L). Everything else falls to merchant-based inference.
 *
 * Usage:
 *   node --env-file=.env.local scripts/import_heb.mjs \
 *     --env=prod \
 *     --account=<financeAccountId> \
 *     [--file=scripts/data/heb_activity.csv] \
 *     [--balance=-1804.35] \
 *     [--apply]                 # omit for a dry run (no writes)
 *
 * Auth (finance* models are admin-only, so all ops use a Cognito JWT):
 *   - COGNITO_USER + COGNITO_PASSWORD in .env.local, or --user=… --pass=…
 *
 * Behavior:
 *   - DELETES every existing transaction on --account first, then inserts the
 *     full CSV. This is a clean replace, not an upsert — run it against the
 *     account you intend to own the H-E-B history.
 *   - Dry run by default; prints what it would delete/insert. Pass --apply to write.
 *   - --balance (optional) sets the account's authoritative currentBalance after
 *     import (negative for a card you owe on). Skipped if omitted.
 */

import { readFileSync } from "fs";

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";

import { getConfig } from "./aws-config.mjs";

// ── CLI args ────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);

const APPLY   = args.apply === "true";
const FILE    = args.file ?? "scripts/data/heb_activity.csv";
const ACCOUNT = args.account ?? null;
const BALANCE = args.balance !== undefined ? parseFloat(args.balance) : null;
const USER    = args.user ?? process.env.COGNITO_USER;
const PASS    = args.pass ?? process.env.COGNITO_PASSWORD;

if (!ACCOUNT) {
  console.error("Missing --account=<financeAccountId>. (Tip: run scripts/list_accounts.mjs to find it.)");
  process.exit(1);
}
if (!USER || !PASS) {
  console.error("Missing Cognito credentials. Set COGNITO_USER + COGNITO_PASSWORD in .env.local, or pass --user + --pass.");
  process.exit(1);
}
if (BALANCE !== null && Number.isNaN(BALANCE)) {
  console.error(`--balance must be a number, got: ${args.balance}`);
  process.exit(1);
}

const { region: REGION, clientId: CLIENT_ID, appsyncUrl: APPSYNC_URL } = getConfig();

// ── Category inference (mirror components/finance/categories.ts) ──────────────

const CATEGORY_RULES = (JSON.parse(
  readFileSync("./components/finance/category-rules.json", "utf8"),
).rules ?? []);

// Payment-processor prefixes that bury the real merchant (e.g. "SP BRAZILMKT").
// Mirrors PROCESSOR_PREFIX in components/finance/categories.ts.
const PROCESSOR_PREFIX =
  /^(paypal\s*\*|sq\s*\*|sp\s+|aplpay\s+|pwp\s+|dojo\s*\*|zettle\s*\*|tst\s*\*|py\s*\*|ic\*\s*)+/i;

function stripProcessorPrefix(desc) {
  return desc.replace(PROCESSOR_PREFIX, "").trim();
}

function patternMatches(pattern, text) {
  const p = pattern.trim();
  if (!p) return false;
  const rx = p.match(/^\/(.+)\/([imsu]*)$/);
  if (rx) {
    try { return new RegExp(rx[1], rx[2]).test(text); } catch { /* fall through */ }
  }
  return text.toLowerCase().includes(p.toLowerCase());
}

function inferCategory({ description, type }) {
  const desc = (description ?? "").trim();
  if (desc) {
    const stripped = stripProcessorPrefix(desc);
    for (const rule of CATEGORY_RULES) {
      if (patternMatches(rule.pattern, desc)) return rule.category;
      if (stripped !== desc && patternMatches(rule.pattern, stripped)) return rule.category;
    }
  }
  if (type === "INCOME") return "Income";
  return null;
}

// ── CSV parsing (mirror splitCsvRow + the "H-E-B Card" BankFormat) ────────────

function splitCsvRow(row) {
  const fields = [];
  let cur = "", inQ = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '"') { if (inQ && row[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (c === "," && !inQ) { fields.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  fields.push(cur.trim());
  return fields;
}

const parseAmt = (raw) => parseFloat(String(raw).replace(/[$,\s]/g, "")) || 0;

function importHash(date, amount, description) {
  const raw = [date, Number(amount).toFixed(2), (description ?? "").trim().toLowerCase()].join("|");
  return Buffer.from(raw, "utf8").toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}

/** Parse one H-E-B row → draft financeTransaction, or null if unparseable. */
function hebRowToDraft(row) {
  const [y, m, d] = ((row["Date"] ?? "").split(",")[0].trim()).split("/");
  if (!y || !m || !d) return null;
  const date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;

  const amount = -parseAmt(row["Amount"] ?? "0"); // negate: purchases → negative
  const description = (row["Merchant"]?.trim() || row["Type"]?.trim() || "(no description)");
  const type = amount >= 0 ? "INCOME" : "EXPENSE";

  const rawType = (row["Type"] ?? "").trim().toUpperCase();
  const category = rawType === "PAYMENT" || rawType === "REWARD"
    ? "Credit Card Payment"                       // debt paydown, excluded from P&L
    : (inferCategory({ description, type }) ?? null);

  return {
    accountId:  ACCOUNT,
    amount,
    type,
    category,
    description,
    date,
    status:     "POSTED",
    importHash: importHash(date, amount, description),
  };
}

function parseHebCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCsvRow(lines[0]).map((h) => h.replace(/^"|"$/g, "").trim());
  if (!(headers.includes("Merchant") && headers.includes("Method") && headers.includes("Type"))) {
    throw new Error(`CSV headers don't look like an H-E-B export. Got: ${headers.join(", ")}`);
  }
  const drafts = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitCsvRow(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] ?? ""; });
    const d = hebRowToDraft(row);
    if (d) drafts.push(d);
  }
  return drafts;
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
    throw new Error("Auth failed — check username/password. Challenge: " + res.ChallengeName);
  }
  return res.AuthenticationResult.IdToken;
}

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

const GET_ACCOUNT = `
  query GetAccount($id: ID!) {
    getFinanceAccount(id: $id) { id name type currentBalance currency }
  }`;

const LIST_TX = `
  query ListTx($accountId: ID!, $next: String) {
    listFinanceTransactions(
      filter: { accountId: { eq: $accountId } },
      limit: 500,
      nextToken: $next
    ) {
      items { id date amount description }
      nextToken
    }
  }`;

const CREATE_TX = `
  mutation CreateTx($input: CreateFinanceTransactionInput!) {
    createFinanceTransaction(input: $input) { id }
  }`;

const DELETE_TX = `
  mutation DeleteTx($input: DeleteFinanceTransactionInput!) {
    deleteFinanceTransaction(input: $input) { id }
  }`;

const UPDATE_ACCOUNT = `
  mutation UpdateAccount($input: UpdateFinanceAccountInput!) {
    updateFinanceAccount(input: $input) { id currentBalance }
  }`;

async function listAllTx(accountId) {
  const rows = [];
  let next = null;
  do {
    const data = await gql(LIST_TX, { accountId, next });
    rows.push(...(data.listFinanceTransactions.items ?? []));
    next = data.listFinanceTransactions.nextToken;
  } while (next);
  return rows;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Mode:     ${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}`);
  console.log(`File:     ${FILE}`);
  console.log(`Account:  ${ACCOUNT}`);
  console.log();

  const csvText = readFileSync(FILE, "utf8");
  const drafts  = parseHebCsv(csvText);
  console.log(`Parsed ${drafts.length} transaction(s) from CSV.`);

  console.log("\nAuthenticating…");
  JWT = await getJwt();

  const { getFinanceAccount: acc } = await gql(GET_ACCOUNT, { id: ACCOUNT });
  if (!acc) { console.error(`Account ${ACCOUNT} not found.`); process.exit(1); }
  console.log(`  ${acc.name}  (${acc.type})  balance ${acc.currentBalance} ${acc.currency ?? "USD"}`);
  if (acc.type !== "CREDIT") {
    console.log(`  ⚠ account type is ${acc.type}, not CREDIT — sign convention assumes a credit card.`);
  }

  const existing = await listAllTx(ACCOUNT);
  console.log(`\nExisting transactions on this account: ${existing.length} (all will be deleted).`);

  // ── Summary of what we'd insert ─────────────────────────────────────────
  const byCat = new Map();
  let spend = 0, income = 0;
  for (const d of drafts) {
    byCat.set(d.category ?? "Uncategorized", (byCat.get(d.category ?? "Uncategorized") ?? 0) + 1);
    if (d.amount < 0) spend += d.amount; else income += d.amount;
  }
  console.log(`\nDraft breakdown by category:`);
  for (const [cat, n] of [...byCat].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${cat}`);
  }
  console.log(`\n  Expenses total: ${spend.toFixed(2)}   Income/payments total: +${income.toFixed(2)}   Net: ${(spend + income).toFixed(2)}`);

  console.log(`\nSample (first 8):`);
  for (const d of drafts.slice(0, 8)) {
    console.log(
      `  ${d.date}  ${String(d.amount.toFixed(2)).padStart(10)}  ${d.type.padEnd(7)}  ` +
      `${(d.category ?? "-").padEnd(20)}  ${d.description.slice(0, 40)}`,
    );
  }

  if (BALANCE !== null) {
    console.log(`\nWould set account.currentBalance: ${acc.currentBalance} → ${BALANCE}`);
  }

  if (!APPLY) {
    console.log("\nDry-run complete. Re-run with --apply to delete existing + write.");
    return;
  }

  // ── Delete existing ─────────────────────────────────────────────────────
  console.log(`\nDeleting ${existing.length} existing transaction(s)…`);
  let delOk = 0, delFail = 0;
  for (const tx of existing) {
    try {
      await gql(DELETE_TX, { input: { id: tx.id } });
      delOk++;
      if (delOk % 50 === 0) console.log(`  deleted ${delOk}/${existing.length}`);
    } catch (e) {
      console.error(`  ✗ delete ${tx.id}: ${e.message}`);
      delFail++;
    }
    await sleep(60);
  }

  // ── Insert ──────────────────────────────────────────────────────────────
  console.log(`\nInserting ${drafts.length} transaction(s)…`);
  let insOk = 0, insFail = 0;
  for (const d of drafts) {
    try {
      await gql(CREATE_TX, { input: d });
      insOk++;
      if (insOk % 50 === 0) console.log(`  wrote ${insOk}/${drafts.length}`);
    } catch (e) {
      console.error(`  ✗ ${d.date} ${d.description.slice(0, 40)}: ${e.message}`);
      insFail++;
    }
    await sleep(60);
  }

  // ── Optional balance reset ──────────────────────────────────────────────
  if (BALANCE !== null) {
    console.log(`\nSetting currentBalance = ${BALANCE}…`);
    try {
      await gql(UPDATE_ACCOUNT, { input: { id: ACCOUNT, currentBalance: BALANCE, balanceUpdatedAt: new Date().toISOString() } });
      console.log("  ✓ done");
    } catch (e) {
      console.error(`  ✗ balance update failed: ${e.message}`);
    }
  }

  console.log(`\nDone. Deleted ${delOk} (${delFail} failed). Inserted ${insOk} (${insFail} failed).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
