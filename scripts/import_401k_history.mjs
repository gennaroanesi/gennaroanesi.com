/**
 * import_401k_history.mjs
 *
 * Imports Fidelity 401(k) transaction-history CSV into financeHoldingLot rows
 * on a RETIREMENT-typed financeAccount. Each non-zero "Contributions" or
 * "Loan Repayments" row becomes one lot with the row's shares + dollar
 * amount as the cost basis. `Transfer` rows with $0 are skipped (CSV
 * padding from Fidelity's exporter).
 *
 * The lot's `notes` field embeds a stable signature
 * (`fidelity-401k:<date>:<type>`) so the same CSV can be re-run after
 * appending new periods without creating duplicates — every row whose
 * signature already exists on this account is skipped. Pass --force to
 * disable.
 *
 * CSV format (Fidelity export):
 *   Plan name:,META PLATFORMS
 *   Date Range,01/01/2026 - 05/10/2026
 *   <blank>
 *   Date,Investment,Transaction Type,Amount,Shares/Unit
 *   05/08/2026,VANGUARD TARGET 2060,Transfer,"0.00","0.000"
 *   05/08/2026,VANGUARD TARGET 2060,Loan Repayments,"257.08","1.605"
 *   05/08/2026,VANGUARD TARGET 2060,Contributions,"2,332.84","14.567"
 *   ...
 *
 * Prerequisites:
 *   npm install @aws-sdk/client-cognito-identity-provider
 *
 * Usage:
 *   node scripts/import_401k_history.mjs \
 *     --user=you@example.com --pass=yourpass \
 *     --account=<retirement-account-id> \
 *     --file=./scripts/data/fidelity_401k_history.csv \
 *     --ticker=59101K851 \
 *     [--dry-run] [--force]
 *
 * Notes:
 * - `--ticker` defaults to 59101K851 (the CUSIP for the user's VANGUARD
 *   TARGET 2060 institutional CIT). For other funds, pass the symbol you
 *   have an entry for in financeTickerQuote. Lots whose ticker has no
 *   quote will show with quantity but no market value until you add one.
 * - The retirement account must already exist. Get its id via
 *   `scripts/list_accounts.mjs` or the UI.
 */

import { readFileSync } from "fs";
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { randomUUID } from "crypto";

// ── Args ──────────────────────────────────────────────────────────────────────

const argv      = process.argv.slice(2);
const DRY_RUN   = argv.includes("--dry-run");
const FORCE     = argv.includes("--force");
const userArg   = argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const passArg   = argv.find((a) => a.startsWith("--pass="))?.split("=")[1];
const accountArg = argv.find((a) => a.startsWith("--account="))?.split("=")[1];
const fileArg   = argv.find((a) => a.startsWith("--file="))?.split("=")[1]
                  ?? "./scripts/data/fidelity_401k_history.csv";
const tickerArg = argv.find((a) => a.startsWith("--ticker="))?.split("=")[1] ?? "59101K851";
const DELAY_MS  = 80;

if (!userArg || !passArg || !accountArg) {
  console.error(
    "Usage: node scripts/import_401k_history.mjs --user=you@example.com --pass=yourpass " +
    "--account=<retirement-account-id> [--file=path] [--ticker=59101K851] [--dry-run] [--force]",
  );
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────

const outputs     = JSON.parse(readFileSync("./amplify_outputs.json", "utf8"));
const REGION      = outputs.auth.aws_region;
const CLIENT_ID   = outputs.auth.user_pool_client_id;
const APPSYNC_URL = outputs.data.url;

// ── Auth ──────────────────────────────────────────────────────────────────────

let JWT;

async function getJwt() {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const res = await cognito.send(new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
  }));
  if (!res.AuthenticationResult?.IdToken) {
    throw new Error("Auth failed. Challenge: " + res.ChallengeName);
  }
  return res.AuthenticationResult.IdToken;
}

// ── GraphQL ───────────────────────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const res = await fetch(APPSYNC_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": JWT },
    body:    JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

const LIST_LOTS_FOR_ACCOUNT = `
  query ListLots($accountId: ID!, $next: String) {
    listFinanceHoldingLots(filter: { accountId: { eq: $accountId } }, limit: 1000, nextToken: $next) {
      items   { id ticker purchaseDate notes }
      nextToken
    }
  }`;

const CREATE_LOT = `
  mutation CreateLot($input: CreateFinanceHoldingLotInput!) {
    createFinanceHoldingLot(input: $input) { id }
  }`;

// ── CSV parsing ────────────────────────────────────────────────────────────────

