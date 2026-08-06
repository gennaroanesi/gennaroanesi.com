/**
 * amplify/functions/simplefinSync/classify-llm.ts
 *
 * LLM fallback classifier for bank/card transactions the rule table
 * (inferCategory) couldn't categorize. Rules run first and for free; only the
 * rows that would otherwise be "Uncategorized" reach this, batched into a
 * single Claude call per sync to keep cost negligible.
 *
 * Model: Claude Haiku 4.5 — cheap + fast, and picking one label from a fixed
 * list off a merchant string is squarely in its wheelhouse. Mirrors the
 * defensive-JSON approach used by invoiceProcessor/parsePaycheckPdf rather than
 * structured-output config, so it's robust to SDK version drift.
 *
 * Never throws: on any failure (missing key, API error, unparseable response)
 * it returns nulls so the caller falls back to leaving the row uncategorized —
 * the sync must never fail because classification did.
 */

import Anthropic from "@anthropic-ai/sdk";
import { CLASSIFIABLE_CATEGORIES } from "../../../components/finance/categories";

const MODEL = "claude-haiku-4-5";
const MAX_BATCH = 60; // keep prompts small; chunk larger sets

export type ClassifyItem = { description: string; amount: number };

/** Strip ```json fences and parse; returns null on any failure. */
function parseJsonLoose(text: string): unknown {
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // Last resort: grab the outermost array.
    const m = stripped.match(/\[[\s\S]*\]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

async function classifyChunk(
  anthropic: Anthropic,
  items: ClassifyItem[],
): Promise<(string | null)[]> {
  const cats = CLASSIFIABLE_CATEGORIES;
  const catSet = new Set(cats);
  const list = items
    .map(
      (it, i) =>
        `[${i}] ${it.amount < 0 ? "-" : "+"}$${Math.abs(it.amount).toFixed(2)}  ${(it.description ?? "").slice(0, 120)}`,
    )
    .join("\n");

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system:
      "You categorize a person's bank and credit-card transactions. For each numbered transaction, choose the single best-fitting category from the ALLOWED list based on the merchant/description and the sign (negative = money out, positive = money in). Use your knowledge of what real merchants are (e.g. 'SHELL' = Gas/Transport, 'PWP AMERICAN EXPR' = Travel, 'NOItalian' = Dining). If a transaction is genuinely unrecognizable, pick the closest reasonable category rather than refusing. Respond with ONLY a JSON array of objects, one per transaction, each {\"index\": <number>, \"category\": <one of the allowed categories>}. No prose, no code fences.",
    messages: [
      {
        role: "user",
        content: `ALLOWED categories: ${cats.join(", ")}\n\nTransactions:\n${list}`,
      },
    ],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const out: (string | null)[] = items.map(() => null);
  const parsed = parseJsonLoose(text);
  if (Array.isArray(parsed)) {
    for (const row of parsed) {
      const idx = (row as any)?.index;
      const cat = (row as any)?.category;
      if (
        typeof idx === "number" &&
        idx >= 0 &&
        idx < items.length &&
        typeof cat === "string" &&
        catSet.has(cat)
      ) {
        out[idx] = cat;
      }
    }
  }
  return out;
}

/**
 * Classify a batch of transactions. Returns an array aligned with `items`;
 * each entry is a category string or null (leave uncategorized). Never throws.
 */
export async function classifyTransactionsLLM(
  items: ClassifyItem[],
): Promise<(string | null)[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || items.length === 0) return items.map(() => null);

  const anthropic = new Anthropic({ apiKey: key });
  const results: (string | null)[] = [];
  try {
    for (let i = 0; i < items.length; i += MAX_BATCH) {
      const chunk = items.slice(i, i + MAX_BATCH);
      results.push(...(await classifyChunk(anthropic, chunk)));
    }
    return results;
  } catch (e) {
    console.error(
      "[simplefinSync] LLM classification failed:",
      (e as any)?.message ?? e,
    );
    return items.map(() => null);
  }
}
