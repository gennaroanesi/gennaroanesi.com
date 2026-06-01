/**
 * components/finance/review.ts
 *
 * Pure period-aggregation logic for the Monthly / Yearly Review page. No React,
 * no client — takes already-fetched records and returns view-model objects the
 * page renders. Unit-testable in isolation.
 *
 * Money conventions (from the schema): amount is signed — positive = cash in,
 * negative = cash out. type ∈ INCOME | EXPENSE | TRANSFER | BUY | SELL. TRANSFER
 * and BUY/SELL are excluded from income/expense P&L (they move money between
 * the user's own accounts / into positions, they aren't spending or earning).
 */

import type {
  TransactionRecord,
  AccountRecord,
  GoalRecord,
  HoldingLotRecord,
  TickerQuoteRecord,
  HoldingSnapshotRecord,
  GoalSnapshotRecord,
} from "./_shared";
import { realizedGain } from "./_shared";
import {
  buildQuoteMap,
  tickerAggregate,
  uniqueTickers,
  type QuoteMap,
} from "./finance-core";
import { effectiveCategory } from "./categories";

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

// ── Cashflow summary ────────────────────────────────────────────────────────

export type CategoryBucket = { category: string; amount: number; count: number };
export type AccountBucket = { accountId: string; accountName: string; type: string | null; amount: number; count: number };

export type CashflowSummary = {
  totalIncome: number;
  totalExpense: number;       // positive magnitude
  net: number;                // income − expense
  txCount: number;
  incomeByCategory: CategoryBucket[];
  expenseByCategory: CategoryBucket[];
  incomeByAccount: AccountBucket[];
  expenseByAccount: AccountBucket[];
  creditCardSpend: AccountBucket[];   // expenses charged to CREDIT accounts
};

function sortedBuckets<T extends { amount: number }>(m: Map<string, T>): T[] {
  return [...m.values()].sort((a, b) => b.amount - a.amount);
}

