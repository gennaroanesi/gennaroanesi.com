/**
 * components/finance/categories.ts
 *
 * Rule-based transaction category inference. The `financeTransaction.category`
 * field is free-text and mostly empty on bank imports, so the Review page's
 * by-category breakdowns would be meaningless without a fallback. This module
 * infers a category from the transaction's description/type using an ordered
 * rule table (first match wins).
 *
 * Rules live in category-rules.json — a single source of truth shared with
 * scripts/infer-categories.mjs (which persists inferred categories to the DB).
 * Edit the JSON, not a second copy here.
 *
 * Pure + dependency-free (no React/client) so it can be used at import time,
 * on the review page, and conceptually anywhere.
 */

import rulesData from "./category-rules.json";

export type CategoryRule = { pattern: string; category: string };

/** Ordered inference rules (first match wins). */
export const CATEGORY_RULES: CategoryRule[] = (rulesData.rules ?? []) as CategoryRule[];

/** Bucket used when nothing matches and the field is empty. */
export const UNCATEGORIZED = "Uncategorized";

/** Investment bucket — BUY/SELL aren't P&L, surfaced in the Stocks section instead. */
export const INVESTMENT_CATEGORY = "Investments";

/**
 * Categories that are NOT spending or earning — money moving between the user's
 * own accounts (transfers), paying down a card (the charge was already counted),
 * or investing. Excluded from the Review's income/expense P&L so totals reflect
 * real cash in/out, not internal plumbing.
 */
export const EXCLUDED_FROM_PNL = new Set<string>([
  "Transfers",
  "Credit Card Payment",
  "Loan Payment", // debt paydown — moves cash → equity, net-worth-affecting, not consumption
  INVESTMENT_CATEGORY,
]);

export function isExcludedFromPnl(category: string): boolean {
  return EXCLUDED_FROM_PNL.has(category);
}

type InferInput = {
  description?: string | null;
  type?: string | null;
  amount?: number | null;
  category?: string | null;
};

/**
 * Match a pattern against text. `/.../flags` is treated as a regex; anything
 * else is a case-insensitive substring. Mirrors matchesUserPattern in
 * _shared.tsx but kept local so this module stays dependency-free.
 */
function patternMatches(pattern: string, text: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  const regexForm = p.match(/^\/(.+)\/([imsu]*)$/);
  if (regexForm) {
    try {
      return new RegExp(regexForm[1], regexForm[2]).test(text);
    } catch {
      /* fall through to substring */
    }
  }
  return text.toLowerCase().includes(p.toLowerCase());
}

/**
 * Infer a category for a transaction. Returns null when no rule matches and the
 * type carries no implicit bucket — callers decide whether to fall back to
 * UNCATEGORIZED. TRANSFER → "Transfers", BUY/SELL → "Investments" regardless of
 * description (those are structural, not spending).
 */
export function inferCategory(tx: InferInput): string | null {
  if (tx.type === "TRANSFER") return "Transfers";
  if (tx.type === "BUY" || tx.type === "SELL") return INVESTMENT_CATEGORY;

  const desc = (tx.description ?? "").trim();
  if (desc) {
    for (const rule of CATEGORY_RULES) {
      if (patternMatches(rule.pattern, desc)) return rule.category;
    }
  }
  // Income with no rule hit still reads as income.
  if (tx.type === "INCOME") return "Income";
  return null;
}

/**
 * The category to display/group by for a transaction in the Review: the
 * user-set category wins; otherwise inferred; otherwise "Uncategorized".
 * Never mutates the record — purely a read-path helper.
 */
export function effectiveCategory(tx: InferInput): string {
  const set = (tx.category ?? "").trim();
  if (set) return set;
  return inferCategory(tx) ?? UNCATEGORIZED;
}

// ── Line-item itemization ─────────────────────────────────────────────────────

/** One itemized line within a transaction (e.g. a single Amazon order item). */
export type LineItem = {
  name?: string | null;
  amount: number;          // item cost, same sign convention as the tx (usually positive magnitude)
  category: string;
  quantity?: number | null;
};

type ItemizedInput = InferInput & { lineItems?: string | null };

/**
 * Parse the JSON-stringified `lineItems` field into a validated array, or null
 * when absent/empty/malformed. Kept lenient: rows missing a numeric amount or a
 * category are dropped rather than throwing, so a partial import can't break the
 * whole breakdown.
 */
export function parseLineItems(tx: ItemizedInput): LineItem[] | null {
  const raw = (tx.lineItems ?? "").trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const items: LineItem[] = [];
  for (const it of parsed as Record<string, unknown>[]) {
    const amount = Number(it?.amount);
    const category = String(it?.category ?? "").trim();
    if (!Number.isFinite(amount) || !category) continue;
    items.push({
      name: (it?.name as string) ?? null,
      amount: Math.abs(amount),
      category,
      quantity: it?.quantity == null ? null : Number(it.quantity),
    });
  }
  return items.length ? items : null;
}

/**
 * Distribute a transaction's counted magnitude `magnitude` (positive) across
 * category buckets. When the transaction carries valid `lineItems`, the split
 * follows the items' categories — item amounts are scaled proportionally so the
 * contributions sum EXACTLY to `magnitude` even if the raw item total differs
 * (tax, shipping, partial imports). Otherwise it returns a single bucket keyed by
 * `effectiveCategory(tx)`. This is the one place callers should use so item-level
 * and transaction-level rows are summed identically.
 */
export function categoryContributions(
  tx: ItemizedInput,
  magnitude: number,
): { category: string; amount: number }[] {
  const items = parseLineItems(tx);
  if (!items) return [{ category: effectiveCategory(tx), amount: magnitude }];

  const rawSum = items.reduce((s, i) => s + i.amount, 0);
  if (rawSum <= 0) return [{ category: effectiveCategory(tx), amount: magnitude }];

  // Merge same-category items, then scale to the transaction magnitude.
  const byCat = new Map<string, number>();
  for (const it of items) byCat.set(it.category, (byCat.get(it.category) ?? 0) + it.amount);
  const scale = magnitude / rawSum;
  return [...byCat.entries()].map(([category, amount]) => ({ category, amount: amount * scale }));
}

/** True when a transaction has a usable itemization. */
export function hasLineItems(tx: ItemizedInput): boolean {
  return parseLineItems(tx) != null;
}
