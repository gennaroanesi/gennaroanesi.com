/**
 * components/finance/review.ts
 *
 * Pure period-aggregation logic for the Monthly / Yearly Review page. No React,
 * no client — takes already-fetched records and returns view-model objects the
 * page renders. Unit-testable in isolation.
 *
 * Income vs. expense model (deliberate, per feedback):
 * - INCOME = the user's payroll deposits into CHECKING accounts that match a
 *   salary pattern (default: "META"). NOT transaction sign (which wrongly
 *   counted card payments/refunds) and NOT the paycheck ledger. Spouse income
 *   is out of scope. See SALARY_DESCRIPTION_PATTERNS / summarizeIncome.
 * - EXPENSES = real outflows, EXCLUDING transfers, credit-card *payments*,
 *   investment trades, and LOAN-account rows. See expenseMagnitude.
 * - Outflows that match a financeRecurring rule (mortgage, car, insurance, …)
 *   are pulled OUT of the discretionary category/account breakdown and shown in
 *   their own Recurring section. See matchTxToRecurring / summarizeRecurring.
 * - Credit-card *charges* get their own section + ticket-size distribution,
 *   since that's where purchase-size analysis is meaningful.
 */

import type {
  TransactionRecord,
  AccountRecord,
  GoalRecord,
  HoldingLotRecord,
  TickerQuoteRecord,
  HoldingSnapshotRecord,
  GoalSnapshotRecord,
  RecurringRecord,
} from "./_shared";
import {
  realizedGain,
  matchesUserPattern,
  findRecurringMatches,
  RECURRING_MATCH_AUTO_THRESHOLD,
  advanceByCadence,
  type Cadence,
} from "./_shared";
import {
  buildQuoteMap,
  tickerAggregate,
  uniqueTickers,
  type QuoteMap,
} from "./finance-core";
import { effectiveCategory, isExcludedFromPnl } from "./categories";

// ── Period & range ────────────────────────────────────────────────────────────

export type Period =
  | { kind: "month"; year: number; month: number } // month: 1–12
  | { kind: "year"; year: number };

export type DateRange = { fromIso: string; toIso: string; label: string };

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function lastDayOfMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function periodRange(p: Period): DateRange {
  if (p.kind === "month") {
    const from = `${p.year}-${pad2(p.month)}-01`;
    const to = `${p.year}-${pad2(p.month)}-${pad2(lastDayOfMonth(p.year, p.month))}`;
    return { fromIso: from, toIso: to, label: `${MONTH_NAMES[p.month - 1]} ${p.year}` };
  }
  return { fromIso: `${p.year}-01-01`, toIso: `${p.year}-12-31`, label: String(p.year) };
}

export function ytdRange(p: Period): DateRange {
  const r = periodRange(p);
  return { fromIso: `${p.year}-01-01`, toIso: r.toIso, label: `${p.year} YTD` };
}

function inRange(dateIso: string | null | undefined, r: DateRange): boolean {
  if (!dateIso) return false;
  return dateIso >= r.fromIso && dateIso <= r.toIso;
}

/** Posted (i.e. not explicitly PENDING) — null/undefined status counts as posted. */
function isPosted(tx: TransactionRecord): boolean {
  return tx.status !== "PENDING";
}

// ── Shared bucket shapes ──────────────────────────────────────────────────────

export type CategoryBucket = { category: string; amount: number; count: number };
export type AccountBucket = { accountId: string; accountName: string; type: string | null; amount: number; count: number };

function sortedByAmount<T extends { amount: number }>(m: Map<string, T>): T[] {
  return [...m.values()].sort((a, b) => b.amount - a.amount);
}

// ── Income (salary deposits into checking) ────────────────────────────────────

/** Description patterns that mark a checking deposit as the user's salary.
 *  Substring (case-insensitive) or /regex/ form. Tune as payroll memos change. */
export const SALARY_DESCRIPTION_PATTERNS = ["/meta/i"];

