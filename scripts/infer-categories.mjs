/**
 * infer-categories.mjs
 *
 * Backfill transaction categories. The financeTransaction.category field is
 * free-text and mostly empty on bank imports, which makes the Review page's
 * by-category breakdowns meaningless. This script fills empty categories on
 * INCOME/EXPENSE transactions using the SAME ordered rule table the web app
 * uses (components/finance/category-rules.json — single source of truth), then
 * optionally asks Claude to categorize the descriptions no rule matched.
 *
 * Idempotent + safe: only fills EMPTY categories (never overwrites a user-set
 * one) unless --overwrite is passed. TRANSFER/BUY/SELL rows are left alone.
 *
 * Usage:
 *   node infer-categories.mjs \
 *     --env=sandbox|prod \
 *     --user=you@example.com --pass=yourpassword \
 *     [--account=<accountId>]   # restrict to one account
 *     [--llm]                   # Claude fallback for unmatched (needs ANTHROPIC_API_KEY)
 *     [--overwrite]             # also re-categorize rows that already have a category
 *     [--limit=N]               # cap rows processed
 *     [--dry-run]
 *
 * ANTHROPIC_API_KEY may be supplied via env or --anthropic-key=… for the LLM pass.
 */

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";
import rulesData from "../components/finance/category-rules.json" with { type: "json" };

// ── Args ──────────────────────────────────────────────────────────────────────

const DRY_RUN    = process.argv.includes("--dry-run");
const USE_LLM    = process.argv.includes("--llm");
const OVERWRITE  = process.argv.includes("--overwrite");
const userArg    = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const passArg    = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];
const acctArg    = process.argv.find((a) => a.startsWith("--account="))?.split("=")[1];
const limitArg   = process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
const keyArg     = process.argv.find((a) => a.startsWith("--anthropic-key="))?.split("=")[1];
const LIMIT      = limitArg ? parseInt(limitArg, 10) : Infinity;
const DELAY_MS   = 120;
const ANTHROPIC_KEY = keyArg ?? process.env.ANTHROPIC_API_KEY;

if (!userArg || !passArg) {
  console.error(
    "Usage: node infer-categories.mjs --env=sandbox|prod --user=… --pass=… " +
    "[--account=ID] [--llm] [--overwrite] [--limit=N] [--dry-run]",
  );
  process.exit(1);
}

const { region: REGION, clientId: CLIENT_ID, appsyncUrl: APPSYNC_URL } = getConfig();

// ── Rule engine (mirrors components/finance/categories.ts) ─────────────────────

const CATEGORY_RULES = rulesData.rules ?? [];
const VOCAB = [...new Set(CATEGORY_RULES.map((r) => r.category))].concat([
  "Income", "Transfers", "Investments", "Cash/ATM", "Uncategorized",
]);

function patternMatches(pattern, text) {
  const p = (pattern ?? "").trim();
  if (!p) return false;
  const m = p.match(/^\/(.+)\/([imsu]*)$/);
  if (m) {
    try { return new RegExp(m[1], m[2]).test(text); } catch { /* substring */ }
  }
  return text.toLowerCase().includes(p.toLowerCase());
}

function inferByRules(tx) {
  if (tx.type === "TRANSFER") return "Transfers";
  if (tx.type === "BUY" || tx.type === "SELL") return "Investments";
  const desc = (tx.description ?? "").trim();
  if (desc) {
    for (const rule of CATEGORY_RULES) {
      if (patternMatches(rule.pattern, desc)) return rule.category;
    }
  }
  if (tx.type === "INCOME") return "Income";
  return null;
}

// ── Auth + GraphQL ──────────────────────────────────────────────────────────

async function getJwt() {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const res = await cognito.send(new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
  }));
  if (!res.AuthenticationResult?.IdToken)
    throw new Error("Auth failed. Challenge: " + res.ChallengeName);
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

const LIST_TX = `
  query ListTx($filter: ModelFinanceTransactionFilterInput, $nextToken: String) {
    listFinanceTransactions(filter: $filter, limit: 500, nextToken: $nextToken) {
      items { id type category description amount date }
      nextToken
    }
  }`;

