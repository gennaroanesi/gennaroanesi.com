import React, { useCallback, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
  LineChart, Line, Legend,
} from "recharts";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  listAll,
  FINANCE_COLOR,
  fmtCurrency,
  amountColor,
  todayIso,
  AccountBadge,
  type TransactionRecord,
  type AccountRecord,
  type GoalRecord,
  type HoldingLotRecord,
  type TickerQuoteRecord,
  type HoldingSnapshotRecord,
  type GoalSnapshotRecord,
} from "@/components/finance/_shared";
import {
  type Period,
  periodRange,
  ytdRange,
  summarizeCashflow,
  computeStockReview,
  computeGoalEvolution,
  computeTrend,
  type CategoryBucket,
  type AccountBucket,
} from "@/components/finance/review";

// ── Palette ──────────────────────────────────────────────────────────────────
const INCOME_COLOR = "#22c55e";
const EXPENSE_COLOR = "#ef4444";
const AMBER = "#d4a843";
const CARD = "rounded-lg border border-gray-200 dark:border-darkBorder p-4 bg-white dark:bg-darkSurface";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Compact axis money labels: $1.2k / $3.4M. */
function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

// ── Small presentational helpers ──────────────────────────────────────────────

function StatCard({ label, value, color, hint }: { label: string; value: string; color?: string; hint?: string }) {
  return (
    <div className={CARD}>
      <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">{label}</p>
      <p className="text-2xl font-bold mt-1" style={color ? { color } : undefined}>{value}</p>
      {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between mb-3 gap-2 flex-wrap mt-8">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-purple dark:text-rose">{children}</h2>
      {hint && <span className="text-xs text-gray-400">{hint}</span>}
    </div>
  );
}

function SparseNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs rounded border border-amber-300/40 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 px-3 py-2 mb-3">
      {children}
    </p>
  );
}