function isSalaryDeposit(tx: TransactionRecord, acctById: Map<string, AccountRecord>): number | null {
  if (!isPosted(tx)) return null;
  if (tx.type === "TRANSFER" || tx.type === "BUY" || tx.type === "SELL") return null;
  if (tx.toAccountId) return null;
  const amt = tx.amount ?? 0;
  if (amt <= 0) return null;                                   // deposits only
  if (acctById.get(tx.accountId)?.type !== "CHECKING") return null;
  const desc = tx.description ?? "";
  if (!SALARY_DESCRIPTION_PATTERNS.some((p) => matchesUserPattern(p, desc))) return null;
  return amt;
}

export type IncomeLine = { id: string; date: string; description: string; accountName: string; amount: number };
export type IncomeSummary = { total: number; count: number; deposits: IncomeLine[] };

export function summarizeIncome(
  txs: TransactionRecord[],
  accounts: AccountRecord[],
  range: DateRange,
): IncomeSummary {
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const deposits: IncomeLine[] = [];
  let total = 0;
  for (const tx of txs) {
    if (!inRange(tx.date, range)) continue;
    const v = isSalaryDeposit(tx, acctById);
    if (v == null) continue;
    total += v;
    deposits.push({
      id: tx.id,
      date: tx.date as string,
      description: tx.description ?? "Salary",
      accountName: acctById.get(tx.accountId)?.name ?? "Checking",
      amount: v,
    });
  }
  deposits.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { total, count: deposits.length, deposits };
}

// ── Expense predicate ─────────────────────────────────────────────────────────

/** Counted-expense magnitude (positive) or null if not real spending. */
function expenseMagnitude(tx: TransactionRecord, acctById: Map<string, AccountRecord>): number | null {
  if (!isPosted(tx)) return null;
  if (tx.type === "TRANSFER" || tx.type === "BUY" || tx.type === "SELL") return null;
  if (tx.toAccountId) return null;                              // transfer to own account
  const amt = tx.amount ?? 0;
  const isOutflow = tx.type === "EXPENSE" || amt < 0;
  if (!isOutflow) return null;
  const acc = acctById.get(tx.accountId);
  if (acc?.type === "LOAN") return null;                        // debt mechanics, see Loans
  if (isExcludedFromPnl(effectiveCategory(tx))) return null;    // transfers / card payments / investments
  return Math.abs(amt);
}

// ── Recurring matching ────────────────────────────────────────────────────────

/**
 * Calendar-accurate count of a rule's scheduled occurrences within the range.
 * Steps from the rule's anchor (startDate, else nextDate) by its cadence — so
 * an annual rule billed in May counts 1 only when the range includes its May
 * anniversary, and 0 otherwise. No proration.
 */
function countOccurrencesInRange(rule: RecurringRecord, range: DateRange): number {
  const cadence = rule.cadence as Cadence | null;
  const anchor = (rule.startDate as string | null) ?? (rule.nextDate as string | null);
  if (!cadence || !anchor) return 0;
  const end = (rule.endDate as string | null) ?? null;
  let cur = anchor;
  let count = 0;
  let guard = 0;
  while (cur <= range.toIso && guard < 6000) {
    guard++;
    if (cur >= range.fromIso && (!end || cur <= end)) count++;
    const next = advanceByCadence(cur, cadence, anchor);
    if (next <= cur) break;   // safety: never advance → bail
    cur = next;
  }
  return count;
}

/** The recurring rule a transaction realizes: explicit link wins, else a
 *  high-confidence fuzzy match against the user's rules. */
function matchTxToRecurring(tx: TransactionRecord, recurrings: RecurringRecord[]): RecurringRecord | null {
  if (tx.recurringId) return recurrings.find((r) => r.id === tx.recurringId) ?? null;
  const cands = findRecurringMatches(tx, recurrings, RECURRING_MATCH_AUTO_THRESHOLD);
  return cands[0]?.rule ?? null;
}

export type RecurringItem = {
  ruleId: string;
  description: string;
  cadence: string | null;
  category: string | null;
  expected: number;       // expected spend across the range (per cadence × range length)
  actual: number;         // matched actual spend in the range
  count: number;          // # matched transactions
};
export type RecurringSummary = { items: RecurringItem[]; total: number };