const UPDATE_TX = `
  mutation UpdateTx($input: UpdateFinanceTransactionInput!) {
    updateFinanceTransaction(input: $input) { id category }
  }`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listAllTx() {
  const out = [];
  let nextToken = null;
  const filter = acctArg ? { accountId: { eq: acctArg } } : undefined;
  do {
    const data = await gql(LIST_TX, { ...(filter ? { filter } : {}), ...(nextToken ? { nextToken } : {}) });
    out.push(...data.listFinanceTransactions.items);
    nextToken = data.listFinanceTransactions.nextToken;
  } while (nextToken);
  return out;
}

// ── Claude fallback (optional) ────────────────────────────────────────────────

async function classifyWithClaude(descriptions) {
  // Returns Map<description, category|null>. Batched single request.
  const sys =
    "You categorize personal bank-transaction descriptions into EXACTLY ONE of " +
    "these categories: " + VOCAB.join(", ") + ". Respond with a JSON object mapping " +
    "each input description verbatim to its category. If unsure, use \"Uncategorized\".";
  const user = JSON.stringify(descriptions);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      system: sys,
      messages: [{ role: "user", content: user }],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Anthropic: ${json.error.message}`);
  const text = (json.content ?? []).map((c) => c.text ?? "").join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return new Map();
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return new Map(); }
  const m = new Map();
  for (const [desc, cat] of Object.entries(parsed)) {
    m.set(desc, VOCAB.includes(cat) ? cat : "Uncategorized");
  }
  return m;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Authenticating…");
  JWT = await getJwt();

  console.log("Listing transactions…");
  const all = await listAllTx();
  console.log(`  ${all.length} total\n`);

  // Only INCOME/EXPENSE rows; only empty category unless --overwrite.
  const candidates = all.filter((tx) => {
    if (tx.type !== "INCOME" && tx.type !== "EXPENSE") return false;
    const hasCat = (tx.category ?? "").trim().length > 0;
    return OVERWRITE ? true : !hasCat;
  }).slice(0, LIMIT);

  console.log(`${candidates.length} candidate rows (${OVERWRITE ? "overwrite mode" : "empty category only"}).\n`);

  // Rule pass.
  const planned = [];     // { tx, category, source }
  const unmatched = [];
  for (const tx of candidates) {
    const cat = inferByRules(tx);
    if (cat) planned.push({ tx, category: cat, source: "rule" });
    else unmatched.push(tx);
  }
  console.log(`Rules matched ${planned.length}, ${unmatched.length} unmatched.`);

  // Optional Claude fallback for unmatched.
  if (USE_LLM && unmatched.length > 0) {
    if (!ANTHROPIC_KEY) {
      console.warn("  --llm set but no ANTHROPIC_API_KEY (env or --anthropic-key=) — skipping LLM pass.");
    } else {
      console.log(`  Asking Claude to categorize ${unmatched.length} descriptions…`);
      const BATCH = 40;
      for (let i = 0; i < unmatched.length; i += BATCH) {
        const slice = unmatched.slice(i, i + BATCH);
        const descs = slice.map((t) => t.description ?? "");
        try {
          const map = await classifyWithClaude(descs);
          for (const tx of slice) {
            const cat = map.get(tx.description ?? "");
            if (cat && cat !== "Uncategorized") planned.push({ tx, category: cat, source: "llm" });
          }
        } catch (e) {
          console.warn(`  ! LLM batch ${i}-${i + slice.length} failed: ${e.message}`);
        }
        await sleep(300);
      }
    }
  }

  // Preview.
  console.log(`\nWill set categories on ${planned.length} rows. Sample:`);
  for (const p of planned.slice(0, 12)) {
    console.log(`  [${p.source}] ${(p.category).padEnd(14)} ← ${(p.tx.description ?? "").slice(0, 56)}`);
  }
  console.log("");

  if (DRY_RUN) {
    const byCat = {};
    for (const p of planned) byCat[p.category] = (byCat[p.category] ?? 0) + 1;
    console.log("DRY RUN — no mutations. Category distribution:");
    for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${c}`);
    return;
  }

  let ok = 0, fail = 0;
  for (let i = 0; i < planned.length; i++) {
    const { tx, category } = planned[i];
    try {
      await gql(UPDATE_TX, { input: { id: tx.id, category } });
      ok++;
      if ((i + 1) % 50 === 0) console.log(`  …updated ${i + 1}/${planned.length}`);
    } catch (e) {
      fail++;
      console.warn(`  ! tx ${tx.id} failed: ${e.message}`);
    }
    await sleep(DELAY_MS);
  }
  console.log(`\nDone: ${ok} updated, ${fail} failed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