export function summarizeCashflow(
  txs: TransactionRecord[],
  accounts: AccountRecord[],
  range: DateRange,
): CashflowSummary {
  const acctById = new Map(accounts.map((a) => [a.id, a]));

  let totalIncome = 0;
  let totalExpense = 0;
  let txCount = 0;

  const incomeByCategory = new Map<string, CategoryBucket>();
  const expenseByCategory = new Map<string, CategoryBucket>();
  const incomeByAccount = new Map<string, AccountBucket>();
  const expenseByAccount = new Map<string, AccountBucket>();
  const creditCardSpend = new Map<string, AccountBucket>();

  const bumpCat = (m: Map<string, CategoryBucket>, cat: string, amt: number) => {
    const b = m.get(cat) ?? { category: cat, amount: 0, count: 0 };
    b.amount += amt; b.count += 1; m.set(cat, b);
  };
  const bumpAcct = (m: Map<string, AccountBucket>, acc: AccountRecord | undefined, accountId: string, amt: number) => {
    const b = m.get(accountId) ?? {
      accountId,
      accountName: acc?.name ?? "Unknown account",
      type: (acc?.type as string) ?? null,
      amount: 0, count: 0,
    };
    b.amount += amt; b.count += 1; m.set(accountId, b);
  };

  for (const tx of txs) {
    if (!isPosted(tx)) continue;
    if (!inRange(tx.date, range)) continue;
    if (tx.type === "TRANSFER" || tx.type === "BUY" || tx.type === "SELL") continue;

    const amt = tx.amount ?? 0;
    const acc = acctById.get(tx.accountId);
    const cat = effectiveCategory(tx);

    if (tx.type === "INCOME" || amt > 0) {
      const v = Math.abs(amt);
      totalIncome += v; txCount += 1;
      bumpCat(incomeByCategory, cat, v);
      bumpAcct(incomeByAccount, acc, tx.accountId, v);
    } else if (tx.type === "EXPENSE" || amt < 0) {
      const v = Math.abs(amt);
      totalExpense += v; txCount += 1;
      bumpCat(expenseByCategory, cat, v);
      bumpAcct(expenseByAccount, acc, tx.accountId, v);
      if (acc?.type === "CREDIT") bumpAcct(creditCardSpend, acc, tx.accountId, v);
    }
  }

  return {
    totalIncome,
    totalExpense,
    net: totalIncome - totalExpense,
    txCount,
    incomeByCategory: sortedBuckets(incomeByCategory),
    expenseByCategory: sortedBuckets(expenseByCategory),
    incomeByAccount: sortedBuckets(incomeByAccount),
    expenseByAccount: sortedBuckets(expenseByAccount),
    creditCardSpend: sortedBuckets(creditCardSpend),
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
  // No snapshot on/before boundary → earliest available.
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

  // Current (live) market value + cost + unrealized gain.
  let currentMarketValue = 0;
  let currentCostBasis: number | null = 0;
  for (const t of uniqueTickers(lots)) {
    const agg = tickerAggregate(t, lots, quoteMap);
    currentMarketValue += agg.marketValue ?? 0;
    if (agg.totalCost == null) currentCostBasis = null;          // unknown cost on any lot → whole basis unknown
    else if (currentCostBasis != null) currentCostBasis += agg.totalCost;
  }
  const currentUnrealizedGain = currentCostBasis == null ? null : currentMarketValue - currentCostBasis;

  // Realized gains from SELLs.
  let realizedPeriodGain = 0;
  let ytdRealizedGain = 0;
  for (const tx of trades) {
    if (tx.type !== "SELL" || !isPosted(tx)) continue;
    const g = realizedGain(tx);
    if (g == null) continue;
    if (inRange(tx.date, range)) realizedPeriodGain += g;
    if (inRange(tx.date, ytd)) ytdRealizedGain += g;
  }

  // Snapshot-driven per-ticker start/end values + movers.
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
    // "start" = day before the range starts (closing position carried in).
    const startSnap = snapshotAt(snaps, range.fromIso);
    const endSnap = snapshotAt(snaps, range.toIso);
    // Sparse if we have no snapshot dated on/before the range start.
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

  // Contribution-adjusted portfolio gain over the period.
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
 * Income vs. expense bucketed within the period — by month for a year view,
 * by day for a month view. Driven by the same transaction set as the cashflow
 * summary (more accurate for P&L than account inflow/outflow, which mixes
 * transfers).
 */
export function computeTrend(
  txs: TransactionRecord[],
  period: Period,
): TrendPoint[] {
  const range = periodRange(period);
  const buckets = new Map<string, TrendPoint>();

  // Seed buckets so empty days/months still render a zero point.
  if (period.kind === "year") {
    for (let m = 1; m <= 12; m++) {
      const key = `${period.year}-${pad2(m)}`;
      buckets.set(key, { bucket: key, label: MONTH_NAMES[m - 1].slice(0, 3), income: 0, expense: 0, net: 0 });
    }
  } else {
    const days = lastDayOfMonth(period.year, period.month);
    for (let d = 1; d <= days; d++) {
      const key = `${period.year}-${pad2(period.month)}-${pad2(d)}`;
      buckets.set(key, { bucket: key, label: String(d), income: 0, expense: 0, net: 0 });
    }
  }

  for (const tx of txs) {
    if (!isPosted(tx) || !inRange(tx.date, range)) continue;
    if (tx.type === "TRANSFER" || tx.type === "BUY" || tx.type === "SELL") continue;
    const date = tx.date as string;
    const key = period.kind === "year" ? date.slice(0, 7) : date;
    const b = buckets.get(key);
    if (!b) continue;
    const amt = tx.amount ?? 0;
    if (tx.type === "INCOME" || amt > 0) b.income += Math.abs(amt);
    else if (tx.type === "EXPENSE" || amt < 0) b.expense += Math.abs(amt);
    b.net = b.income - b.expense;
  }

  return [...buckets.values()];
}
