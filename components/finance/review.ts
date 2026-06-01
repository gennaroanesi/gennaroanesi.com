/**
 * components/finance/review.ts
 *
 * Pure period-aggregation logic for the Monthly / Yearly Review page. No React,
 * no client — takes already-fetched records and returns view-model objects the
 * page renders. Unit-testable in isolation.
 *
 * Income vs. expense model (deliberate, see feedback):
 * - INCOME is NOT derived from transaction sign (that wrongly counts credit-card
 *   payments, loan paydowns, and refunds as income). It comes from the paycheck
 *   ledger: salary / bonus / RSU. See summarizeIncome.
 * - EXPENSES are real outflows: negative-amount / EXPENSE transactions, EXCLUDING
 *   transfers (TRANSFER type, toAccountId set, or "Transfers" category), credit-
 *   card *payments* (already counted as the underlying card charges), investment
 *   trades, and LOAN-account rows (debt mechanics tracked in the Loans section).
 *   Credit-card *charges* (the actual purchases) ARE counted. See expenseMagnitude.
 */

import type {
  TransactionRecord,
  AccountRecord,
  GoalRecord,
  HoldingLotRecord,
  TickerQuoteRecord,
  HoldingSnapshotRecord,
  GoalSnapshotRecord,
  PaycheckRecord,
} from "./_shared";
import { realizedGain, PAYCHECK_PERSON_LABELS } from "./_shared";
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

/** Last calendar day of a 1-indexed month. */
function lastDayOfMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Inclusive ISO date bounds + a human label for a period. */
export function periodRange(p: Period): DateRange {
  if (p.kind === "month") {
    const from = `${p.year}-${pad2(p.month)}-01`;
    const to = `${p.year}-${pad2(p.month)}-${pad2(lastDayOfMonth(p.year, p.month))}`;
    return { fromIso: from, toIso: to, label: `${MONTH_NAMES[p.month - 1]} ${p.year}` };
  }
  return { fromIso: `${p.year}-01-01`, toIso: `${p.year}-12-31`, label: String(p.year) };
}

/** Year-to-date range ending at the period's end (for YTD stock figures). */
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

// ── Shared buckets ────────────────────────────────────────────────────────────

export type CategoryBucket = { category: string; amount: number; count: number };
export type AccountBucket = { accountId: string; accountName: string; type: string | null; amount: number; count: number };
export type NamedBucket = { name: string; amount: number; count: number };

function sortedByAmount<T extends { amount: number }>(m: Map<string, T>): T[] {
  return [...m.values()].sort((a, b) => b.amount - a.amount);
}

// ── Income (from paychecks) ─────────────────────────────────────────────────

export type IncomeSummary = {
  total: number;                 // Σ net pay in the period
  bySource: NamedBucket[];       // Salary / Bonus / RSU
  byPerson: NamedBucket[];       // Gennaro / Cristine
  paycheckCount: number;
};

/**
 * Income = paychecks whose payDate falls in the range. Each paycheck's NET is
 * split into Salary / Bonus / RSU proportionally to its gross components, so the
 * source buckets reconcile to net cash received. Cash interest/dividends and
 * other deposits are intentionally NOT counted here (add later if needed).
 */
export function summarizeIncome(paychecks: PaycheckRecord[], range: DateRange): IncomeSummary {
  const bySource = new Map<string, NamedBucket>();
  const byPerson = new Map<string, NamedBucket>();
  let total = 0;
  let paycheckCount = 0;

  const bump = (m: Map<string, NamedBucket>, name: string, amt: number) => {
    if (amt === 0) return;
    const b = m.get(name) ?? { name, amount: 0, count: 0 };
    b.amount += amt; b.count += 1; m.set(name, b);
  };

  for (const p of paychecks) {
    if (!inRange(p.payDate, range)) continue;
    const net = p.net ?? 0;
    if (net === 0) continue;
    paycheckCount += 1;
    total += net;

    const gross = p.gross ?? 0;
    const bonus = p.bonusGross ?? 0;
    const rsu = p.rsuGross ?? 0;
    const salary = Math.max(0, gross - bonus - rsu);

    let sNet = net, bNet = 0, rNet = 0;
    if (gross > 0) {
      sNet = net * (salary / gross);
      bNet = net * (bonus / gross);
      rNet = net * (rsu / gross);
    } else if (rsu > 0) { rNet = net; sNet = 0; }
    else if (bonus > 0) { bNet = net; sNet = 0; }

    bump(bySource, "Salary", sNet);
    bump(bySource, "Bonus", bNet);
    bump(bySource, "RSU", rNet);

    const personName = PAYCHECK_PERSON_LABELS[(p.person as "ME" | "SPOUSE") ?? "ME"] ?? "Unknown";
    bump(byPerson, personName, net);
  }

  return { total, bySource: sortedByAmount(bySource), byPerson: sortedByAmount(byPerson), paycheckCount };
}

