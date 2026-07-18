/**
 * simplefin_dedupe.mjs
 *
 * One-shot cleanup for duplicates left over from before the pull script
 * gained cross-source dedup on (accountId, date, amount).
 *
 * Scans every mapped account (financeAccount.simplefinAccountId set) and
 * groups their transactions by (accountId, date, amount). In each group,
 * if there is at least one SF-pulled row (notes starts with "sf:") AND at
 * least one non-SF row, the SF ones are the duplicates — the CSV/manual
 * originals stay. Groups where every copy is SF are left alone (nothing
 * to prefer).
 *
 * Usage:
 *   npm run sf:dedupe                       # dry-run, list dupes
 *   npm run sf:dedupe -- --apply            # actually delete
 *   npm run sf:dedupe -- --account=<id>     # limit to one financeAccount id
 *
 * Auth:
 *   Same as sf:pull — COGNITO_USER + COGNITO_PASSWORD in .env.local or
 *   --user + --pass CLI args.
 */

import { readFileSync } from "fs";

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  })
);

const APPLY = args.apply === "true";
const ACCOUNT_FILTER = args.account ?? null;
const USER = args.user ?? process.env.COGNITO_USER;
const PASS = args.pass ?? process.env.COGNITO_PASSWORD;

if (!USER || !PASS) {
  console.error("Missing Cognito credentials. Set COGNITO_USER + COGNITO_PASSWORD in .env.local, or pass --user + --pass.");
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────

const outputs = JSON.parse(readFileSync("./amplify_outputs.json", "utf8"));
const REGION = outputs.auth.aws_region;
const CLIENT_ID = outputs.auth.user_pool_client_id;
const APPSYNC_URL = outputs.data.url;

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

async function gql(query, variables = {}) {
  const res = await fetch(APPSYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": JWT },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

const LIST_ACCOUNTS = `
  query ListAccounts($next: String) {
    listFinanceAccounts(limit: 500, nextToken: $next) {
      items { id name simplefinAccountId }
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

const LIST_TXS = `
  query ListTxs($accountId: ID!, $next: String) {
    listFinanceTransactions(
      filter: { accountId: { eq: $accountId } },
      limit: 1000,
      nextToken: $next
    ) {
      items { id accountId date amount description notes }
      nextToken
    }
  }`;

async function fetchAllTxsForAccount(accountId) {
  const rows = [];
  let next = null;
  do {
    const data = await gql(LIST_TXS, { accountId, next });
    rows.push(...(data.listFinanceTransactions.items ?? []));
    next = data.listFinanceTransactions.nextToken;
  } while (next);
  return rows;
}

const DELETE_TX = `
  mutation DeleteTx($input: DeleteFinanceTransactionInput!) {
    deleteFinanceTransaction(input: $input) { id }
  }`;

// ── Main ──────────────────────────────────────────────────────────────────────

function isSfSourced(tx) {
  return typeof tx.notes === "string" && tx.notes.trim().startsWith("sf:");
}

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY (deletes)" : "DRY-RUN (no deletes)"}`);
  console.log(`User: ${USER}`);
  console.log();

  JWT = await getJwt();

  const mapped = await fetchMappedAccounts();
  const wanted = ACCOUNT_FILTER ? mapped.filter((a) => a.id === ACCOUNT_FILTER) : mapped;
  if (wanted.length === 0) {
    console.error("No mapped accounts to scan.");
    process.exit(1);
  }
  console.log(`Scanning ${wanted.length} account(s):`);
  for (const a of wanted) console.log(`  ${a.name}`);
  console.log();

  const toDelete = [];
  let scanned = 0;
  for (const acc of wanted) {
    const txs = await fetchAllTxsForAccount(acc.id);
    scanned += txs.length;
    // Group by date|amount within this account.
    const groups = new Map();
    for (const t of txs) {
      if (t.date == null || t.amount == null) continue;
      const key = `${t.date}|${Number(t.amount).toFixed(2)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    // In each group, if there are both SF and non-SF copies, the SF ones are dupes.
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      const sfCopies = group.filter(isSfSourced);
      const nonSfCopies = group.filter((t) => !isSfSourced(t));
      if (sfCopies.length === 0 || nonSfCopies.length === 0) continue;
      for (const sf of sfCopies) {
        toDelete.push({ acc, sf, keeping: nonSfCopies[0], key });
      }
    }
  }

  console.log(`Scanned ${scanned} transaction(s) across ${wanted.length} account(s).`);
  console.log(`Found ${toDelete.length} SF-sourced duplicate(s) to remove.\n`);

  if (toDelete.length === 0) return;

  for (const d of toDelete.slice(0, 40)) {
    console.log(
      `  ${d.acc.name.padEnd(28)}  ${d.sf.date}  ${String(Number(d.sf.amount).toFixed(2)).padStart(10)}  ` +
      `DEL: "${(d.sf.description ?? "").slice(0, 34).padEnd(34)}"  ` +
      `KEEP: "${(d.keeping.description ?? "").slice(0, 34)}"`
    );
  }
  if (toDelete.length > 40) console.log(`  … and ${toDelete.length - 40} more`);

  if (!APPLY) {
    console.log("\nDry-run complete. Re-run with --apply to delete the flagged rows.");
    return;
  }

  console.log("\nDeleting…");
  let ok = 0;
  let fail = 0;
  for (const d of toDelete) {
    try {
      await gql(DELETE_TX, { input: { id: d.sf.id } });
      ok++;
      if (ok % 25 === 0) console.log(`  deleted ${ok}/${toDelete.length}`);
    } catch (e) {
      console.error(`  ✗ ${d.sf.id}: ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone. Deleted ${ok}, failed ${fail}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
