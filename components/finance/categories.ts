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