// ── Expenses ──────────────────────────────────────────────────────────────────

/**
 * The counted-expense magnitude for a transaction (positive), or null if it
 * isn't real spending. Excludes transfers, credit-card payments, investment
 * trades, and LOAN-account rows. Used everywhere expenses are summed so the
 * summary, distribution, and trend stay consistent.
 */
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

export type ExpenseSummary = {
  total: number;
  txCount: number;
  byCategory: CategoryBucket[];
  byAccount: AccountBucket[];
  creditCardSpend: AccountBucket[];   // counted expenses charged to CREDIT accounts
};

export function summarizeExpenses(
  txs: TransactionRecord[],
  accounts: AccountRecord[],
  range: DateRange,
): ExpenseSummary {
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  let total = 0;
  let txCount = 0;
  const byCategory = new Map<string, CategoryBucket>();
  const byAccount = new Map<string, AccountBucket>();
  const creditCardSpend = new Map<string, AccountBucket>();

  const bumpCat = (cat: string, amt: number) => {
    const b = byCategory.get(cat) ?? { category: cat, amount: 0, count: 0 };
    b.amount += amt; b.count += 1; byCategory.set(cat, b);
  };
  const bumpAcct = (m: Map<string, AccountBucket>, acc: AccountRecord | undefined, accountId: string, amt: number) => {
    const b = m.get(accountId) ?? {
      accountId, accountName: acc?.name ?? "Unknown account",
      type: (acc?.type as string) ?? null, amount: 0, count: 0,
    };
    b.amount += amt; b.count += 1; m.set(accountId, b);
  };

  for (const tx of txs) {
    if (!inRange(tx.date, range)) continue;
    const v = expenseMagnitude(tx, acctById);
    if (v == null) continue;
    const acc = acctById.get(tx.accountId);
    total += v; txCount += 1;
    bumpCat(effectiveCategory(tx), v);
    bumpAcct(byAccount, acc, tx.accountId, v);
    if (acc?.type === "CREDIT") bumpAcct(creditCardSpend, acc, tx.accountId, v);
  }

  return {
    total, txCount,
    byCategory: sortedByAmount(byCategory),
    byAccount: sortedByAmount(byAccount),
    creditCardSpend: sortedByAmount(creditCardSpend),
  };
}

// ── Expense distribution ──────────────────────────────────────────────────────
// Answers "is spend driven by many small charges or a few big ones?"

export type AmountBucket = { label: string; count: number; amount: number };
export type ExpenseLine = { id: string; date: string; description: string; accountName: string; category: string; amount: number };

export type ExpenseDistribution = {
  buckets: AmountBucket[];          // by ticket size
  topTransactions: ExpenseLine[];   // largest individual expenses
  total: number;
  count: number;
  medianTicket: number;
  top5Share: number | null;         // share of total from the 5 biggest charges
  countForHalf: number;             // # of largest charges that make up ~50% of spend
};

const SIZE_EDGES: { label: string; max: number }[] = [
  { label: "< $25", max: 25 },
  { label: "$25–100", max: 100 },
  { label: "$100–500", max: 500 },
  { label: "$500–2k", max: 2000 },
  { label: "$2k+", max: Infinity },
];