// Minimal quote-aware splitter — sufficient for Fidelity's export which uses
// double-quoted strings for the numeric columns and bare strings elsewhere.
// No embedded escaped quotes in the wild data; if Fidelity ever adds them
// we'll need a real CSV lib.
function splitCsvRow(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function toIso(mdy) {
  const [m, d, y] = mdy.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function toNumber(s) {
  return parseFloat(String(s).replace(/,/g, ""));
}

function parseFidelityCsv(text) {
  const lines = text.split(/\r?\n/);
  // Find the actual data header — first row that starts with `Date,`.
  const headerIdx = lines.findIndex((l) => /^Date,/i.test(l));
  if (headerIdx < 0) throw new Error("Could not find data header row in CSV");
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = splitCsvRow(line);
    if (parts.length < 5) continue;
    const [dateStr, investment, type, amountStr, sharesStr] = parts;
    const date    = toIso(dateStr);
    const amount  = toNumber(amountStr);
    const shares  = toNumber(sharesStr);
    if (!Number.isFinite(amount) || !Number.isFinite(shares)) continue;
    rows.push({ date, investment, type, amount, shares });
  }
  return rows;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stable signature embedded in each lot's notes so re-runs dedup cleanly.
// Date + type is unique per row in a Fidelity export (one Contributions + one
// Loan Repayments per pay date). Amount included as a tiebreaker if Fidelity
// ever ships two contributions on the same day with different amounts (e.g.
// a corrected restatement).
function lotSignature(row) {
  return `fidelity-401k:${row.date}:${row.type}:${row.amount.toFixed(2)}`;
}

async function fetchExistingSignatures(accountId) {
  const sigs = new Set();
  let next = null;
  let page = 0;
  do {
    const data = await gql(LIST_LOTS_FOR_ACCOUNT, { accountId, next });
    page++;
    for (const lot of data.listFinanceHoldingLots.items) {
      const m = (lot.notes ?? "").match(/fidelity-401k:[^\s]+/);
      if (m) sigs.add(m[0]);
    }
    next = data.listFinanceHoldingLots.nextToken;
  } while (next);
  console.log(`  fetched ${sigs.size} existing signatures across ${page} page(s)`);
  return sigs;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Fidelity 401(k) history importer${DRY_RUN ? " (DRY RUN)" : ""}`);
  console.log(`  source:  ${fileArg}`);
  console.log(`  account: ${accountArg}`);
  console.log(`  ticker:  ${tickerArg}`);

  const raw  = readFileSync(fileArg, "utf8");
  const rows = parseFidelityCsv(raw);
  console.log(`  parsed ${rows.length} data row(s)`);

  // Keep Contributions + Loan Repayments only; drop $0 Transfer padding and
  // anything else Fidelity might surface.
  const eligible = rows.filter((r) =>
    (r.type === "Contributions" || r.type === "Loan Repayments")
    && r.amount > 0 && r.shares > 0,
  );
  console.log(`  ${eligible.length} eligible (Contributions + Loan Repayments, > 0)`);

  if (!DRY_RUN) {
    process.stdout.write(`Authenticating as ${userArg}… `);
    JWT = await getJwt();
    console.log("✓");
  }

  let existing = new Set();
  if (!DRY_RUN && !FORCE) {
    process.stdout.write("Fetching existing lot signatures for dedup… ");
    existing = await fetchExistingSignatures(accountArg);
  }

  let inserted = 0, dupes = 0, errors = 0;

  for (let i = 0; i < eligible.length; i++) {
    const row = eligible[i];
    const tag = `[${i + 1}/${eligible.length}]`;
    const sig = lotSignature(row);

    if (!FORCE && existing.has(sig)) {
      console.log(`${tag} ✓ dedup ${row.date} ${row.type} ${row.amount.toFixed(2)} — skipping`);
      dupes++;
      continue;
    }

    const input = {
      id:           randomUUID(),
      accountId:    accountArg,
      ticker:       tickerArg,
      assetType:    "MUTUAL_FUND",
      quantity:     row.shares,
      costBasis:    row.amount,
      purchaseDate: row.date,
      isVested:     true,
      notes:        `${sig} · ${row.investment}`,
    };

    if (DRY_RUN) {
      console.log(`${tag} [DRY] ${row.date} ${row.type.padEnd(16)} ${row.amount.toFixed(2).padStart(10)}  ${row.shares.toFixed(3).padStart(8)} sh`);
      inserted++;
      continue;
    }

    try {
      await gql(CREATE_LOT, { input });
      console.log(`${tag} ✓ ${row.date} ${row.type} ${row.amount.toFixed(2)}`);
      existing.add(sig);
      inserted++;
    } catch (e) {
      console.error(`${tag} ✗ ${row.date} ${row.type}: ${e.message}`);
      errors++;
    }
    await sleep(DELAY_MS);
  }

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`  Inserted: ${inserted}  |  Dupes: ${dupes}  |  Errors: ${errors}`);
  if (DRY_RUN) console.log("  (Dry run — nothing was written to the database)");
}

main().catch((e) => { console.error(e); process.exit(1); });