/** Category/account breakdown as a horizontal recharts bar, with a value list under it. */
function BreakdownBars({
  data, color, emptyLabel,
}: { data: { name: string; amount: number }[]; color: string; emptyLabel: string }) {
  if (data.length === 0) {
    return <p className="text-sm text-gray-400 py-6 text-center">{emptyLabel}</p>;
  }
  const top = data.slice(0, 12);
  return (
    <div>
      <ResponsiveContainer width="100%" height={Math.max(120, top.length * 34)}>
        <BarChart data={top} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
          <CartesianGrid horizontal={false} strokeOpacity={0.1} />
          <XAxis type="number" tickFormatter={fmtCompact} tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
          <Tooltip formatter={(v: any) => fmtCurrency(Number(v))} cursor={{ fillOpacity: 0.06 }} />
          <Bar dataKey="amount" radius={[0, 4, 4, 0]} fill={color} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function bucketsToBars(buckets: CategoryBucket[]): { name: string; amount: number }[] {
  return buckets.map((b) => ({ name: b.category, amount: b.amount }));
}
function acctBucketsToBars(buckets: AccountBucket[]): { name: string; amount: number }[] {
  return buckets.map((b) => ({ name: b.accountName, amount: b.amount }));
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function ReviewPage() {
  const { authState } = useRequireAuth();

  const [txs, setTxs] = useState<TransactionRecord[]>([]);
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [lots, setLots] = useState<HoldingLotRecord[]>([]);
  const [quotes, setQuotes] = useState<TickerQuoteRecord[]>([]);
  const [holdingSnaps, setHoldingSnaps] = useState<HoldingSnapshotRecord[]>([]);
  const [goalSnaps, setGoalSnaps] = useState<GoalSnapshotRecord[]>([]);
  const [goals, setGoals] = useState<GoalRecord[]>([]);
  const [loading, setLoading] = useState(true);

  // Period selector — default to the current month.
  const today = todayIso();
  const curYear = Number(today.slice(0, 4));
  const curMonth = Number(today.slice(5, 7));
  const [kind, setKind] = useState<"month" | "year">("month");
  const [year, setYear] = useState(curYear);
  const [month, setMonth] = useState(curMonth);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [t, a, l, q, hs, gs, g] = await Promise.all([
        listAll(client.models.financeTransaction),
        listAll(client.models.financeAccount),
        listAll(client.models.financeHoldingLot),
        listAll(client.models.financeTickerQuote),
        listAll(client.models.financeHoldingSnapshot),
        listAll(client.models.financeGoalSnapshot),
        listAll(client.models.financeSavingsGoal),
      ]);
      setTxs(t as TransactionRecord[]);
      setAccounts(a as AccountRecord[]);
      setLots(l as HoldingLotRecord[]);
      setQuotes(q as TickerQuoteRecord[]);
      setHoldingSnaps(hs as HoldingSnapshotRecord[]);
      setGoalSnaps(gs as GoalSnapshotRecord[]);
      setGoals(g as GoalRecord[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState === "authenticated") fetchAll();
  }, [authState, fetchAll]);

  const period: Period = useMemo(
    () => (kind === "month" ? { kind: "month", year, month } : { kind: "year", year }),
    [kind, year, month],
  );

  // Years present in the data, for the selector (newest first).
  const availableYears = useMemo(() => {
    const ys = new Set<number>([curYear]);
    for (const t of txs) if (t.date) ys.add(Number(t.date.slice(0, 4)));
    return [...ys].sort((a, b) => b - a);
  }, [txs, curYear]);

  const view = useMemo(() => {
    const range = periodRange(period);
    const ytd = ytdRange(period);
    const trades = txs.filter((t) => t.type === "BUY" || t.type === "SELL");
    return {
      range,
      cashflow: summarizeCashflow(txs, accounts, range),
      stock: computeStockReview(holdingSnaps, lots, quotes, trades, range, ytd),
      goalEvo: computeGoalEvolution(goalSnaps, goals, range),
      trend: computeTrend(txs, period),
    };
  }, [period, txs, accounts, lots, quotes, holdingSnaps, goalSnaps, goals]);

  if (authState !== "authenticated") return null;

  const { range, cashflow, stock, goalEvo, trend } = view;

  return (
    <FinanceLayout>
      <div className="px-4 py-5 md:px-6 max-w-5xl mx-auto overflow-y-auto h-full">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
          <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
          <span>/</span>
          <span>Review</span>
        </div>

        {/* Header + period selector */}
        <div className="flex items-baseline justify-between mb-5 gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-purple dark:text-rose">Review</h1>
            <p className="text-xs text-gray-400 mt-0.5">{range.label} · income, spending, investments &amp; goals</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Month | Year toggle */}
            <div className="inline-flex rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
              {(["month", "year"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className="px-3 py-2 text-xs font-medium capitalize transition-colors"
                  style={kind === k
                    ? { backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR }
                    : undefined}
                >
                  {k}
                </button>
              ))}
            </div>
            {kind === "month" && (
              <select
                value={month}
                onChange={(e) => setMonth(Number(e.target.value))}
                className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-2 text-gray-700 dark:text-gray-200"
              >
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
            )}
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-2 text-gray-700 dark:text-gray-200"
            >
              {availableYears.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        {loading && <p className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</p>}

        {!loading && (
          <>
            {/* ── Headline ─────────────────────────────────────────── */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <StatCard label="Income" value={fmtCurrency(cashflow.totalIncome)} color={INCOME_COLOR} />
              <StatCard label="Expenses" value={fmtCurrency(cashflow.totalExpense)} color={EXPENSE_COLOR} />
              <StatCard
                label="Net"
                value={fmtCurrency(cashflow.net, "USD", true)}
                color={amountColor(cashflow.net)}
                hint={`${cashflow.txCount} transactions`}
              />
            </div>

            {/* ── Trend ────────────────────────────────────────────── */}
            <SectionTitle hint={kind === "month" ? "by day" : "by month"}>Income vs. expenses</SectionTitle>
            <div className={CARD}>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={trend} margin={{ left: 8, right: 12, top: 8, bottom: 4 }}>
                  <CartesianGrid strokeOpacity={0.1} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis tickFormatter={fmtCompact} tick={{ fontSize: 11 }} width={48} />
                  <Tooltip formatter={(v: any) => fmtCurrency(Number(v))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="income" name="Income" stroke={INCOME_COLOR} dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="expense" name="Expenses" stroke={EXPENSE_COLOR} dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* ── Income ───────────────────────────────────────────── */}
            <SectionTitle hint={fmtCurrency(cashflow.totalIncome)}>Income</SectionTitle>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className={CARD}>
                <p className="text-xs text-gray-400 mb-2">By category</p>
                <BreakdownBars data={bucketsToBars(cashflow.incomeByCategory)} color={INCOME_COLOR} emptyLabel="No income this period." />
              </div>
              <div className={CARD}>
                <p className="text-xs text-gray-400 mb-2">By account</p>
                <BreakdownBars data={acctBucketsToBars(cashflow.incomeByAccount)} color={INCOME_COLOR} emptyLabel="No income this period." />
              </div>
            </div>

            {/* ── Expenses ─────────────────────────────────────────── */}
            <SectionTitle hint={fmtCurrency(cashflow.totalExpense)}>Expenses</SectionTitle>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className={CARD}>
                <p className="text-xs text-gray-400 mb-2">By category</p>
                <BreakdownBars data={bucketsToBars(cashflow.expenseByCategory)} color={EXPENSE_COLOR} emptyLabel="No spending this period." />
              </div>
              <div className={CARD}>
                <p className="text-xs text-gray-400 mb-2">By account</p>
                <BreakdownBars data={acctBucketsToBars(cashflow.expenseByAccount)} color={EXPENSE_COLOR} emptyLabel="No spending this period." />
              </div>
            </div>

            {/* Credit-card breakdown */}
            <div className={`${CARD} mt-3`}>
              <p className="text-xs text-gray-400 mb-2">Credit-card spend</p>
              {cashflow.creditCardSpend.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">No credit-card charges this period.</p>
              ) : (
                <div className="divide-y divide-gray-100 dark:divide-darkBorder">
                  {cashflow.creditCardSpend.map((c) => (
                    <div key={c.accountId} className="flex items-center justify-between py-2 gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <AccountBadge type={c.type as any} />
                        <span className="text-sm truncate">{c.accountName}</span>
                        <span className="text-xs text-gray-400">{c.count} tx</span>
                      </div>
                      <span className="text-sm font-medium" style={{ color: EXPENSE_COLOR }}>{fmtCurrency(c.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Stocks ───────────────────────────────────────────── */}
            <SectionTitle hint="brokerage + retirement">Stocks</SectionTitle>
            {stock.dataSparse && (
              <SparseNote>
                Building price history — period gains and movers populate as daily snapshots accrue (or run the
                backfill script). Realized gains and current values below are exact.
              </SparseNote>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Market value" value={fmtCurrency(stock.currentMarketValue)} />
              <StatCard
                label="Unrealized gain"
                value={stock.currentUnrealizedGain == null ? "—" : fmtCurrency(stock.currentUnrealizedGain, "USD", true)}
                color={stock.currentUnrealizedGain == null ? undefined : amountColor(stock.currentUnrealizedGain)}
              />
              <StatCard
                label="Period gain"
                value={stock.periodGain == null ? "—" : fmtCurrency(stock.periodGain, "USD", true)}
                color={stock.periodGain == null ? undefined : amountColor(stock.periodGain)}
                hint="incl. unrealized"
              />
              <StatCard
                label="Realized (period)"
                value={fmtCurrency(stock.realizedPeriodGain, "USD", true)}
                color={amountColor(stock.realizedPeriodGain)}
                hint={`YTD ${fmtCurrency(stock.ytdRealizedGain, "USD", true)}`}
              />
            </div>

            {(stock.topGainers.length > 0 || stock.topLosers.length > 0) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                <div className={CARD}>
                  <p className="text-xs text-gray-400 mb-2">Top gainers</p>
                  <MoversBars movers={stock.topGainers} color={INCOME_COLOR} />
                </div>
                <div className={CARD}>
                  <p className="text-xs text-gray-400 mb-2">Top losers</p>
                  <MoversBars movers={stock.topLosers} color={EXPENSE_COLOR} />
                </div>
              </div>
            )}

            {/* ── Goals ────────────────────────────────────────────── */}
            <SectionTitle>Goals</SectionTitle>
            {goalEvo.dataSparse && (
              <SparseNote>
                Building goal history — progress charts fill in as daily snapshots accrue (or run the backfill script).
              </SparseNote>
            )}
            {goalEvo.goals.length === 0 ? (
              <p className="text-sm text-gray-400 py-4">No goals yet.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {goalEvo.goals.map((g) => (
                  <div key={g.goalId} className={CARD}>
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                      <span className="text-sm font-medium truncate">{g.goalName}</span>
                      <span className="text-sm font-semibold" style={{ color: amountColor(g.delta) }}>
                        {fmtCurrency(g.delta, "USD", true)}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mb-2">
                      {fmtCurrency(g.startAmount)} → {fmtCurrency(g.endAmount)} of {fmtCurrency(g.targetAmount)}
                    </p>
                    {g.series.length > 1 ? (
                      <ResponsiveContainer width="100%" height={120}>
                        <LineChart data={g.series} margin={{ left: 4, right: 8, top: 4, bottom: 0 }}>
                          <YAxis hide domain={["dataMin", "dataMax"]} />
                          <XAxis dataKey="date" hide />
                          <Tooltip formatter={(v: any) => fmtCurrency(Number(v))} labelFormatter={(l) => String(l)} />
                          <Line type="monotone" dataKey="amount" stroke={AMBER} dot={false} strokeWidth={2} />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <p className="text-xs text-gray-400 py-6 text-center">Not enough history to chart yet.</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="h-12" />
          </>
        )}
      </div>
    </FinanceLayout>
  );
}

/** Top movers as a vertical bar chart (ticker → value change). */
function MoversBars({ movers, color }: { movers: { ticker: string; change: number; pct: number | null }[]; color: string }) {
  if (movers.length === 0) return <p className="text-sm text-gray-400 py-4 text-center">None.</p>;
  const data = movers.map((m) => ({ name: m.ticker, amount: Math.abs(m.change), change: m.change, pct: m.pct }));
  return (
    <ResponsiveContainer width="100%" height={Math.max(100, data.length * 34)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <XAxis type="number" tickFormatter={fmtCompact} tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="name" width={64} tick={{ fontSize: 11 }} />
        <Tooltip formatter={(_v: any, _n: any, p: any) => fmtCurrency(p?.payload?.change, "USD", true)} cursor={{ fillOpacity: 0.06 }} />
        <Bar dataKey="amount" radius={[0, 4, 4, 0]}>
          {data.map((d, i) => <Cell key={i} fill={color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
