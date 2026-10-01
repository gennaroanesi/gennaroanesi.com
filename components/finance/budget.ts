/**
 * components/finance/budget.ts
 *
 * The look-forward layer. Review (review.ts) answers "what happened"; this
 * answers "what's left". It deliberately owns no analytics of its own — the
 * baseline, the one-off exclusion and the per-category history all come from
 * review.ts unchanged — and adds only three things that face forward:
 *
 *   1. SCD resolution — which budget line was in force on a given date.
 *   2. Recurrence — a budget is written per month, quarter, year or as a
 *      one-off, and has to answer for whatever window the page asks about.
 *   3. Pace — spent against elapsed fraction of the window.
 *
 * Pure and dependency-free (no React, no client), like review.ts.
 */

import type { TransactionRecord, RecurringRecord } from "./data";
import { effectiveCategory, isExcludedFromPnl } from "./categories";
import type { DateRange } from "./review";

// ── Types ─────────────────────────────────────────────────────────────────────

export const FUNDING_SOURCES = ["SALARY", "BONUS", "RSU", "OTHER"] as const;
export type FundingSource = (typeof FUNDING_SOURCES)[number];

export const FUNDING_SOURCE_LABELS: Record<FundingSource, string> = {
  SALARY: "Salary",
  BONUS:  "Bonus",
  RSU:    "RSU",
  OTHER:  "Other",
};

export const BUDGET_KINDS = ["INCOME", "EXPENSE"] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];

/** EXPENSE unless stated — the overwhelming majority of lines, and the safe default. */
export function budgetKind(line: BudgetLine): BudgetKind {
  return line.kind === "INCOME" ? "INCOME" : "EXPENSE";
}

