/**
 * reclassify-uncategorized.mjs
 *
 * One-time (re-runnable) backfill: find EXPENSE transactions that the rule
 * table can't categorize (they display as "Uncategorized"), classify them with
 * Claude Haiku 4.5 — the same model + prompt the simplefinSync Lambda now uses
 * for new transactions — and write the category back to the DB.
 *
 * Only truly-uncategorized rows are sent to the LLM: rows whose category is
 * empty but which a rule WOULD match are skipped (they already display
 * correctly). The rule logic is ported from components/finance/categories.ts.
 *
 * Auth: Cognito JWT (admin writes). Anthropic key: env ANTHROPIC_API_KEY, else
 * pulled from Secrets Manager (gennaroanesi/transcribe → anthropicApiKey).
 *
 * Usage:
 *   node --env-file=.env.local scripts/reclassify-uncategorized.mjs --dry     # preview, no writes
 *   node --env-file=.env.local scripts/reclassify-uncategorized.mjs           # apply
 *   node --env-file=.env.local scripts/reclassify-uncategorized.mjs --limit=50
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "./aws-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);
const DRY = !!args.dry;
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;
const cfg = getConfig();

// ── Ported rule logic (keep in sync with components/finance/categories.ts) ────
const rulesData = JSON.parse(readFileSync(join(__dirname, "../components/finance/category-rules.json"), "utf8"));
const CATEGORY_RULES = rulesData.rules ?? [];
const EXCLUDED = new Set(["Transfers", "Credit Card Payment", "Loan Payment", "Investments"]);
const ALL_CATEGORIES = [...new Set(CATEGORY_RULES.map((r) => r.category))].sort();
const CLASSIFIABLE_CATEGORIES = ALL_CATEGORIES.filter((c) => !EXCLUDED.has(c));
const PROCESSOR_PREFIX = /^(paypal\s*\*|sq\s*\*|sp\s+|aplpay\s+|pwp\s+|dojo\s*\*|zettle\s*\*|tst\s*\*|py\s*\*|ic\*\s*)+/i;

function stripProcessorPrefix(d) { return (d ?? "").replace(PROCESSOR_PREFIX, "").trim(); }
function patternMatches(pattern, text) {
  const p = (pattern ?? "").trim();
  if (!p) return false;
  const rx = p.match(/^\/(.+)\/([imsu]*)$/);
  if (rx) { try { return new RegExp(rx[1], rx[2]).test(text); } catch { /* substring */ } }
  return text.toLowerCase().includes(p.toLowerCase());
}
/** EXPENSE-only inferCategory: returns a rule category or null. */
function inferCategoryExpense(description) {
  const desc = (description ?? "").trim();
  if (!desc) return null;
  const stripped = stripProcessorPrefix(desc);
  for (const rule of CATEGORY_RULES) {
    if (patternMatches(rule.pattern, desc)) return rule.category;
    if (stripped !== desc && patternMatches(rule.pattern, stripped)) return rule.category;
  }
  return null;
}

// ── Anthropic classifier (mirrors classify-llm.ts) ────────────────────────────
async function getAnthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const sm = new SecretsManagerClient({ region: cfg.region });
  const res = await sm.send(new GetSecretValueCommand({ SecretId: "gennaroanesi/transcribe" }));
  return JSON.parse(res.SecretString).anthropicApiKey;
}
function parseJsonLoose(text) {
  const s = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try { return JSON.parse(s); } catch { const m = s.match(/\[[\s\S]*\]/); if (m) { try { return JSON.parse(m[0]); } catch { /* */ } } return null; }
}
async function classifyChunk(anthropic, items) {
  const cats = CLASSIFIABLE_CATEGORIES, catSet = new Set(cats);
  const list = items.map((it, i) => `[${i}] ${it.amount < 0 ? "-" : "+"}$${Math.abs(it.amount).toFixed(2)}  ${(it.description ?? "").slice(0, 120)}`).join("\n");
  const resp = await anthropic.messages.create({
    model: "claude-haiku-4-5", max_tokens: 4096,
    system: "You categorize a person's bank and credit-card transactions. For each numbered transaction, choose the single best-fitting category from the ALLOWED list based on the merchant/description and the sign (negative = money out, positive = money in). Use your knowledge of what real merchants are. If a transaction is genuinely unrecognizable, pick the closest reasonable category rather than refusing. Respond with ONLY a JSON array of objects, one per transaction, each {\"index\": <number>, \"category\": <one of the allowed categories>}. No prose, no code fences.",
    messages: [{ role: "user", content: `ALLOWED categories: ${cats.join(", ")}\n\nTransactions:\n${list}` }],
  });
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const out = items.map(() => null);
  const parsed = parseJsonLoose(text);
  if (Array.isArray(parsed)) for (const r of parsed) {
    const i = r?.index, cat = r?.category;
    if (typeof i === "number" && i >= 0 && i < items.length && typeof cat === "string" && catSet.has(cat)) out[i] = cat;
  }
  return out;
}

// ── GraphQL ───────────────────────────────────────────────────────────────────
async function main() {
  const c = new CognitoIdentityProviderClient({ region: cfg.region });
  const r = await c.send(new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH", ClientId: cfg.clientId,
    AuthParameters: { USERNAME: process.env.COGNITO_USER, PASSWORD: process.env.COGNITO_PASSWORD },
  }));
  const JWT = r.AuthenticationResult.IdToken;
  const gql = async (query, variables) => {
    const res = await fetch(cfg.appsyncUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: JWT }, body: JSON.stringify({ query, variables }) });
    const j = await res.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    return j.data;
  };

  // Fetch all EXPENSE transactions, paginated.
  let items = [], token = null;
  do {
    const d = await gql(`query($n:String){ listFinanceTransactions(limit:1000, nextToken:$n, filter:{ type:{ eq: EXPENSE } }){ items{ id date description amount category } nextToken } }`, { n: token });
    items.push(...d.listFinanceTransactions.items);
    token = d.listFinanceTransactions.nextToken;
  } while (token);

  // Truly uncategorized = no stored category AND no rule match.
  const targets = items
    .filter((t) => !(t.category ?? "").trim())
    .filter((t) => inferCategoryExpense(t.description) === null)
    .slice(0, LIMIT);

  console.log(`EXPENSE transactions: ${items.length} | truly uncategorized: ${targets.length}${LIMIT !== Infinity ? ` (capped at ${LIMIT})` : ""}`);
  if (targets.length === 0) return;

  const anthropic = new Anthropic({ apiKey: await getAnthropicKey() });
  const BATCH = 60;
  let classified = 0, written = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const cats = await classifyChunk(anthropic, chunk.map((t) => ({ description: t.description, amount: t.amount })));
    for (let j = 0; j < chunk.length; j++) {
      const t = chunk[j], cat = cats[j];
      if (!cat) continue;
      classified++;
      console.log(`  ${cat.padEnd(16)} ← ${(t.description ?? "").slice(0, 50)}`);
      if (!DRY) {
        await gql(`mutation($in: UpdateFinanceTransactionInput!){ updateFinanceTransaction(input:$in){ id } }`, { in: { id: t.id, category: cat } });
        written++;
      }
    }
    console.log(`[batch ${Math.floor(i / BATCH) + 1}] ${classified} classified so far`);
  }
  console.log(`\nDone. ${classified}/${targets.length} classified${DRY ? " (DRY RUN — nothing written)" : `, ${written} written`}.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
