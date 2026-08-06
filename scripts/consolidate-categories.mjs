/**
 * consolidate-categories.mjs
 *
 * One-time category cleanup. Three passes over all financeTransactions:
 *   1. Delivery fix   — any row whose description is a food-delivery app
 *                       (DoorDash/Uber Eats/…) → "Food Delivery", pulling
 *                       historical delivery out of "Dining".
 *   2. Direct remaps  — leaked SimpleFIN buckets folded into canonical ones
 *                       (Food & Drink→Dining, Bills & Utilities→Utilities, …).
 *   3. Orphan reclass — ambiguous buckets (Payment/Personal/Gifts/
 *                       Professional Services) re-run through Haiku so each
 *                       lands in a real category by merchant, not a guess.
 *
 * Precedence: delivery > direct remap > orphan reclass. Only writes when the
 * target differs from the stored category. Anthropic key: env or Secrets
 * Manager (gennaroanesi/transcribe). Cognito JWT for writes.
 *
 * Usage:
 *   node --env-file=.env.local scripts/consolidate-categories.mjs --dry
 *   node --env-file=.env.local scripts/consolidate-categories.mjs
 */

import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { getConfig } from "./aws-config.mjs";

const DRY = process.argv.includes("--dry");
const cfg = getConfig();

const DELIVERY = /doordash|uber ?eats|grubhub|postmates|seamless|caviar|deliveroo|gopuff/i;
const REMAP = {
  "Food & Drink": "Dining",
  "Bills & Utilities": "Utilities",
  "Fees & Adjustments": "Fees",
  "Loan principal": "Loan Payment",
  "Dividends": "Investments",
  "Dividend reinvestment": "Investments",
  "Gas": "Gas/Transport",
  "Health & Wellness": "Health",
};
const ORPHANS = new Set(["Payment", "Personal", "Gifts", "Professional Services"]);
// Categories a delivery-app charge may override. A meaningful bucket like
// "Dolce" (pet) must survive even when the merchant is DoorDash (e.g. Petco
// delivery), so only dining/empty rows get moved to Food Delivery.
const DELIVERY_OVERRIDABLE = new Set(["", "Dining", "Food & Drink"]);
// Peer-to-peer payments have no clean spending category — leave them alone.
const P2P = /venmo|zelle|cash ?app/i;

// Allowed categories for the LLM (mirror CLASSIFIABLE_CATEGORIES).
const rulesData = JSON.parse(readFileSync(new URL("../components/finance/category-rules.json", import.meta.url)));
const EXCLUDED = new Set(["Transfers", "Credit Card Payment", "Loan Payment", "Investments"]);
const CATS = [...new Set(rulesData.rules.map((r) => r.category))].filter((c) => !EXCLUDED.has(c)).sort();

async function anthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const sm = new SecretsManagerClient({ region: cfg.region });
  const res = await sm.send(new GetSecretValueCommand({ SecretId: "gennaroanesi/transcribe" }));
  return JSON.parse(res.SecretString).anthropicApiKey;
}
function parseLoose(t) { const s = t.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim(); try { return JSON.parse(s); } catch { const m = s.match(/\[[\s\S]*\]/); if (m) { try { return JSON.parse(m[0]); } catch {} } return null; } }
async function classify(anthropic, items) {
  const catSet = new Set(CATS);
  const list = items.map((it, i) => `[${i}] ${it.amount < 0 ? "-" : "+"}$${Math.abs(it.amount).toFixed(2)}  ${(it.description ?? "").slice(0, 120)}`).join("\n");
  const resp = await anthropic.messages.create({
    model: "claude-haiku-4-5", max_tokens: 4096,
    system: "You categorize a person's bank and credit-card transactions. For each numbered transaction, choose the single best-fitting category from the ALLOWED list based on the merchant/description and the sign. Respond with ONLY a JSON array of {\"index\": <number>, \"category\": <allowed category>}. No prose, no code fences.",
    messages: [{ role: "user", content: `ALLOWED categories: ${CATS.join(", ")}\n\nTransactions:\n${list}` }],
  });
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const out = items.map(() => null), p = parseLoose(text);
  if (Array.isArray(p)) for (const r of p) { const i = r?.index, c = r?.category; if (typeof i === "number" && i >= 0 && i < items.length && catSet.has(c)) out[i] = c; }
  return out;
}

async function main() {
  const cog = new CognitoIdentityProviderClient({ region: cfg.region });
  const r = await cog.send(new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: cfg.clientId, AuthParameters: { USERNAME: process.env.COGNITO_USER, PASSWORD: process.env.COGNITO_PASSWORD } }));
  const JWT = r.AuthenticationResult.IdToken;
  const gql = async (query, variables) => { const res = await fetch(cfg.appsyncUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: JWT }, body: JSON.stringify({ query, variables }) }); const j = await res.json(); if (j.errors) throw new Error(JSON.stringify(j.errors)); return j.data; };

  let items = [], tok = null;
  do { const d = await gql(`query($n:String){ listFinanceTransactions(limit:1000, nextToken:$n){ items{ id description amount category } nextToken } }`, { n: tok }); items.push(...d.listFinanceTransactions.items); tok = d.listFinanceTransactions.nextToken; } while (tok);

  const updates = [];       // { id, from, to } for direct/delivery
  const orphanRows = [];    // rows needing LLM
  for (const t of items) {
    const cur = (t.category ?? "").trim();
    if (DELIVERY.test(t.description ?? "")) {
      // Only reroute dining/empty rows; preserve intentional buckets (Dolce, …).
      if (DELIVERY_OVERRIDABLE.has(cur)) updates.push({ id: t.id, from: cur || "(none)", to: "Food Delivery", desc: t.description });
      continue;
    }
    if (cur in REMAP) { updates.push({ id: t.id, from: cur, to: REMAP[cur], desc: t.description }); continue; }
    if (ORPHANS.has(cur) && !P2P.test(t.description ?? "")) orphanRows.push(t);
  }

  // LLM reclassify orphans
  const orphanUpdates = [];
  if (orphanRows.length) {
    const anthropic = new Anthropic({ apiKey: await anthropicKey() });
    for (let i = 0; i < orphanRows.length; i += 60) {
      const chunk = orphanRows.slice(i, i + 60);
      const cats = await classify(anthropic, chunk.map((t) => ({ description: t.description, amount: t.amount })));
      chunk.forEach((t, j) => { if (cats[j] && cats[j] !== (t.category ?? "").trim()) orphanUpdates.push({ id: t.id, from: (t.category ?? "").trim(), to: cats[j], desc: t.description }); });
    }
  }

  const all = [...updates, ...orphanUpdates];
  const byMove = {};
  for (const u of all) { const k = `${u.from} → ${u.to}`; (byMove[k] = byMove[k] || []).push(u); }
  console.log(`Total tx: ${items.length} | changes: ${all.length}\n`);
  for (const [move, list] of Object.entries(byMove).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${String(list.length).padStart(4)}  ${move}`);
    if (list.length <= 8) for (const u of list) console.log(`         · ${(u.desc ?? "").slice(0, 55)}`);
  }
  if (DRY) { console.log("\nDRY RUN — nothing written."); return; }

  let written = 0;
  for (const u of all) { await gql(`mutation($in: UpdateFinanceTransactionInput!){ updateFinanceTransaction(input:$in){ id } }`, { in: { id: u.id, category: u.to } }); written++; if (written % 50 === 0) console.log(`  …${written}/${all.length}`); }
  console.log(`\nDone. ${written} transactions recategorized.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