export const BUDGET_PERIODS = ["MONTHLY", "QUARTERLY", "ANNUALLY", "ONCE"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const BUDGET_PERIOD_LABELS: Record<BudgetPeriod, string> = {
  MONTHLY:   "Month",
  QUARTERLY: "Quarter",
  ANNUALLY:  "Year",
  ONCE:      "One-off",
};

/** How many months one occurrence of a recurrence covers. ONCE recurs never. */
const PERIOD_MONTHS: Record<Exclude<BudgetPeriod, "ONCE">, number> = {
  MONTHLY: 1, QUARTERLY: 3, ANNUALLY: 12,
};

/**
 * The recurrence a funding source usually implies — a form default, visible and
 * editable, not an inference. Salary lands monthly; equity arrives in lumps, so
 * a quarterly or annual figure describes it far better than a monthly one.
 */
export const DEFAULT_PERIOD: Record<FundingSource, BudgetPeriod> = {
  SALARY: "MONTHLY",
  BONUS:  "ANNUALLY",
  RSU:    "QUARTERLY",
  OTHER:  "MONTHLY",
};

/** The fields of a financeBudget row this module needs. */
export type BudgetLine = {
  id:             string;
  /** Stable across versions — the series identity, not the row id. */
  seriesId:       string;
  name:           string;
  /** INCOME lines declare a pool; EXPENSE lines draw on one. Absent = EXPENSE. */
  kind?:          string | null;
  /** Categories this bucket covers. A single-category budget is a bucket of one. */
  categories?:    (string | null)[] | null;
  fundingSource?: string | null;
  amount?:        number | null;
  period?:        string | null;
  rollover?:      boolean | null;
  effectiveFrom?: string | null;
  effectiveTo?:   string | null;
  active?:        boolean | null;
  label?:         string | null;
  notes?:         string | null;
};

/** Non-null, trimmed category names covered by a bucket version. */
export function bucketCategories(line: BudgetLine): string[] {
  return (line.categories ?? []).filter((c): c is string => !!c && c.trim() !== "").map((c) => c.trim());
}

// ── SCD resolution ────────────────────────────────────────────────────────────

/**
 * Is this line in force on `onDate`?
 *
 * `active` is enabled/paused, NOT is-current — currency is a function of the
 * dates alone. A null `effectiveTo` means open-ended (same convention as
 * financeRecurring.endDate); it is never a sentinel date.
 */
export function isInForce(line: BudgetLine, onDate: string): boolean {
  if (line.active === false) return false;
  const from = line.effectiveFrom;
  if (!from || from > onDate) return false;
  const to = line.effectiveTo;
  return to == null || to >= onDate;
}

/**
 * The versions in force on `onDate`, at most one per budget series.
 *
 * Where a series has overlapping rows — which a failed close-then-insert can
 * leave behind — the greatest `effectiveFrom` wins. That tiebreak is what makes
 * the insert-new-then-close-old write order safe: a half-applied change leaves
 * a harmless overlap rather than a gap with no budget at all.
 */
export function resolveBudgetLines(lines: BudgetLine[], onDate: string): BudgetLine[] {
  const best = new Map<string, BudgetLine>();
  for (const line of lines) {
    if (!isInForce(line, onDate)) continue;
    const cur = best.get(line.seriesId);
    if (!cur || (line.effectiveFrom ?? "") > (cur.effectiveFrom ?? "")) best.set(line.seriesId, line);
  }
  return [...best.values()];
}

// ── History validation ────────────────────────────────────────────────────────

export type BudgetHistoryIssue = {
  kind: "overlap" | "multiple-open" | "reversed-range" | "missing-from" | "shared-category";
  seriesId: string;
  name: string;
  detail: string;
  lineIds: string[];
};

/**
 * Invariant violations in a budget's version history.
 *
 * DynamoDB enforces none of this and writes come from a form rather than an ETL
 * job with a transaction, so the checks have to live in the app and be surfaced
 * on the page — not only in tests. Cheap at this table size (tens of rows).
 *
 * Gaps are NOT reported: a stretch with no budget is a legitimate state (the
 * category simply wasn't budgeted yet), and flagging it would make every new
 * line look broken.
 */
export function validateBudgetHistory(lines: BudgetLine[], onDate?: string): BudgetHistoryIssue[] {
  const issues: BudgetHistoryIssue[] = [];
  const bySeries = new Map<string, BudgetLine[]>();
  for (const l of lines) {
    if (l.active === false) continue;
    if (!bySeries.has(l.seriesId)) bySeries.set(l.seriesId, []);
    bySeries.get(l.seriesId)!.push(l);
  }

  for (const [seriesId, group] of bySeries) {
    const base = { seriesId, name: group[0].name };

    for (const l of group) {
      if (!l.effectiveFrom) {
        issues.push({ ...base, kind: "missing-from", lineIds: [l.id],
          detail: "no effectiveFrom — the version can never be in force" });
      } else if (l.effectiveTo != null && l.effectiveTo < l.effectiveFrom) {
        issues.push({ ...base, kind: "reversed-range", lineIds: [l.id],
          detail: `effectiveTo ${l.effectiveTo} is before effectiveFrom ${l.effectiveFrom}` });
      }
    }

    const open = group.filter((l) => l.effectiveFrom && l.effectiveTo == null);
    if (open.length > 1) {
      issues.push({ ...base, kind: "multiple-open", lineIds: open.map((l) => l.id),
        detail: `${open.length} open-ended versions; only the latest will ever apply` });
    }

    const dated = group
      .filter((l) => l.effectiveFrom && (l.effectiveTo == null || l.effectiveTo >= l.effectiveFrom))
      .sort((a, b) => (a.effectiveFrom ?? "").localeCompare(b.effectiveFrom ?? ""));
    for (let i = 1; i < dated.length; i++) {
      const prev = dated[i - 1], cur = dated[i];
      if (prev.effectiveTo == null || prev.effectiveTo >= (cur.effectiveFrom ?? "")) {
        issues.push({ ...base, kind: "overlap", lineIds: [prev.id, cur.id],
          detail: `${prev.effectiveFrom}→${prev.effectiveTo ?? "open"} overlaps ${cur.effectiveFrom}` });
      }
    }
  }

  // A category in two in-force buckets counts the same spend against both, and
  // a transaction cannot be split between them. Checked on a date because two
  // buckets may legitimately have covered it at different times.
  if (onDate) {
    // Keyed by kind as well as category: the same category in two spending
    // buckets double-counts, but appearing in both an income and an expense
    // bucket counts opposite directions of money and is not a conflict.
    const owner = new Map<string, BudgetLine>();
    for (const l of resolveBudgetLines(lines, onDate)) {
      for (const cat of bucketCategories(l)) {
        const key = `${budgetKind(l)}\u0000${cat}`;
        const prev = owner.get(key);
        if (prev && prev.seriesId !== l.seriesId) {
          issues.push({
            seriesId: l.seriesId, name: l.name, kind: "shared-category", lineIds: [prev.id, l.id],
            detail: `"${cat}" is also covered by "${prev.name}" — its spend would count against both`,
          });
        } else owner.set(key, l);
      }
    }
  }
  return issues;
}

/**
 * The two writes that record a budget change, in the order that fails safely.
 *
 * Insert-new-then-close-old: if the close fails, the series has two open rows
 * and resolution still returns the new one (greatest effectiveFrom wins). The
 * reverse order would leave a gap on a partial failure — the category silently
 * unbudgeted, which is the failure you cannot see on the page.
 *
 * Returns the patch for the superseded row and the fields for the new one;
 * the caller performs the mutations.
 */
export function planBudgetChange(
  current: BudgetLine | null,
  next: {
    seriesId: string;
    name: string;
    kind?: BudgetKind;
    categories: string[];
    amount: number;
    fundingSource: FundingSource;
    period: BudgetPeriod;
    rollover?: boolean;
    label?: string | null;
    notes?: string | null;
  },
  effectiveFrom: string,
): { insert: Omit<BudgetLine, "id">; close: { id: string; effectiveTo: string } | null } {
  const insert: Omit<BudgetLine, "id"> = {
    seriesId:      next.seriesId,
    name:          next.name,
    kind:          next.kind ?? "EXPENSE",
    categories:    next.categories,
    fundingSource: next.fundingSource,
    amount:        next.amount,
    period:        next.period,
    rollover:      next.rollover ?? false,
    effectiveFrom,
    effectiveTo:   null,
    active:        true,
    label:         next.label ?? null,
    notes:         next.notes ?? null,
  };
  const close = current ? { id: current.id, effectiveTo: previousDay(effectiveFrom) } : null;
  return { insert, close };
}

// ── Dates & windows ───────────────────────────────────────────────────────────

export function previousDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function monthStart(iso: string): string { return `${iso.slice(0, 7)}-01`; }

export function monthEnd(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const ms = new Date(`${toIso}T00:00:00Z`).getTime() - new Date(`${fromIso}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

/** How far through the window we are, 0..1. Clamped so a stale date can't exceed 1. */
export function elapsedFraction(window: DateRange, todayIso: string): number {
  const total = daysBetween(window.fromIso, window.toIso);
  if (total <= 0) return 1;
  const gone = daysBetween(window.fromIso, todayIso);
  return Math.min(1, Math.max(0, gone / total));
}

// ── Spend attribution ─────────────────────────────────────────────────────────

/**
 * Spend counted against budget lines for `window`, keyed by category.
 *
 * Excludes:
 *  - inflows and non-POSTED rows — a budget measures money actually gone;
 *  - group-tagged rows, which belong to their trip/project budget. Without this
 *    one trip eats Dining for the quarter and every other line reads as fine;
 *  - balance-sheet movement (Transfers, Credit Card Payment, Loan Payment,
 *    Investments). Paying a card is not spending — the charge it settles was
 *    already counted — so counting both double-counts every purchase. The same
 *    exclusion review.ts spendOf applies.
 */
export function spendByCategory(
  txs: TransactionRecord[],
  window: DateRange,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const tx of txs) {
    if (tx.status === "PENDING") continue;
    if ((tx as any).spendGroupId) continue;
    const amt = tx.amount ?? 0;
    if (amt >= 0) continue;
    const date = tx.date ?? "";
    if (date < window.fromIso || date > window.toIso) continue;
    const cat = effectiveCategory(tx);
    if (isExcludedFromPnl(cat)) continue;
    out.set(cat, (out.get(cat) ?? 0) + Math.abs(amt));
  }
  return out;
}

/**
 * Spend already committed inside a window by recurring rules, keyed by category.
 *
 * This DECOMPOSES a budget line, it never adds to it. A line is the single
 * source of truth for its category; the recurring rules say how much of it is
 * already spoken for ("Utilities $275 budgeted, $240 committed, $35 variable").
 * Adding the two would double-count every bill that is both a rule and a
 * historical category.
 */
export function committedByCategory(
  recurrings: RecurringRecord[],
  window: DateRange,
  occurrences: (r: RecurringRecord, from: string, to: string) => number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of recurrings) {
    if (r.active === false) continue;
    const amt = r.amount ?? 0;
    const isOutflow = r.type === "EXPENSE" || amt < 0;
    if (!isOutflow) continue;
    const cat = (r.category ?? "").trim();
    if (!cat) continue;
    const n = occurrences(r, window.fromIso, window.toIso);
    if (n <= 0) continue;
    out.set(cat, (out.get(cat) ?? 0) + Math.abs(amt) * n);
  }
  return out;
}

// ── Seeding from history ──────────────────────────────────────────────────────

export type CategorySeed = {
  category: string;
  /** Suggested budget: the median month, which resists the lumpiness averages hide. */
  median: number;
  min: number;
  max: number;
  /** (max − min) / median. High means the median is a poor summary — show it. */
  volatility: number;
  monthly: number[];
};

/**
 * Per-category monthly baselines from history, for pre-filling a new budget.
 *
 * Median, not mean: this ledger contains a $3,804 handbag and an $8,400 flight
 * booking, and a mean that includes either describes no month that ever
 * happened. `excludeTxIds` is intended to carry review.ts detectOneOffs().items
 * — the caller supplies them so this module needn't import the heavier analysis.
 * Group-tagged rows drop out for the same reason they do in spendByCategory.
 *
 * `volatility` is reported rather than smoothed away: a category swinging 7x
 * month to month cannot be budgeted from one number, and hiding that behind a
 * tidy median is how a budget becomes fiction.
 */
export function seedFromHistory(
  txs: TransactionRecord[],
  months: string[],
  excludeTxIds: Set<string> = new Set(),
  excludeCategories: Set<string> = new Set(),
): CategorySeed[] {
  const byCat = new Map<string, Map<string, number>>();
  for (const tx of txs) {
    if (tx.status === "PENDING") continue;
    if ((tx as any).spendGroupId) continue;
    if (excludeTxIds.has(tx.id)) continue;
    const amt = tx.amount ?? 0;
    if (amt >= 0) continue;
    const m = (tx.date ?? "").slice(0, 7);
    if (!months.includes(m)) continue;
    const cat = effectiveCategory(tx);
    if (isExcludedFromPnl(cat) || excludeCategories.has(cat)) continue;
    if (!byCat.has(cat)) byCat.set(cat, new Map());
    const mm = byCat.get(cat)!;
    mm.set(m, (mm.get(m) ?? 0) + Math.abs(amt));
  }
  const out: CategorySeed[] = [];
  for (const [category, mm] of byCat) {
    const monthly = months.map((m) => mm.get(m) ?? 0);
    const median = medianOf(monthly);
    const min = Math.min(...monthly), max = Math.max(...monthly);
    out.push({ category, median, min, max, monthly, volatility: median > 0 ? (max - min) / median : 0 });
  }
  return out.sort((a, b) => b.median - a.median);
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── The view ──────────────────────────────────────────────────────────────────

/** Position relative to the budgeted number — not a verdict. See computeLineView. */
export type BudgetStatus = "under" | "on" | "over";

export type BudgetLineView = {
  line: BudgetLine;
  window: DateRange;
  budgeted: number;
  /** Already spoken for by recurring rules — a decomposition of `budgeted`, not an addition. */
  committed: number;
  /** What's left to steer: budgeted − committed. Negative means the rules alone overrun the line. */
  variable: number;
  spent: number;
  remaining: number;
  elapsed: number;         // 0..1 through the window
  expectedByNow: number;   // budgeted × elapsed
  /** spent ÷ expectedByNow. 1.0 = exactly on pace; null before any time has passed. */
  pace: number | null;
  status: BudgetStatus;
  /** Spend per remaining day that would land exactly on budget. 0 when overspent. */
  safeDailyRemaining: number;
};

/** `over` only once the overspend is outside a 5% band, so a line doesn't flicker on day one. */
const PACE_TOLERANCE = 0.05;

export function computeLineView(
  line: BudgetLine,
  window: DateRange,
  actualByCat: Map<string, number>,
  committedByCat: Map<string, number>,
  todayIso: string,
): BudgetLineView {
  const cats = bucketCategories(line);
  const budgeted = budgetedForRange(line, window);
  const sumOver = (m: Map<string, number>) => cats.reduce((sum, c) => sum + (m.get(c) ?? 0), 0);
  const committed = sumOver(committedByCat);
  const spent = sumOver(actualByCat);
  const elapsed = elapsedFraction(window, todayIso);
  const expectedByNow = budgeted * elapsed;
  const pace = expectedByNow > 0 ? spent / expectedByNow : null;
  const remaining = budgeted - spent;
  const daysLeft = Math.max(0, daysBetween(todayIso, window.toIso));

  // Status states the FACT — above or below the budgeted number — and says
  // nothing about whether that is good. Over on spending is bad; over on income
  // is excellent. The judgment is the caller's, because only it knows the kind;
  // baking an inversion in here produced a field whose name meant the opposite
  // of itself half the time.
  let status: BudgetStatus = "on";
  if (pace != null) {
    if (pace > 1 + PACE_TOLERANCE) status = "over";
    else if (pace < 1 - PACE_TOLERANCE) status = "under";
  } else if (spent > budgeted) status = "over";

  return {
    line, window, budgeted,
    committed, variable: budgeted - committed,
    spent, remaining, elapsed, expectedByNow, pace, status,
    safeDailyRemaining: remaining > 0 && daysLeft > 0 ? remaining / daysLeft : 0,
  };
}

export type PoolView = {
  source: FundingSource;
  /** Declared inflow for the window — the sum of this source's INCOME lines. */
  forecast: number;
  /**
   * What actually arrived for this source, from review.ts summarizeIncomeSources.
   *
   * Measured per POOL, not per income line, for two reasons. Every inflow is
   * tagged with the same "Income" category, so categories cannot tell salary
   * from an RSU sale — only the income classifier can. And a household may
   * declare two salary lines, which would each claim the whole salary total if
   * actuals were attributed per line.
   */
  received: number;
  allocated: number;
  spent: number;
  /** forecast − allocated. Negative is the honest "over-committed" signal. */
  unallocated: number;
  /** False when nothing declares this pool — the page asks for an income line. */
  declared: boolean;
  views: BudgetLineView[];
  incomeViews: BudgetLineView[];
};

export function summarizePools(
  views: BudgetLineView[],
  receivedBySource: Partial<Record<FundingSource, number>> = {},
): PoolView[] {
  const bySource = new Map<FundingSource, BudgetLineView[]>();
  for (const v of views) {
    const src = (v.line.fundingSource ?? "OTHER") as FundingSource;
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src)!.push(v);
  }
  return FUNDING_SOURCES.filter((s) => bySource.has(s)).map((source) => {
    const all = bySource.get(source) ?? [];
    const incomes  = all.filter((v) => budgetKind(v.line) === "INCOME");
    const expenses = all.filter((v) => budgetKind(v.line) !== "INCOME");
    const forecast  = incomes.reduce((sum, v) => sum + v.budgeted, 0);
    const received  = receivedBySource[source] ?? 0;
    const allocated = expenses.reduce((sum, v) => sum + v.budgeted, 0);
    const spent     = expenses.reduce((sum, v) => sum + v.spent, 0);
    return {
      source, forecast, received, allocated, spent,
      unallocated: forecast - allocated,
      declared: incomes.length > 0,
      views: expenses,
      incomeViews: incomes,
    };
  });
}

/**
 * Categories with spend in the window that no in-force bucket covers.
 *
 * Surfaced as something to fix, never silently bucketed — there is deliberately
 * no default funding source, so an uncovered category is an incomplete budget
 * rather than an "Other" bucket nobody chose.
 */
export function unassignedCategories(
  spentByCat: Map<string, number>,
  inForce: BudgetLine[],
): Array<{ category: string; spent: number }> {
  const budgeted = new Set(inForce.flatMap((l) => bucketCategories(l)));
  return [...spentByCat.entries()]
    .filter(([cat]) => !budgeted.has(cat))
    .map(([category, spent]) => ({ category, spent }))
    .sort((a, b) => b.spent - a.spent);
}

// ── Income forecast ───────────────────────────────────────────────────────────

// ── Scaling a budget to an arbitrary range ────────────────────────────────────

/** Whole calendar months spanned by a range. July → 1, Q3 → 3, a year → 12. */
export function monthsSpanned(range: DateRange): number {
  const [fy, fm] = range.fromIso.split("-").map(Number);
  const [ty, tm] = range.toIso.split("-").map(Number);
  return (ty * 12 + tm) - (fy * 12 + fm) + 1;
}

/** Does the range start on a 1st and end on a month's last day? */
export function isMonthAligned(range: DateRange): boolean {
  return range.fromIso.endsWith("-01") && range.toIso === monthEnd(range.toIso);
}

/**
 * How many months of budget a range is worth.
 *
 * A calendar-aligned range counts whole months, so a quarter is exactly 3 and a
 * $500/month line is exactly $1,500 — no 1.018 drift from dividing days by
 * 30.44. A range that is NOT aligned must not use that count: "last 3 months"
 * touches four calendar months, and counting them would hand a $500 line a
 * $2,000 budget for a 93-day window. Those fall back to real elapsed months.
 */
export function monthsInRange(range: DateRange): number {
  if (isMonthAligned(range)) return monthsSpanned(range);
  return (daysBetween(range.fromIso, range.toIso) + 1) / 30.44;
}

/**
 * What a line budgets for an arbitrary range — which is what lets the page ask
 * "did I adhere in July?" of a budget written per month, per quarter or once.
 *
 * Recurring budgets scale by elapsed months over the recurrence length, so a
 * $600/quarter line is $200 for a month and $2,400 for a year. monthsInRange
 * keeps calendar-aligned ranges exact.
 *
 * ONCE does not scale: a one-off allowance belongs wholly to the period that
 * contains the day it took effect, and is zero everywhere else. Pro-rating it
 * would spread a single $5,000 decision across every month it touched and make
 * each of them look comfortably under budget.
 */
export function budgetedForRange(line: BudgetLine, range: DateRange): number {
  const amount = Math.abs(line.amount ?? 0);
  const period = (line.period ?? DEFAULT_PERIOD[(line.fundingSource ?? "OTHER") as FundingSource]) as BudgetPeriod;

  if (period === "ONCE") {
    const at = line.effectiveFrom;
    return at && at >= range.fromIso && at <= range.toIso ? amount : 0;
  }
  return amount * (monthsInRange(range) / PERIOD_MONTHS[period]);
}

// ── Actuals ───────────────────────────────────────────────────────────────────

/**
 * Money that actually moved in `range`, per category, in the direction the kind
 * implies: outflows for EXPENSE, inflows for INCOME.
 *
 * The INCOME direction is for enumerating which categories money arrives under,
 * NOT for attributing it to a budget — every inflow carries the same "Income"
 * category, so it cannot tell salary from an RSU sale. See PoolView.received.
 */
export function actualByCategory(
  txs: TransactionRecord[],
  range: DateRange,
  kind: BudgetKind,
): Map<string, number> {
  if (kind === "EXPENSE") return spendByCategory(txs, range);
  const out = new Map<string, number>();
  for (const tx of txs) {
    if (tx.status === "PENDING") continue;
    const amt = tx.amount ?? 0;
    if (amt <= 0) continue;
    const date = tx.date ?? "";
    if (date < range.fromIso || date > range.toIso) continue;
    const cat = effectiveCategory(tx);
    if (isExcludedFromPnl(cat)) continue;   // a card payment landing is not income
    out.set(cat, (out.get(cat) ?? 0) + amt);
  }
  return out;
}

// ── Which version applies to a window ─────────────────────────────────────────

/**
 * The date a window should be resolved at.
 *
 * Resolving at the window's START is wrong once a budget changes mid-period:
 * asking "did I adhere in July?" would answer with the version you began July
 * with, even though a later one governed most of it. Resolving at the END is
 * wrong for the period you are living in: a change you have already scheduled
 * for the 20th would take over the view on the 1st.
 *
 * So: the latest date in the window that has actually happened. A closed period
 * resolves at its end (the most recent version that governed it), the current
 * period resolves at today (what is in force right now), and a future period
 * resolves at its start (what it will open with).
 */
export function resolutionDate(window: DateRange, todayIso: string): string {
  if (todayIso < window.fromIso) return window.fromIso;
  if (todayIso > window.toIso)   return window.toIso;
  return todayIso;
}

/** Every version of a series that governed any part of `window`, oldest first. */
export function versionsInWindow(lines: BudgetLine[], window: DateRange): Map<string, BudgetLine[]> {
  const out = new Map<string, BudgetLine[]>();
  for (const l of lines) {
    if (l.active === false || !l.effectiveFrom) continue;
    if (l.effectiveFrom > window.toIso) continue;
    if (l.effectiveTo != null && l.effectiveTo < window.fromIso) continue;
    if (!out.has(l.seriesId)) out.set(l.seriesId, []);
    out.get(l.seriesId)!.push(l);
  }
  for (const [, group] of out) {
    group.sort((a, b) => (a.effectiveFrom ?? "").localeCompare(b.effectiveFrom ?? ""));
  }
  return out;
}

// ── Inventory ─────────────────────────────────────────────────────────────────

export type BudgetSeries = {
  seriesId: string;
  /** Name from the newest version — what the budget is called now. */
  name: string;
  kind: BudgetKind;
  fundingSource: string;
  /** Newest version by effectiveFrom, whether or not it is in force yet. */
  latest: BudgetLine;
  /** Every version, newest first. */
  versions: BudgetLine[];
  /** True when `latest` has started and has not ended. */
  liveNow: boolean;
  /** Set when the newest version has not started yet — a staged future budget. */
  startsOn: string | null;
  /** Set when the series has ended and nothing replaced it. */
  endedOn: string | null;
};

/**
 * Every budget that exists, in force or not — the answer to "what budgets do I
 * have?", which a period-scoped view cannot give. A series staged for next year
 * or retired last spring is invisible in every window yet still very much
 * something the user owns and needs to find.
 */
export function listBudgetSeries(lines: BudgetLine[], todayIso: string): BudgetSeries[] {
  const bySeries = new Map<string, BudgetLine[]>();
  for (const l of lines) {
    if (!bySeries.has(l.seriesId)) bySeries.set(l.seriesId, []);
    bySeries.get(l.seriesId)!.push(l);
  }
  const out: BudgetSeries[] = [];
  for (const [seriesId, group] of bySeries) {
    const versions = [...group].sort((a, b) => (b.effectiveFrom ?? "").localeCompare(a.effectiveFrom ?? ""));
    const latest = versions[0];
    const started = !!latest.effectiveFrom && latest.effectiveFrom <= todayIso;
    const ended = latest.effectiveTo != null && latest.effectiveTo < todayIso;
    out.push({
      seriesId,
      name: latest.name ?? "(unnamed)",
      kind: budgetKind(latest),
      fundingSource: latest.fundingSource ?? "OTHER",
      latest,
      versions,
      liveNow: latest.active !== false && started && !ended,
      startsOn: started ? null : (latest.effectiveFrom ?? null),
      endedOn: ended ? (latest.effectiveTo ?? null) : null,
    });
  }
  return out.sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === "INCOME" ? -1 : 1)
    || a.name.localeCompare(b.name));
}