export function summarizeRecurring(
  txs: TransactionRecord[],
  recurrings: RecurringRecord[],
  accounts: AccountRecord[],
  range: DateRange,
): RecurringSummary {
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const expenseRules = recurrings.filter((r) => r.type === "EXPENSE" && r.active !== false);

  const actualByRule = new Map<string, { actual: number; count: number }>();
  for (const tx of txs) {
    if (!inRange(tx.date, range)) continue;
    const v = expenseMagnitude(tx, acctById);
    if (v == null) continue;
    const rule = matchTxToRecurring(tx, recurrings);
    if (!rule || rule.type !== "EXPENSE") continue;
    const cur = actualByRule.get(rule.id) ?? { actual: 0, count: 0 };
    cur.actual += v; cur.count += 1; actualByRule.set(rule.id, cur);
  }

  const items: RecurringItem[] = expenseRules.map((r) => {
    // Expected = rule amount × its actual scheduled occurrences in the window.
    const occurrences = countOccurrencesInRange(r, range);
    const expected = Math.abs(r.amount ?? 0) * occurrences;
    const a = actualByRule.get(r.id) ?? { actual: 0, count: 0 };
    return {
      ruleId: r.id,
      description: r.description ?? "Recurring",
      cadence: (r.cadence as string) ?? null,
      category: r.category ?? null,
      expected,
      actual: a.actual,
      count: a.count,
    };
  });

  // Surface rules with activity first, then large expected (likely missing/upcoming).
  items.sort((a, b) => (b.actual - a.actual) || (b.expected - a.expected));
  const total = items.reduce((s, i) => s + i.actual, 0);
  return { items, total };
}

// ── Unmatched recurring detection ─────────────────────────────────────────────
// Surfaces charges that LOOK like a fixed recurring obligation (repeat across
// months, stable amount) but match no financeRecurring rule — so it's obvious
// what rules to add. Scans a trailing window (recurrence needs history), not
// just the selected period.

