/**
 * migrate_transfer_recurrings.mjs
 *
 * One-off: collapse the old two-rule internal-transfer convention (an INCOME
 * recurring + an EXPENSE recurring of equal magnitude/cadence, e.g. "Savings" +
 * "Savings from Salary") into a single financeRecurring of type TRANSFER with a
 * toAccountId — the model that replaces the pair.
 *
 * Detection mirrors the cashflow engine: equal |amount|, same cadence, and a
 * shared meaningful description word. For each detected pair it CREATES one
 * TRANSFER (from = expense.accountId, to = income.accountId, amount = the
 * negative expense amount) and DELETES the two originals.
 *
 * Requires the deployed schema (TRANSFER type + toAccountId). Prod by default.
 *   node --env-file=.env.local scripts/migrate_transfer_recurrings.mjs         # dry-run
 *   node --env-file=.env.local scripts/migrate_transfer_recurrings.mjs --apply
 */
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";

const APPLY = process.argv.includes("--apply");
const cfg = getConfig();

const STOP = new Set(["from", "with", "into", "your", "this", "that", "payment", "monthly", "auto"]);
const words = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w));

let JWT;
async function getJwt() {
  const c = new CognitoIdentityProviderClient({ region: cfg.region });
  const r = await c.send(new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: cfg.clientId, AuthParameters: { USERNAME: process.env.COGNITO_USER, PASSWORD: process.env.COGNITO_PASSWORD } }));
  if (!r.AuthenticationResult?.IdToken) throw new Error("Auth failed: " + r.ChallengeName);
  return r.AuthenticationResult.IdToken;
}
async function gql(query, variables = {}) {
  const r = await fetch(cfg.appsyncUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: JWT }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
}
async function pageAll(query, key, vars = {}) { const out = []; let n = null; do { const d = await gql(query, { ...vars, next: n }); out.push(...d[key].items); n = d[key].nextToken; } while (n); return out; }

async function main() {
  console.log(`Transfer-recurring migration — ${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}\n`);
  JWT = await getJwt();

  const accts = await pageAll(`query($next:String){listFinanceAccounts(limit:500,nextToken:$next){items{id name} nextToken}}`, "listFinanceAccounts");
  const nameById = new Map(accts.map((a) => [a.id, a.name]));
  const recs = await pageAll(`query($next:String){listFinanceRecurrings(limit:500,nextToken:$next){items{id description amount type category cadence startDate nextDate endDate active accountId toAccountId} nextToken}}`, "listFinanceRecurrings");

  const incomes = recs.filter((r) => r.type === "INCOME" && r.active !== false);
  const expenses = recs.filter((r) => r.type === "EXPENSE" && r.active !== false);
  const pairs = [];
  const usedExp = new Set();
  for (const inc of incomes) {
    const incW = new Set(words(inc.description));
    if (!incW.size) continue;
    const exp = expenses.find((e) => !usedExp.has(e.id) && Math.abs(Math.abs(inc.amount) - Math.abs(e.amount)) < 0.005 && e.cadence === inc.cadence && words(e.description).some((w) => incW.has(w)));
    if (exp) { pairs.push({ inc, exp }); usedExp.add(exp.id); }
  }

  if (!pairs.length) { console.log("No transfer pairs detected."); return; }
  console.log(`Detected ${pairs.length} transfer pair(s):\n`);
  for (const { inc, exp } of pairs) {
    console.log(`  TRANSFER "${exp.description}"  ${exp.amount}  ${exp.cadence}`);
    console.log(`    from ${nameById.get(exp.accountId) ?? exp.accountId}  →  to ${nameById.get(inc.accountId) ?? inc.accountId}`);
    console.log(`    replaces:  income "${inc.description}" (${inc.id})  +  expense "${exp.description}" (${exp.id})\n`);
  }

  if (!APPLY) { console.log("Dry-run complete. Re-run with --apply to write."); return; }

  for (const { inc, exp } of pairs) {
    await gql(`mutation($i:CreateFinanceRecurringInput!){createFinanceRecurring(input:$i){id}}`, {
      i: {
        accountId: exp.accountId, toAccountId: inc.accountId, amount: exp.amount, type: "TRANSFER",
        category: exp.category ?? inc.category ?? null, description: exp.description,
        cadence: exp.cadence, startDate: exp.startDate, nextDate: exp.nextDate ?? exp.startDate,
        endDate: exp.endDate ?? null, active: true,
      },
    });
    await gql(`mutation($i:DeleteFinanceRecurringInput!){deleteFinanceRecurring(input:$i){id}}`, { i: { id: inc.id } });
    await gql(`mutation($i:DeleteFinanceRecurringInput!){deleteFinanceRecurring(input:$i){id}}`, { i: { id: exp.id } });
    console.log(`  ✓ ${exp.description}: created TRANSFER, deleted the pair`);
  }
  console.log(`\nDone. Migrated ${pairs.length} pair(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