export function computeExpenseDistribution(
  txs: TransactionRecord[],
  accounts: AccountRecord[],
  range: DateRange,
  topN = 10,
): ExpenseDistribution {
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const lines: ExpenseLine[] = [];
  for (const tx of txs) {
    if (!inRange(tx.date, range)) continue;
    const v = expenseMagnitude(tx, acctById);
    if (v == null) continue;
    lines.push({
      id: tx.id,
      date: tx.date as string,
      description: tx.description ?? "(no description)",
      accountName: acctById.get(tx.accountId)?.name ?? "Unknown",
      category: effectiveCategory(tx),
      amount: v,
    });
  }

  const buckets: AmountBucket[] = SIZE_EDGES.map((e) => ({ label: e.label, count: 0, amount: 0 }));
  for (const l of lines) {
    const idx = SIZE_EDGES.findIndex((e) => l.amount < e.max);
    const b = buckets[idx === -1 ? buckets.length - 1 : idx];
    b.count += 1; b.amount += l.amount;
  }

  const sorted = [...lines].sort((a, b) => b.amount - a.amount);
  const total = lines.reduce((s, l) => s + l.amount, 0);

  // # of largest charges that cumulatively reach 50% of spend.
  let cum = 0, countForHalf = 0;
  for (const l of sorted) {
    if (cum >= total / 2) break;
    cum += l.amount; countForHalf += 1;
  }

  const top5 = sorted.slice(0, 5).reduce((s, l) => s + l.amount, 0);
  const amountsAsc = lines.map((l) => l.amount).sort((a, b) => a - b);
  const median = amountsAsc.length
    ? (amountsAsc.length % 2
        ? amountsAsc[(amountsAsc.length - 1) / 2]
        : (amountsAsc[amountsAsc.length / 2 - 1] + amountsAsc[amountsAsc.length / 2]) / 2)
    : 0;

  return {
    buckets,
    topTransactions: sorted.slice(0, topN),
    total,
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
  change: number;        // endValue − startValue (value swing; includes any buys/sells)
  pct: number | null;    // change / startValue
};

export type StockReview = {
  currentMarketValue: number;
  currentCostBasis: number | null;
  currentUnrealizedGain: number | null;   // market − cost (lifetime), from live lots+quotes
  periodGain: number | null;              // contribution-adjusted; null when snapshots don't cover the start
  realizedPeriodGain: number;             // Σ realized gain on SELLs in the period
  ytdRealizedGain: number;                // Σ realized gain on SELLs YTD
  topGainers: Mover[];
  topLosers: Mover[];
  dataSparse: boolean;                    // true when no holding snapshot at/before the range start
};

/** Pick the snapshot to represent a ticker at a boundary: latest on/before
 *  `boundaryIso`; if none exists, the earliest available (flagged sparse by caller). */
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
  trades: TransactionRecord[],   // BUY + SELL transactions
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
    if (agg.totalCost == null) currentCostBasis = null;          // unknown cost on any lot → whole basis unknown
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
    if (tx.type === "BUY") netContrib += -amt;   // cash spent (amt negative) → positive cost added
    if (tx.type === "SELL") netContrib -= amt;   // proceeds (amt positive) → reduces net invested
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
 * Income vs. expense bucketed within the period — by month for a year view, by
 * WEEK for a month view (day-by-day was too noisy). Income comes from paychecks
 * (placed in the bucket of their payDate); expense uses the same exclusion rules
 * as the rest of the review.
 */
export function computeTrend(
  txs: TransactionRecord[],
  paychecks: PaycheckRecord[],
  accounts: AccountRecord[],
  period: Period,
): TrendPoint[] {
  const range = periodRange(period);
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const buckets = new Map<string, TrendPoint>();

  // Map a date to its bucket key + seed empty buckets so gaps still render.
  let keyOf: (dateIso: string) => string;
  if (period.kind === "year") {
    for (let m = 1; m <= 12; m++) {
      const key = `${period.year}-${pad2(m)}`;
      buckets.set(key, { bucket: key, label: MONTH_NAMES[m - 1].slice(0, 3), income: 0, expense: 0, net: 0 });
    }
    keyOf = (d) => d.slice(0, 7);
  } else {
    // Weekly buckets: 7-day chunks anchored at the 1st (week 1 = days 1–7, …).
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

  // Expenses.
  for (const tx of txs) {
    if (!inRange(tx.date, range)) continue;
    const v = expenseMagnitude(tx, acctById);
    if (v == null) continue;
    const b = buckets.get(keyOf(tx.date as string));
    if (b) b.expense += v;
  }

  // Income from paychecks.
  for (const p of paychecks) {
    if (!inRange(p.payDate, range)) continue;
    const b = buckets.get(keyOf(p.payDate as string));
    if (b) b.income += p.net ?? 0;
  }

  for (const b of buckets.values()) b.net = b.income - b.expense;
  return [...buckets.values()];
}
