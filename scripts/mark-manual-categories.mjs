/**
 * mark-manual-categories.mjs
 *
 * Pin specific transactions' categories as MANUAL so no automated pass
 * (the simplefinSync re-infer, infer-categories, consolidate-categories,
 * repair-simplefin-rows) can overwrite them again.
 *
 * Why a script and not a backfill: `categorySource` cannot be backfilled
 * truthfully. A row written before the field existed carries no record of who
 * chose its category, so every existing row reads as "unknown" and keeps the
 * old look-machine-assigned heuristic. The only honest way to mark a row MANUAL
 * is for someone to say which rows they actually set by hand — either by
 * re-saving the row in the UI, or by naming it here.
 *
 * Matching is by description substring (case-insensitive), because a row's id
 * is not something a person has to hand. Every match is printed before any
 * write, and --dry is the default-safe way to see the blast radius first:
 * a too-broad pattern pinning the wrong rows is the failure mode to avoid.
 *
 * Auth: Cognito JWT (admin writes) — COGNITO_USER / COGNITO_PASSWORD.
 *
 * Usage:
 *   node --env-file=.env.local scripts/mark-manual-categories.mjs --dry
 *   node --env-file=.env.local scripts/mark-manual-categories.mjs
 *   node --env-file=.env.local scripts/mark-manual-categories.mjs --match="VENMO PAYMENT 1051308071231"
 *   node --env-file=.env.local scripts/mark-manual-categories.mjs --env=sandbox --dry
 */

import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);
const DRY = !!args.dry;
const cfg = getConfig();

/**
 * Known hand-set categories, as (description substring → expected category).
 *
 * The expected category is required and checked: a pattern that matches a row
 * sitting in some *other* category means the pattern is wrong (or the row was
 * since changed), and pinning it would freeze a category nobody chose. Such a
 * row is reported and skipped, never written.
 */
const KNOWN_MANUAL = [
  // Confirmed by the user: this Venmo payment is for the dog, which no
  // descriptor could ever reveal — "VENMO PAYMENT <id> WEB ID: …" says only
  // that money moved. Exactly the case rules can never win.
  { match: "VENMO PAYMENT 1051308071231", category: "Dolce" },
];

const targets = args.match
  ? [{ match: String(args.match), category: args.category ? String(args.category) : null }]
  : KNOWN_MANUAL;

const LIST = `query($n:String){
  listFinanceTransactions(limit:1000, nextToken:$n){
    items{ id date amount description category categorySource }
    nextToken
  }
}`;

const UPDATE = `mutation($in: UpdateFinanceTransactionInput!){
  updateFinanceTransaction(input:$in){ id categorySource }
}`;

const money = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n ?? 0).toFixed(2)}`;

async function main() {
  console.log(`env: ${cfg.name ?? (process.argv.find((a) => a.startsWith("--env=")) ?? "--env=prod").slice(6)}`);

  const c = new CognitoIdentityProviderClient({ region: cfg.region });
  const r = await c.send(new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH", ClientId: cfg.clientId,
    AuthParameters: { USERNAME: process.env.COGNITO_USER, PASSWORD: process.env.COGNITO_PASSWORD },
  }));
  const JWT = r.AuthenticationResult.IdToken;
  const gql = async (query, variables) => {
    const res = await fetch(cfg.appsyncUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: JWT },
      body: JSON.stringify({ query, variables }),
    });
    const j = await res.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    return j.data;
  };

  const items = [];
  let tok = null;
  do {
    const d = await gql(LIST, { n: tok });
    items.push(...d.listFinanceTransactions.items);
    tok = d.listFinanceTransactions.nextToken;
  } while (tok);
  console.log(`${items.length} transactions scanned\n`);

  const planned = [];
  const mismatched = [];
  for (const t of targets) {
    const needle = t.match.toLowerCase();
    const hits = items.filter((x) => (x.description ?? "").toLowerCase().includes(needle));
    if (hits.length === 0) {
      console.log(`!  no match for "${t.match}"`);
      continue;
    }
    console.log(`"${t.match}" → ${hits.length} row(s)`);
    for (const h of hits) {
      const cur = (h.category ?? "").trim();
      const line = `   ${h.date}  ${money(h.amount).padStart(11)}  [${cur || "(none)"}]  ${(h.description ?? "").slice(0, 58)}`;
      if (t.category && cur !== t.category) {
        mismatched.push({ row: h, expected: t.category });
        console.log(`${line}   ✗ expected [${t.category}] — skipped`);
        continue;
      }
      if (h.categorySource === "MANUAL") {
        console.log(`${line}   · already MANUAL`);
        continue;
      }
      planned.push(h);
      console.log(`${line}   → MANUAL`);
    }
    console.log("");
  }

  if (mismatched.length > 0) {
    console.log(`${mismatched.length} row(s) skipped: the pattern matched a row in an unexpected category.`);
    console.log("Fix the pattern (or the expected category) rather than widening it.\n");
  }

  if (planned.length === 0) { console.log("Nothing to write."); return; }
  if (DRY) { console.log(`DRY RUN — would pin ${planned.length} row(s) as MANUAL.`); return; }

  let ok = 0;
  for (const h of planned) {
    await gql(UPDATE, { in: { id: h.id, categorySource: "MANUAL" } });
    ok++;
  }
  console.log(`Done: ${ok} row(s) pinned as MANUAL.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
