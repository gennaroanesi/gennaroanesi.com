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

/**
 * Normalize raw financeCategoryRule DB rows into the ordered, active-only list
 * inferCategory expects (first-match-wins by sortOrder asc). Used by both the
 * client and the sync Lambda; falls back to the bundled CATEGORY_RULES when the
 * table is empty so classification never silently stops working.
 */
export function rulesFromDbRows(
  rows: Array<{ pattern?: string | null; category?: string | null; sortOrder?: number | null; active?: boolean | null }>,
): CategoryRule[] {
  const usable = rows.filter((r) => r.active !== false && r.pattern && r.category);
  if (usable.length === 0) return CATEGORY_RULES;
  return usable
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((r) => ({ pattern: r.pattern as string, category: r.category as string }));
}

/** Bucket used when nothing matches and the field is empty. */
export const UNCATEGORIZED = "Uncategorized";

/** Investment bucket — BUY/SELL aren't P&L, surfaced in the Stocks section instead. */
export const INVESTMENT_CATEGORY = "Investments";

/**
 * Money coming back for spend that already posted: merchant refunds, returned
 * merchandise, and card statement credits (AMEX Platinum perks, United annual
 * credits). Sign-determined, not description-determined — see inferCategory.
 */
export const REFUND_CATEGORY = "Refund";

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

/** All distinct categories referenced by the rule table, sorted. */
export const ALL_CATEGORIES: string[] = [
  ...new Set(CATEGORY_RULES.map((r) => r.category)),
].sort();

/**
 * Categories an LLM fallback classifier may assign from a description alone.
 * Excludes the structural buckets (Transfers, Credit Card Payment, Loan
 * Payment, Investments) — those are determined by transaction TYPE, not
 * merchant text, so letting the model pick them from a description invites
 * misclassification. Refund is excluded for the same reason: it's decided by
 * the direction of the money, not by the merchant name (a "Nike" row is
 * Apparel when it's an outflow and a Refund when it's an inflow). Shared by
 * the simplefinSync Lambda and the reclassify-uncategorized backfill script so
 * both offer the same choices.
 */
export const CLASSIFIABLE_CATEGORIES: string[] = ALL_CATEGORIES.filter(
  (c) => !EXCLUDED_FROM_PNL.has(c) && c !== REFUND_CATEGORY,
);

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
export function patternMatches(pattern: string, text: string): boolean {
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
 * Payment-processor prefixes that bury the real merchant name — e.g.
 * `PAYPAL *FALKEUSAONL`, `SP AXIL`, `AplPay PORTE NOIRE`, `PwP AMERICAN EXPR`.
 * Rules key on merchant names, so these prefixes otherwise defeat every rule and
 * dump the row into Uncategorized.
 */
const PROCESSOR_PREFIX =
  /^(paypal\s*\*|sq\s*\*|sp\s+|aplpay\s+|pwp\s+|dojo\s*\*|zettle\s*\*|tst\s*\*|py\s*\*|ic\*\s*)+/i;

/** Merchant name with any payment-processor prefix removed. */
export function stripProcessorPrefix(description: string): string {
  return description.replace(PROCESSOR_PREFIX, "").trim();
}

/**
 * Buckets a money-IN row must NOT be rewritten to Refund. The structural ones
 * are already direction-agnostic (a card payment is a card payment whichever
 * way it points), and Income/Refund are the two outcomes the refund rewrite
 * chooses between — rewriting them would either loop or destroy real income.
 */
const NON_REFUNDABLE = new Set<string>([
  ...EXCLUDED_FROM_PNL,
  "Income",
  REFUND_CATEGORY,
]);

/**
 * Is this row money coming IN? Mirrors the Review's outflow test (review.ts
 * spendOf) so classification and P&L agree on direction: an explicit EXPENSE is
 * never an inflow, an explicit INCOME always is, and otherwise the sign decides.
 *
 * `amount` is optional on InferInput — a caller that passes only a type (the
 * sync Lambda's engine.ts does, because it derives type from the sign anyway)
 * still gets the right answer.
 */
function isInflow(tx: InferInput): boolean {
  if (tx.type === "EXPENSE") return false;
  if (tx.type === "INCOME") return true;
  return (tx.amount ?? 0) > 0;
}

/**
 * Infer a category for a transaction. Returns null when no rule matches and the
 * type carries no implicit bucket — callers decide whether to fall back to
 * UNCATEGORIZED. TRANSFER → "Transfers", BUY/SELL → "Investments" regardless of
 * description (those are structural, not spending).
 *
 * Each rule is tested against the raw description AND a prefix-stripped variant,
 * in rule order. Testing both (rather than only the stripped form) keeps
 * prefix-dependent rules working — `tst\*` is itself the signal that a row is a
 * Toast restaurant charge.
 *
 * Direction matters for one case: a money-IN row that matches a *spending* rule
 * is a refund of that spend, not new spend and not income. "Nike" is Apparel as
 * an outflow and Refund as an inflow; likewise a Trupanion reimbursement, an
 * Amazon return, or a reversed fee. The rule table can't express this on its own
 * because it only ever sees the description — a returned pair of shoes and a new
 * pair of shoes carry the identical merchant string. Rules that resolve to a
 * structural bucket or to Income are left alone (see NON_REFUNDABLE), so payroll,
 * dividends, transfers and card payments are unaffected.
 */
export function inferCategory(tx: InferInput, rules: CategoryRule[] = CATEGORY_RULES): string | null {
  if (tx.type === "TRANSFER") return "Transfers";
  if (tx.type === "BUY" || tx.type === "SELL") return INVESTMENT_CATEGORY;

  const desc = (tx.description ?? "").trim();
  if (desc) {
    const stripped = stripProcessorPrefix(desc);
    for (const rule of rules) {
      if (
        patternMatches(rule.pattern, desc) ||
        (stripped !== desc && patternMatches(rule.pattern, stripped))
      ) {
        return isInflow(tx) && !NON_REFUNDABLE.has(rule.category)
          ? REFUND_CATEGORY
          : rule.category;
      }
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