/** Coarse merchant key: strip digits/punctuation/noise words, keep first tokens. */
function normalizeMerchant(desc: string): string {
  return desc
    .toUpperCase()
    .replace(/[0-9]+/g, " ")
    .replace(/[^A-Z ]+/g, " ")
    .replace(/\b(POS|PURCHASE|PAYMENT|PMT|DEBIT|CARD|ACH|RECURRING|AUTOPAY|AUTO PAY|WEB|ONLINE|XX+)\b/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
}

function cadenceLabelFromGap(medianGapDays: number): string {
  if (medianGapDays <= 10) return "~weekly";
  if (medianGapDays <= 20) return "~biweekly";
  if (medianGapDays <= 45) return "~monthly";
  if (medianGapDays <= 135) return "~quarterly";
  if (medianGapDays <= 270) return "~semiannually";
  return "~annually";
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type RecurringSuggestion = {
  key: string;
  label: string;
  accountName: string;
  occurrences: number;
  months: number;
  medianAmount: number;
  cadence: string;
  lastDate: string;
};

/**
 * @param asOfIso  end of the trailing window (usually the period's toIso)
 * @param windowMonths  how far back to look (default 12)
 */
export function detectRecurringSuggestions(
  txs: TransactionRecord[],
  accounts: AccountRecord[],
  recurrings: RecurringRecord[],
  asOfIso: string,
  windowMonths = 12,
  maxResults = 8,
): RecurringSuggestion[] {
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const fromDate = new Date(`${asOfIso}T00:00:00Z`);
  fromDate.setUTCMonth(fromDate.getUTCMonth() - windowMonths);
  const fromIso = fromDate.toISOString().slice(0, 10);
  const window: DateRange = { fromIso, toIso: asOfIso, label: "" };

  type Group = { label: string; accountName: string; dates: string[]; amounts: number[] };
  const groups = new Map<string, Group>();

  for (const tx of txs) {
    if (!inRange(tx.date, window)) continue;
    const v = expenseMagnitude(tx, acctById);
    if (v == null) continue;
    if (matchTxToRecurring(tx, recurrings)) continue;          // already covered by a rule
    const desc = (tx.description ?? "").trim();
    const key = normalizeMerchant(desc);
    if (!key) continue;
    const g = groups.get(key) ?? {
      label: desc || key,
      accountName: acctById.get(tx.accountId)?.name ?? "Unknown",
      dates: [], amounts: [],
    };
    g.dates.push(tx.date as string);
    g.amounts.push(v);
    groups.set(key, g);
  }

  const out: RecurringSuggestion[] = [];
  for (const [key, g] of groups) {
    const months = new Set(g.dates.map((d) => d.slice(0, 7)));
    if (g.amounts.length < 3 || months.size < 3) continue;     // needs real repetition
    const med = median(g.amounts);
    if (med < 15) continue;                                    // ignore trivial amounts
    // Stability: ≥60% of charges within ±20% of the median (filters variable spend like groceries).
    const stable = g.amounts.filter((a) => Math.abs(a - med) <= 0.2 * med).length;
    if (stable / g.amounts.length < 0.6) continue;
    const sortedDates = [...g.dates].sort();
    const gaps: number[] = [];
    for (let i = 1; i < sortedDates.length; i++) {
      gaps.push(Math.round((Date.parse(`${sortedDates[i]}T00:00:00Z`) - Date.parse(`${sortedDates[i - 1]}T00:00:00Z`)) / 86400000));
    }
    out.push({
      key,
      label: g.label,
      accountName: g.accountName,
      occurrences: g.amounts.length,
      months: months.size,
      medianAmount: med,
      cadence: cadenceLabelFromGap(median(gaps)),
      lastDate: sortedDates[sortedDates.length - 1],
    });
  }

  out.sort((a, b) => b.medianAmount * b.occurrences - a.medianAmount * a.occurrences);
  return out.slice(0, maxResults);
}

// ── Expenses (discretionary breakdown) ─────────────────────────────────────────

export type ExpenseSummary = {
  total: number;             // ALL counted expenses (recurring + discretionary)
  discretionaryTotal: number;
  recurringTotal: number;
  txCount: number;           // discretionary tx count
  byCategory: CategoryBucket[];   // discretionary only
  byAccount: AccountBucket[];     // discretionary only
};

export function summarizeExpenses(
  txs: TransactionRecord[],
  accounts: AccountRecord[],
  recurrings: RecurringRecord[],
  range: DateRange,
): ExpenseSummary {
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  let total = 0;
  let recurringTotal = 0;
  let txCount = 0;
  const byCategory = new Map<string, CategoryBucket>();
  const byAccount = new Map<string, AccountBucket>();

  for (const tx of txs) {
    if (!inRange(tx.date, range)) continue;
    const v = expenseMagnitude(tx, acctById);
    if (v == null) continue;
    total += v;

    const rule = matchTxToRecurring(tx, recurrings);
    if (rule && rule.type === "EXPENSE") { recurringTotal += v; continue; }  // shown in Recurring section

    txCount += 1;
    const acc = acctById.get(tx.accountId);
    const cat = effectiveCategory(tx);
    const cb = byCategory.get(cat) ?? { category: cat, amount: 0, count: 0 };
    cb.amount += v; cb.count += 1; byCategory.set(cat, cb);
    const ab = byAccount.get(tx.accountId) ?? {
      accountId: tx.accountId, accountName: acc?.name ?? "Unknown account",
      type: (acc?.type as string) ?? null, amount: 0, count: 0,
    };
    ab.amount += v; ab.count += 1; byAccount.set(tx.accountId, ab);
  }

  return {
    total,
    recurringTotal,
    discretionaryTotal: total - recurringTotal,
    txCount,
    byCategory: sortedByAmount(byCategory),
    byAccount: sortedByAmount(byAccount),
  };
}

// ── Credit-card spending + ticket-size distribution ────────────────────────────

export type ExpenseLine = { id: string; date: string; description: string; accountName: string; category: string; amount: number };
export type AmountBucket = { label: string; count: number; amount: number };

export type CreditCardReview = {
  total: number;
  perCard: AccountBucket[];
  buckets: AmountBucket[];          // by ticket size, across all cards
  topTransactions: ExpenseLine[];
  count: number;
  medianTicket: number;
  top5Share: number | null;
  countForHalf: number;
};

const SIZE_EDGES: { label: string; max: number }[] = [
  { label: "< $25", max: 25 },
  { label: "$25–100", max: 100 },
  { label: "$100–500", max: 500 },
  { label: "$500–2k", max: 2000 },
  { label: "$2k+", max: Infinity },
];

/** Credit-card charges only (account.type === CREDIT, real spending). Includes
 *  recurring subscriptions billed to a card — this lens is about purchase size. */
export function summarizeCreditCards(
  txs: TransactionRecord[],
  accounts: AccountRecord[],
  range: DateRange,
  topN = 10,
): CreditCardReview {
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const lines: ExpenseLine[] = [];
  const perCard = new Map<string, AccountBucket>();

  for (const tx of txs) {
    if (!inRange(tx.date, range)) continue;
    const acc = acctById.get(tx.accountId);
    if (acc?.type !== "CREDIT") continue;
    const v = expenseMagnitude(tx, acctById);
    if (v == null) continue;
    lines.push({
      id: tx.id, date: tx.date as string,
      description: tx.description ?? "(no description)",
      accountName: acc?.name ?? "Card",
      category: effectiveCategory(tx),
      amount: v,
    });
    const b = perCard.get(tx.accountId) ?? {
      accountId: tx.accountId, accountName: acc?.name ?? "Card",
      type: "CREDIT", amount: 0, count: 0,
    };
    b.amount += v; b.count += 1; perCard.set(tx.accountId, b);
  }

  const buckets: AmountBucket[] = SIZE_EDGES.map((e) => ({ label: e.label, count: 0, amount: 0 }));
  for (const l of lines) {
    const idx = SIZE_EDGES.findIndex((e) => l.amount < e.max);
    const b = buckets[idx === -1 ? buckets.length - 1 : idx];
    b.count += 1; b.amount += l.amount;
  }

  const sorted = [...lines].sort((a, b) => b.amount - a.amount);
  const total = lines.reduce((s, l) => s + l.amount, 0);

  let cum = 0, countForHalf = 0;
  for (const l of sorted) { if (cum >= total / 2) break; cum += l.amount; countForHalf += 1; }
  const top5 = sorted.slice(0, 5).reduce((s, l) => s + l.amount, 0);

  const asc = lines.map((l) => l.amount).sort((a, b) => a - b);
  const median = asc.length
    ? (asc.length % 2 ? asc[(asc.length - 1) / 2] : (asc[asc.length / 2 - 1] + asc[asc.length / 2]) / 2)
    : 0;

  return {
    total,
    perCard: sortedByAmount(perCard),
    buckets,
    topTransactions: sorted.slice(0, topN),
    count: lines.length,
    medianTicket: median,
    top5Share: total > 0 ? top5 / total : null,
    countForHalf,
  };
}

// ── Stock review ────────────────────────────────────────────────────────────

export type Mover = {
  ticker: string;
  startValue: number;
  endValue: number;
  change: number;
  pct: number | null;
};

export type StockReview = {
  currentMarketValue: number;
  currentCostBasis: number | null;
  currentUnrealizedGain: number | null;
  periodGain: number | null;
  realizedPeriodGain: number;
  ytdRealizedGain: number;
  topGainers: Mover[];
  topLosers: Mover[];
  dataSparse: boolean;
};

function snapshotAt(snaps: HoldingSnapshotRecord[], boundaryIso: string): HoldingSnapshotRecord | null {
  let best: HoldingSnapshotRecord | null = null;
  for (const s of snaps) {
    if (!s.date) continue;
    if (s.date <= boundaryIso) {
      if (!best || (s.date > (best.date ?? ""))) best = s;
    }
  }
  if (best) return best;
  let earliest: HoldingSnapshotRecord | null = null;
  for (const s of snaps) {
    if (!s.date) continue;
    if (!earliest || s.date < (earliest.date ?? "9999")) earliest = s;
  }
  return earliest;
}

export function computeStockReview(
  holdingSnapshots: HoldingSnapshotRecord[],
  lots: HoldingLotRecord[],
  quotes: TickerQuoteRecord[],
  trades: TransactionRecord[],
  range: DateRange,
  ytd: DateRange,
  topN = 5,
): StockReview {
  const quoteMap: QuoteMap = buildQuoteMap(quotes);

  let currentMarketValue = 0;
  let currentCostBasis: number | null = 0;
  for (const t of uniqueTickers(lots)) {
    const agg = tickerAggregate(t, lots, quoteMap);
    currentMarketValue += agg.marketValue ?? 0;
    if (agg.totalCost == null) currentCostBasis = null;
    else if (currentCostBasis != null) currentCostBasis += agg.totalCost;
  }
  const currentUnrealizedGain = currentCostBasis == null ? null : currentMarketValue - currentCostBasis;

  let realizedPeriodGain = 0;
  let ytdRealizedGain = 0;
  for (const tx of trades) {
    if (tx.type !== "SELL" || !isPosted(tx)) continue;
    const g = realizedGain(tx);
    if (g == null) continue;
    if (inRange(tx.date, range)) realizedPeriodGain += g;
    if (inRange(tx.date, ytd)) ytdRealizedGain += g;
  }

  const byTicker = new Map<string, HoldingSnapshotRecord[]>();
  for (const s of holdingSnapshots) {
    const k = (s.ticker ?? "").toUpperCase();
    if (!k) continue;
    const arr = byTicker.get(k) ?? [];
    arr.push(s); byTicker.set(k, arr);
  }

  let dataSparse = false;
  const movers: Mover[] = [];
  let startTotal = 0;
  let endTotal = 0;
  for (const [ticker, snaps] of byTicker) {
    const startSnap = snapshotAt(snaps, range.fromIso);
    const endSnap = snapshotAt(snaps, range.toIso);
    const hasStartBaseline = snaps.some((s) => (s.date ?? "") <= range.fromIso);
    if (!hasStartBaseline) dataSparse = true;
    const startValue = startSnap?.marketValue ?? 0;
    const endValue = endSnap?.marketValue ?? 0;
    startTotal += startValue;
    endTotal += endValue;
    const change = endValue - startValue;
    if (startValue !== 0 || endValue !== 0) {
      movers.push({ ticker, startValue, endValue, change, pct: startValue ? change / startValue : null });
    }
  }
  if (byTicker.size === 0) dataSparse = true;

  let netContrib = 0;
  for (const tx of trades) {
    if (!isPosted(tx) || !inRange(tx.date, range)) continue;
    const amt = tx.amount ?? 0;
    if (tx.type === "BUY") netContrib += -amt;
    if (tx.type === "SELL") netContrib -= amt;
  }
  const periodGain = dataSparse ? null : endTotal - startTotal - netContrib;

  const sorted = [...movers].sort((a, b) => b.change - a.change);
  const topGainers = sorted.filter((m) => m.change > 0).slice(0, topN);
  const topLosers = sorted.filter((m) => m.change < 0).slice(-topN).reverse();

  return {
    currentMarketValue,
    currentCostBasis,
    currentUnrealizedGain,
    periodGain,
    realizedPeriodGain,
    ytdRealizedGain,
    topGainers,
    topLosers,
    dataSparse,
  };
}

// ── Goal evolution ──────────────────────────────────────────────────────────

export type GoalSeriesPoint = { date: string; amount: number };
export type GoalEvolution = {
  goalId: string;
  goalName: string;
  targetAmount: number;
  startAmount: number;
  endAmount: number;
  delta: number;
  series: GoalSeriesPoint[];
};

export function computeGoalEvolution(
  goalSnapshots: GoalSnapshotRecord[],
  goals: GoalRecord[],
  range: DateRange,
): { goals: GoalEvolution[]; dataSparse: boolean } {
  const byGoal = new Map<string, GoalSnapshotRecord[]>();
  for (const s of goalSnapshots) {
    if (!s.goalId) continue;
    const arr = byGoal.get(s.goalId) ?? [];
    arr.push(s); byGoal.set(s.goalId, arr);
  }

  let dataSparse = false;
  const out: GoalEvolution[] = [];

  for (const goal of goals) {
    const snaps = (byGoal.get(goal.id) ?? [])
      .filter((s) => !!s.date)
      .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

    const hasStartBaseline = snaps.some((s) => (s.date ?? "") <= range.fromIso);
    if (!hasStartBaseline && snaps.length > 0) dataSparse = true;
    if (snaps.length === 0) dataSparse = true;

    const startSnap = [...snaps].reverse().find((s) => (s.date ?? "") <= range.fromIso) ?? snaps[0];
    const endSnap = [...snaps].reverse().find((s) => (s.date ?? "") <= range.toIso) ?? snaps[snaps.length - 1];

    const startAmount = startSnap?.currentAmount ?? 0;
    const endAmount = endSnap?.currentAmount ?? (goal.currentAmount ?? 0);

    const series: GoalSeriesPoint[] = snaps
      .filter((s) => (s.date ?? "") >= range.fromIso && (s.date ?? "") <= range.toIso)
      .map((s) => ({ date: s.date as string, amount: s.currentAmount ?? 0 }));

    out.push({
      goalId: goal.id,
      goalName: goal.name ?? "Goal",
      targetAmount: goal.targetAmount ?? 0,
      startAmount,
      endAmount,
      delta: endAmount - startAmount,
      series,
    });
  }

  return { goals: out, dataSparse };
}

// ── Trend (income vs expense over sub-buckets) ───────────────────────────────

export type TrendPoint = { bucket: string; label: string; income: number; expense: number; net: number };

/**
 * Income vs. expense bucketed within the period — monthly for a year view,
 * weekly (WoW) for a month view. Income = salary deposits; expense uses the
 * same exclusion rules as the rest of the review.
 */
export function computeTrend(
  txs: TransactionRecord[],
  accounts: AccountRecord[],
  period: Period,
): TrendPoint[] {
  const range = periodRange(period);
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const buckets = new Map<string, TrendPoint>();

  let keyOf: (dateIso: string) => string;
  if (period.kind === "year") {
    for (let m = 1; m <= 12; m++) {
      const key = `${period.year}-${pad2(m)}`;
      buckets.set(key, { bucket: key, label: MONTH_NAMES[m - 1].slice(0, 3), income: 0, expense: 0, net: 0 });
    }
    keyOf = (d) => d.slice(0, 7);
  } else {
    const days = lastDayOfMonth(period.year, period.month);
    const monthAbbr = MONTH_NAMES[period.month - 1].slice(0, 3);
    for (let startDay = 1; startDay <= days; startDay += 7) {
      const key = `${period.year}-${pad2(period.month)}-${pad2(startDay)}`;
      buckets.set(key, { bucket: key, label: `${monthAbbr} ${startDay}`, income: 0, expense: 0, net: 0 });
    }
    keyOf = (d) => {
      const day = Number(d.slice(8, 10));
      const startDay = Math.floor((day - 1) / 7) * 7 + 1;
      return `${period.year}-${pad2(period.month)}-${pad2(startDay)}`;
    };
  }

  for (const tx of txs) {
    if (!inRange(tx.date, range)) continue;
    const date = tx.date as string;
    const exp = expenseMagnitude(tx, acctById);
    if (exp != null) {
      const b = buckets.get(keyOf(date));
      if (b) b.expense += exp;
    }
    const inc = isSalaryDeposit(tx, acctById);
    if (inc != null) {
      const b = buckets.get(keyOf(date));
      if (b) b.income += inc;
    }
  }

  for (const b of buckets.values()) b.net = b.income - b.expense;
  return [...buckets.values()];
}
