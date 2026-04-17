/**
 * fix_credit_card_import_signs.mjs
 *
 * One-time fix: for imported transactions on a given credit card account,
 * negate their `amount` and flip their `type` between INCOME and EXPENSE.
 * Then set the account's `currentBalance` to the correct authoritative value.
 *
 * Context: the Chase CSV parser previously inverted signs universally, which was
 * wrong. Chase CSVs already use our app convention (money leaving = negative),
 * so the inversion double-flipped. This script undoes the damage for already-
 * imported transactions. Manually-entered transactions (importHash IS NULL) are
 * left untouched.
 *
 * Usage:
 *   node fix_credit_card_import_signs.mjs \
 *     --env=sandbox|prod \
 *     --user=you@example.com --pass=yourpassword \
 *     --account=<accountId> \
 *     --balance=-1804.35 \
 *     [--dry-run]
 *
 * The --balance arg should be the authoritative current balance per the latest
 * statement (negative for credit cards). The script writes this exact value;
 * it does NOT derive it from the transactions, since we don't trust that any
 * single transaction set exactly matches the statement.
 */

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";

// ── Args ──────────────────────────────────────────────────────────────────────

const DRY_RUN   = process.argv.includes("--dry-run");
const userArg   = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const passArg   = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];
const acctArg   = process.argv.find((a) => a.startsWith("--account="))?.split("=")[1];
const balArg    = process.argv.find((a) => a.startsWith("--balance="))?.split("=")[1];
const DELAY_MS  = 120;

if (!userArg || !passArg || !acctArg || balArg === undefined) {
  console.error(
    "Usage: node fix_credit_card_import_signs.mjs \\\n" +
    "  --env=sandbox|prod \\\n" +
    "  --user=you@example.com --pass=yourpassword \\\n" +
    "  --account=<accountId> \\\n" +
    "  --balance=-1804.35 \\\n" +
    "  [--dry-run]",
  );
  process.exit(1);
}

const correctBalance = parseFloat(balArg);
if (Number.isNaN(correctBalance)) {
  console.error(`--balance must be a number, got: ${balArg}`);
  process.exit(1);
}

const { region: REGION, clientId: CLIENT_ID, appsyncUrl: APPSYNC_URL } = getConfig();

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getJwt() {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const res = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
    }),
  );
  if (!res.AuthenticationResult?.IdToken)
    throw new Error(
      "Auth failed — check username/password. Challenge: " + res.ChallengeName,
    );
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

// ── GraphQL ───────────────────────────────────────────────────────────────────

const GET_ACCOUNT = `
  query GetAccount($id: ID!) {
    getFinanceAccount(id: $id) {
      id
      name
      type
      currentBalance
      currency
    }
  }`;

const LIST_TX = `
  query ListTx($filter: ModelFinanceTransactionFilterInput, $nextToken: String) {
    listFinanceTransactions(filter: $filter, limit: 500, nextToken: $nextToken) {
      items {
        id
        accountId
        amount
        type
        importHash
        description
        date
      }
      nextToken
    }
  }`;

const UPDATE_TX = `
  mutation UpdateTx($input: UpdateFinanceTransactionInput!) {
    updateFinanceTransaction(input: $input) { id amount type }
  }`;

const UPDATE_ACCOUNT = `
  mutation UpdateAccount($input: UpdateFinanceAccountInput!) {
    updateFinanceAccount(input: $input) { id currentBalance }
  }`;

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flipType(t) {
  if (t === "INCOME") return "EXPENSE";
  if (t === "EXPENSE") return "INCOME";
  // TRANSFER stays TRANSFER — but transfers shouldn't come from CSV import anyway
  return t;
}

async function listImportedTx(accountId) {
  const records = [];
  let nextToken = null;
  do {
    const data = await gql(LIST_TX, {
      filter: {
        accountId:  { eq: accountId },
        importHash: { attributeExists: true },
      },
      ...(nextToken ? { nextToken } : {}),
    });
    records.push(...data.listFinanceTransactions.items);
    nextToken = data.listFinanceTransactions.nextToken;
  } while (nextToken);
  return records;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Authenticating…");
  JWT = await getJwt();

  console.log(`Loading account ${acctArg}…`);
  const { getFinanceAccount: acc } = await gql(GET_ACCOUNT, { id: acctArg });
  if (!acc) {
    console.error(`Account ${acctArg} not found`);
    process.exit(1);
  }
  console.log(`  Name:             ${acc.name}`);
  console.log(`  Type:             ${acc.type}`);
  console.log(`  Current balance:  ${acc.currentBalance} ${acc.currency ?? "USD"}`);
  console.log(`  Target balance:   ${correctBalance} ${acc.currency ?? "USD"}`);
  console.log("");

  console.log(`Listing imported transactions on this account…`);
  const txs = await listImportedTx(acctArg);
  console.log(`  Found ${txs.length} imported transactions\n`);

  if (txs.length === 0) {
    console.log("Nothing to flip. Will still reset account balance if needed.");
  } else {
    // Preview a few so the user can sanity-check
    console.log("Sample (first 5):");
    for (const tx of txs.slice(0, 5)) {
      console.log(
        `  ${tx.date}  ${tx.amount?.toString().padStart(10)}  ${tx.type?.padEnd(8)}  ${tx.description?.slice(0, 60) ?? ""}`,
      );
    }
    console.log("");
  }

  if (DRY_RUN) {
    console.log("DRY RUN — no mutations will be sent.");
    console.log(`Would flip sign/type on ${txs.length} transactions.`);
    console.log(`Would set account.currentBalance from ${acc.currentBalance} → ${correctBalance}.`);
    return;
  }

  // Flip each transaction
  let ok = 0, fail = 0;
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    const newAmount = -(tx.amount ?? 0);
    const newType   = flipType(tx.type);
    try {
      await gql(UPDATE_TX, {
        input: { id: tx.id, amount: newAmount, type: newType },
      });
      ok++;
      if ((i + 1) % 50 === 0) console.log(`  …flipped ${i + 1}/${txs.length}`);
    } catch (e) {
      fail++;
      console.warn(`  ! tx ${tx.id} failed: ${e.message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`\nDone flipping: ${ok} succeeded, ${fail} failed.`);

  // Reset account balance to authoritative value
  console.log(`\nSetting ${acc.name}.currentBalance = ${correctBalance}…`);
  try {
    await gql(UPDATE_ACCOUNT, {
      input: { id: acctArg, currentBalance: correctBalance },
    });
    console.log("  ✓ done");
  } catch (e) {
    console.error(`  ! balance update failed: ${e.message}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
