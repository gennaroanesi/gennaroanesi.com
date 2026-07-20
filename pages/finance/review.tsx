import React, { useCallback, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
  LineChart, Line, Legend, ComposedChart,
} from "recharts";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  listAll,
  FINANCE_COLOR,
  fmtCurrency,
  fmtDate,
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
  type RecurringRecord,
  type SpendGroupRecord,
} from "@/components/finance/_shared";
import {
  type Period,
  periodRange,
  ytdRange,
  summarizeIncome,
  summarizeIncomeSources,
  summarizeCoverage,
  detectOneOffs,
  summarizeCostOfCarry,
  EMPLOYER_TICKERS,
  summarizeExpenses,
  summarizeRecurring,
  detectRecurringSuggestions,
  summarizeCreditCards,
  summarizeGroups,
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

function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

// ── Presentational helpers ────────────────────────────────────────────────────

function StatCard({ label, value, color, hint }: { label: string; value: string; color?: string; hint?: string }) {
  return (
    <div className={CARD}>
      <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">{label}</p>
      <p className="text-2xl font-bold mt-1" style={color ? { color } : undefined}>{value}</p>
      {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

/**
 * A StatCard whose number can be opened up to show the rows that produced it.
 * Grouped figures ("essentials + debt") are only trustworthy if you can check
 * what landed in them — categorisation rules change, and a number you can't
 * decompose is a number you end up not believing.
 */
function DrillCard({
  label, value, color, hint, rows, footer,
}: {
  label: string;
  value: string;
  color?: string;
  hint?: string;
  rows: { name: string; amount: number; meta?: string }[];
  footer?: string;
}) {
  const [open, setOpen] = useState(false);
  const has = rows.length > 0;
  return (
    <div className={CARD}>
      <button
        type="button"
        onClick={() => has && setOpen((v) => !v)}
        className={`w-full text-left flex items-start justify-between gap-2 ${has ? "cursor-pointer" : "cursor-default"}`}
        aria-expanded={open}
        title={has ? "Show what makes up this number" : undefined}
      >
        <span className="min-w-0">
          <span className="block text-[10px] uppercase tracking-widest text-gray-400 font-medium">{label}</span>
          <span className="block text-2xl font-bold mt-1" style={color ? { color } : undefined}>{value}</span>
          {hint && <span className="block text-xs text-gray-400 mt-0.5">{hint}</span>}
        </span>
        {has && (
          <span
            className={`text-gray-400 text-lg leading-none mt-0.5 flex-shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          >
            ›
          </span>
        )}
      </button>
      {open && (
        <div className="mt-3 pt-2 border-t border-gray-200 dark:border-darkBorder flex flex-col gap-1 max-h-72 overflow-y-auto">
          {rows.map((r, i) => (
            <div key={`${r.name}-${i}`} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="min-w-0 truncate text-gray-600 dark:text-gray-300">
                {r.name}
                {r.meta && <span className="text-gray-400 ml-1.5">{r.meta}</span>}
              </span>
              <span className="tabular-nums flex-shrink-0 text-gray-700 dark:text-gray-200">
                {fmtCurrency(r.amount)}
              </span>
            </div>
          ))}
          {footer && (
            <p className="text-[10px] text-gray-400 mt-1 pt-1 border-t border-gray-200 dark:border-darkBorder">
              {footer}
            </p>
          )}
        </div>
      )}
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

/** Recharts' default tooltip renders a near-white label on a white surface,
 *  which is unreadable. Shared so every chart on the page matches. */
const TOOLTIP_LABEL_STYLE = { color: "#111827", fontWeight: 600 } as const;
const TOOLTIP_CONTENT_STYLE = {
  borderRadius: 8,
  border: "1px solid #e5e7eb",
  fontSize: 12,
  color: "#111827",
} as const;

function BreakdownBars({
  data, color, emptyLabel, height,
}: {
  data: { name: string; amount: number }[];
  color: string;
  emptyLabel: string;
  /** Pass "100%" to fill a parent that has its own definite height. */
  height?: number | `${number}%`;
}) {
  if (data.length === 0) return <p className="text-sm text-gray-400 py-6 text-center">{emptyLabel}</p>;
  const top = data.slice(0, 12);
  return (
    <ResponsiveContainer width="100%" height={height ?? Math.max(120, top.length * 34)}>
      <BarChart data={top} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} strokeOpacity={0.1} />
        <XAxis type="number" tickFormatter={fmtCompact} tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
        <Tooltip
          formatter={(v: any) => [fmtCurrency(Number(v)), "Spend"]}
          cursor={{ fillOpacity: 0.06 }}
          labelStyle={TOOLTIP_LABEL_STYLE}
          contentStyle={TOOLTIP_CONTENT_STYLE}
        />
        <Bar dataKey="amount" radius={[0, 4, 4, 0]} fill={color} />
      </BarChart>
    </ResponsiveContainer>
  );
}

const catToBars = (b: CategoryBucket[]) => b.map((x) => ({ name: x.category, amount: x.amount }));
const acctToBars = (b: AccountBucket[]) => b.map((x) => ({ name: x.accountName, amount: x.amount }));

// ── Page ───────────────────────────────────────────────────────────────────

export default function ReviewPage() {
  const { authState } = useRequireAuth();

  const [txs, setTxs] = useState<TransactionRecord[]>([]);
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [recurrings, setRecurrings] = useState<RecurringRecord[]>([]);
  const [lots, setLots] = useState<HoldingLotRecord[]>([]);
  const [quotes, setQuotes] = useState<TickerQuoteRecord[]>([]);
  const [holdingSnaps, setHoldingSnaps] = useState<HoldingSnapshotRecord[]>([]);
  const [goalSnaps, setGoalSnaps] = useState<GoalSnapshotRecord[]>([]);
  const [goals, setGoals] = useState<GoalRecord[]>([]);
  const [spendGroups, setSpendGroups] = useState<SpendGroupRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const today = todayIso();
  const curYear = Number(today.slice(0, 4));
  const curMonth = Number(today.slice(5, 7));
  const [kind, setKind] = useState<"month" | "year">("month");
  const [year, setYear] = useState(curYear);
  const [month, setMonth] = useState(curMonth);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [t, a, rec, l, q, hs, gs, g, sg] = await Promise.all([
        listAll(client.models.financeTransaction),
        listAll(client.models.financeAccount),
        listAll(client.models.financeRecurring as any),
        listAll(client.models.financeHoldingLot),
        listAll(client.models.financeTickerQuote),
        listAll(client.models.financeHoldingSnapshot),
        listAll(client.models.financeGoalSnapshot),
        listAll(client.models.financeSavingsGoal),
        listAll(client.models.financeSpendGroup as any),
      ]);
      setTxs(t as TransactionRecord[]);
      setAccounts(a as AccountRecord[]);
      setRecurrings(rec as RecurringRecord[]);
      setLots(l as HoldingLotRecord[]);
      setQuotes(q as TickerQuoteRecord[]);
      setHoldingSnaps(hs as HoldingSnapshotRecord[]);
      setGoalSnaps(gs as GoalSnapshotRecord[]);
      setGoals(g as GoalRecord[]);
      setSpendGroups(sg as SpendGroupRecord[]);
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

  const availableYears = useMemo(() => {
    const ys = new Set<number>([curYear]);
    for (const t of txs) if (t.date) ys.add(Number(t.date.slice(0, 4)));
    return [...ys].sort((a, b) => b - a);
  }, [txs, curYear]);

  const view = useMemo(() => {
    const range = periodRange(period);
    const ytd = ytdRange(period);
    const trades = txs.filter((t) => t.type === "BUY" || t.type === "SELL");
    const sources = summarizeIncomeSources(txs, accounts, range);
    return {
      range,
      sources,
      coverage: summarizeCoverage(txs, accounts, range, sources),
      oneOffs: detectOneOffs(txs, accounts, recurrings, range),
      carry: summarizeCostOfCarry(txs, accounts, range),
      income: summarizeIncome(txs, accounts, range),
      expenses: summarizeExpenses(txs, accounts, recurrings, range),
      recurring: summarizeRecurring(txs, recurrings, accounts, range),
      recurringSuggestions: detectRecurringSuggestions(txs, accounts, recurrings, range.toIso),
      cards: summarizeCreditCards(txs, accounts, range),
      groups: summarizeGroups(txs, accounts, spendGroups, range),
      stock: computeStockReview(holdingSnaps, lots, quotes, trades, range, ytd),
      goalEvo: computeGoalEvolution(goalSnaps, goals, range),
      trend: computeTrend(txs, accounts, period),
    };
  }, [period, txs, accounts, recurrings, spendGroups, lots, quotes, holdingSnaps, goalSnaps, goals]);

  if (authState !== "authenticated") return null;

  const { range, income, expenses, recurring, recurringSuggestions, cards, groups, stock, goalEvo, trend,
          sources, coverage, oneOffs, carry } = view;
  const net = income.total - expenses.total;

  return (
    <FinanceLayout>
      <div className="flex flex-col h-full">
        {/* Fixed header: period selector + headline cards stay put while the body scrolls */}
        <div className="flex-shrink-0 border-b border-gray-200 dark:border-darkBorder bg-white dark:bg-darkBg px-4 md:px-8 pt-4 pb-3">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
          <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
          <span>/</span>
          <span>Review</span>
        </div>

        {/* Header + period selector */}
        <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-purple dark:text-rose">Review</h1>
            <p className="text-xs text-gray-400 mt-0.5">{range.label} · income, spending, investments &amp; goals</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
              {(["month", "year"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className="px-3 py-2 text-xs font-medium capitalize transition-colors"
                  style={kind === k ? { backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR } : undefined}
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

        {/* Headline cards — pinned with the selector */}
        {!loading && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard
              label="Income"
              value={fmtCurrency(income.total)}
              color={INCOME_COLOR}
              // Payroll deposits, bonus included — Salary coverage splits the
              // bonus out separately, so label this honestly or the two
              // sections read as contradicting each other.
              hint={
                sources.bonus > 0
                  ? `payroll · ${income.count} deposits · incl. ${fmtCurrency(sources.bonus)} bonus`
                  : `payroll · ${income.count} deposit${income.count === 1 ? "" : "s"}`
              }
            />
            <StatCard
              label="Expenses"
              value={fmtCurrency(expenses.total)}
              color={EXPENSE_COLOR}
              hint={`${fmtCurrency(recurring.total)} recurring · ${fmtCurrency(expenses.discretionaryTotal)} other`}
            />
            <StatCard label="Net" value={fmtCurrency(net, "USD", true)} color={amountColor(net)} hint="income − expenses" />
          </div>
        )}
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-4 md:px-8 py-5">
        {loading && <p className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</p>}

        {!loading && (
          <>
            {income.count === 0 && (
              <p className="text-xs text-gray-400 mt-2">
                No salary deposits matched this period — income is detected from checking deposits matching the salary
                pattern (currently &ldquo;META&rdquo;). Adjust <code>SALARY_DESCRIPTION_PATTERNS</code> if your payroll memo differs.
              </p>
            )}

            {/* ── Trend ────────────────────────────────────────────── */}
            <SectionTitle hint={kind === "month" ? "by week" : "by month"}>Income vs. expenses</SectionTitle>
            <div className={CARD}>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={trend} margin={{ left: 8, right: 12, top: 8, bottom: 4 }}>
                  <CartesianGrid strokeOpacity={0.1} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis tickFormatter={fmtCompact} tick={{ fontSize: 11 }} width={48} />
                  <Tooltip
                    formatter={(v: any) => fmtCurrency(Number(v))}
                    labelStyle={TOOLTIP_LABEL_STYLE}
                    contentStyle={TOOLTIP_CONTENT_STYLE}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="income" name="Income" stroke={INCOME_COLOR} dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="expense" name="Expenses" stroke={EXPENSE_COLOR} dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* ── Salary coverage ──────────────────────────────────── */}
            {/* Tests the working model: salary should cover essentials, and
                bonus + RSU should cover lifestyle. Reviewing against total
                income hides the real dynamic — income lands in lumps while
                spending is smooth, so a card bridges the gap between vests. */}
            <SectionTitle hint={`${sources.variablePct.toFixed(0)}% of income is bonus + RSU`}>
              Salary coverage
            </SectionTitle>
            {/* RSU is measured from share SALES, so a vest that was held (or one
                that never landed in a tracked account) contributes nothing.
                Say so explicitly — otherwise the equity figure silently
                under-reports and the coverage verdict reads as worse than it is. */}
            <SparseNote>
              RSU counts <strong>shares sold</strong>, not vested. A vest you held — or one in an
              untracked account — shows as $0 here, so equity income is a floor, not a total.
            </SparseNote>
            {/* auto-fit + a 300px floor: these cards carry a big number, a hint
                line and an expandable breakdown, so two-up on a phone clips the
                value. Sizing on card width rather than viewport breakpoints
                means it also behaves inside the narrower desktop content column. */}
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-3 items-start">
              <DrillCard
                label="Salary"
                value={fmtCurrency(sources.salary)}
                hint={`${fmtCurrency(sources.salaryPerMonth)}/mo · ${sources.salaryLines.length} deposits`}
                rows={sources.salaryLines.map((l) => ({
                  name: l.description, amount: l.amount, meta: fmtDate(l.date),
                }))}
                footer="Recurring payroll deposits. Anything ≥2× the median lands in Bonus instead."
              />
              <DrillCard
                label="Bonus + RSU"
                value={fmtCurrency(coverage.equity)}
                color={AMBER}
                hint={
                  sources.bonus > 0
                    ? `${fmtCurrency(sources.bonus)} bonus + ${fmtCurrency(sources.rsu)} shares sold`
                    : `${fmtCurrency(sources.rsu)} shares sold`
                }
                rows={[...sources.bonusLines, ...sources.rsuLines].map((l) => ({
                  name: l.description, amount: l.amount, meta: fmtDate(l.date),
                }))}
                footer={`RSU counts ${EMPLOYER_TICKERS.join("/")} share sales only — a vest you held shows as $0.`}
              />
              <DrillCard
                label="Essentials + debt"
                value={`${coverage.essentialsPctOfSalary.toFixed(0)}%`}
                color={coverage.salaryCoversEssentials ? INCOME_COLOR : EXPENSE_COLOR}
                hint={`of salary · ${fmtCurrency(coverage.essentialsPerMonth + coverage.debtService / coverage.months)}/mo`}
                rows={[
                  ...coverage.debtByPayee.map((d) => ({
                    name: d.category, amount: d.amount, meta: `debt service · ${d.count}×`,
                  })),
                  ...coverage.essentialsByCategory.map((c) => ({
                    name: c.category, amount: c.amount, meta: `${c.count}×`,
                  })),
                ]}
                footer={`Essentials ${fmtCurrency(coverage.essentials)} + debt service ${fmtCurrency(coverage.debtService)} vs salary ${fmtCurrency(coverage.salary)}. Taxes excluded — see below.`}
              />
              <DrillCard
                label="Lifestyle vs equity"
                value={coverage.equity > 0 ? `${coverage.lifestylePctOfEquity.toFixed(0)}%` : "—"}
                color={coverage.equityCoversLifestyle ? INCOME_COLOR : EXPENSE_COLOR}
                hint={`${fmtCurrency(coverage.lifestylePerMonth)}/mo lifestyle`}
                rows={coverage.lifestyleByCategory.map((c) => ({
                  name: c.category, amount: c.amount, meta: `${c.count}×`,
                }))}
                footer={`Everything not essential, debt service or tax: ${fmtCurrency(coverage.lifestyle)} vs bonus + RSU ${fmtCurrency(coverage.equity)}.`}
              />
            </div>
            <div className={`${CARD} mt-3`}>
              <div className="flex flex-col gap-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-gray-500 dark:text-gray-400">
                    Salary − essentials − debt service
                  </span>
                  <span className="tabular-nums font-semibold" style={{ color: amountColor(coverage.salarySurplus) }}>
                    {fmtCurrency(coverage.salarySurplus)} ({fmtCurrency(coverage.salarySurplusPerMonth)}/mo)
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-gray-500 dark:text-gray-400">
                    Monthly gap on salary alone <span className="text-gray-400">(what a card bridges between vests)</span>
                  </span>
                  <span className="tabular-nums font-semibold" style={{ color: amountColor(coverage.betweenVestGapPerMonth) }}>
                    {fmtCurrency(coverage.betweenVestGapPerMonth)}/mo
                  </span>
                </div>
                {coverage.taxes > 0 && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-gray-500 dark:text-gray-400">
                      Taxes <span className="text-gray-400">(lumpy — excluded from both buckets)</span>
                    </span>
                    <span className="tabular-nums">{fmtCurrency(coverage.taxes)}</span>
                  </div>
                )}
                <p className="text-xs text-gray-400 pt-1 border-t border-gray-200 dark:border-darkBorder">
                  {coverage.salaryCoversEssentials
                    ? "✅ Salary covers essentials and debt service."
                    : "⚠️ Essentials and debt service exceed salary."}
                  {" "}
                  {coverage.equity > 0 && (coverage.equityCoversLifestyle
                    ? "Bonus + RSU cover lifestyle spending."
                    : "Lifestyle spending exceeds bonus + RSU.")}
                </p>
              </div>
            </div>

            {/* ── Cost of carry ────────────────────────────────────── */}
            {carry.totalInterest > 0 && (
              <>
                <SectionTitle hint={`${fmtCurrency(carry.totalCardDebt)} card debt`}>Cost of carry</SectionTitle>
                <div className={CARD}>
                  <div className="flex items-baseline justify-between mb-3">
                    <span className="text-sm text-gray-500 dark:text-gray-400">Interest paid this period</span>
                    <span className="text-xl font-bold" style={{ color: EXPENSE_COLOR }}>
                      {fmtCurrency(carry.totalInterest)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {carry.lines.map((l) => (
                      <div key={l.accountId} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-gray-700 dark:text-gray-200 truncate">{l.accountName}</span>
                        <span className="flex items-center gap-3 flex-shrink-0">
                          {l.impliedApr != null && (
                            <span className="text-[11px] text-gray-400 tabular-nums">
                              ~{l.impliedApr.toFixed(0)}% APR
                            </span>
                          )}
                          <span className="tabular-nums" style={{ color: EXPENSE_COLOR }}>
                            {fmtCurrency(l.interest)}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-gray-400 mt-3 pt-2 border-t border-gray-200 dark:border-darkBorder">
                    Annualising to <strong>{fmtCurrency(carry.annualisedInterest)}/yr</strong>. Revolving a
                    balance also forfeits the grace period, so new purchases accrue interest from day one.
                  </p>
                </div>
              </>
            )}

            {/* ── One-offs ─────────────────────────────────────────── */}
            {oneOffs.items.length > 0 && (
              <>
                <SectionTitle hint={`${fmtCurrency(oneOffs.total)} · excluded from run-rate`}>
                  One-off purchases
                </SectionTitle>
                <div className={CARD}>
                  <div className="flex flex-wrap gap-6 mb-3">
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Spend as billed</p>
                      <p className="text-lg font-bold tabular-nums">{fmtCurrency(oneOffs.rawPerMonth)}/mo</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Underlying run-rate</p>
                      <p className="text-lg font-bold tabular-nums" style={{ color: INCOME_COLOR }}>
                        {fmtCurrency(oneOffs.adjustedPerMonth)}/mo
                      </p>
                    </div>
                  </div>
                  {/* List and category chart side by side: the list answers
                      "which purchases", the chart answers "what kind" — a
                      lopsided period (one huge tax bill, a renovation) is
                      obvious from the chart without reading every row. */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:items-stretch">
                    <div className="min-w-0 flex flex-col md:h-[420px]">
                      <p className="text-xs text-gray-400 mb-2">{oneOffs.items.length} purchases</p>
                      {/* All rows rendered; the fixed-height column scrolls. */}
                      <div className="flex flex-col gap-1 flex-1 min-h-0 overflow-y-auto pr-1">
                        {oneOffs.items.map((o) => (
                          <div key={o.id} className="flex items-center justify-between gap-3 text-sm">
                            <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">
                              <span className="text-gray-400 text-xs mr-2 tabular-nums">{fmtDate(o.date)}</span>
                              {o.description}
                            </span>
                            <span className="flex items-center gap-3 flex-shrink-0">
                              <span className="text-[11px] text-gray-400">{o.category}</span>
                              <span className="tabular-nums">{fmtCurrency(o.amount)}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="min-w-0 flex flex-col md:h-[420px]">
                      <p className="text-xs text-gray-400 mb-2">By category</p>
                      <div className="flex-1 min-h-0 min-w-0">
                        <BreakdownBars
                          data={catToBars(oneOffs.byCategory)}
                          color={AMBER}
                          emptyLabel="No one-off purchases this period."
                          height="100%"
                        />
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-gray-400 mt-3 pt-2 border-t border-gray-200 dark:border-darkBorder">
                    Large, non-recurring purchases. Averaging a period that contains these overstates
                    ongoing spending — the run-rate above excludes them.
                  </p>
                </div>
              </>
            )}

            {/* ── Expenses (discretionary) ─────────────────────────── */}
            <SectionTitle hint={`${fmtCurrency(expenses.discretionaryTotal)} · excludes recurring & transfers`}>Spending</SectionTitle>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className={CARD}>
                <p className="text-xs text-gray-400 mb-2">By category</p>
                <BreakdownBars data={catToBars(expenses.byCategory)} color={EXPENSE_COLOR} emptyLabel="No discretionary spending this period." />
              </div>
              <div className={CARD}>
                <p className="text-xs text-gray-400 mb-2">By account</p>
                <BreakdownBars data={acctToBars(expenses.byAccount)} color={EXPENSE_COLOR} emptyLabel="No discretionary spending this period." />
              </div>
            </div>

            {/* ── Recurring ────────────────────────────────────────── */}
            <SectionTitle hint={`${fmtCurrency(recurring.total)} matched`}>Recurring</SectionTitle>
            {recurring.items.length === 0 ? (
              <p className="text-sm text-gray-400 py-2">
                No recurring rules.{" "}
                <NextLink href="/finance/recurring" className="hover:underline" style={{ color: FINANCE_COLOR }}>Add some</NextLink>{" "}
                (mortgage, car, insurance…) so these stop landing in discretionary spending.
              </p>
            ) : (
              <div className={CARD}>
                <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 text-xs text-gray-400 mb-1">
                  <span>Rule</span><span className="text-right">Expected</span><span className="text-right">Actual</span>
                </div>
                <div className="divide-y divide-gray-100 dark:divide-darkBorder">
                  {recurring.items.map((r) => {
                    const over = r.actual > r.expected * 1.15 && r.expected > 0;
                    const missing = r.actual === 0;
                    return (
                      <div key={r.ruleId} className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-center py-2">
                        <div className="min-w-0">
                          <p className="text-sm truncate">{r.description}</p>
                          <p className="text-[11px] text-gray-400">
                            {r.cadence?.toLowerCase()}{r.category ? ` · ${r.category}` : ""}{r.count ? ` · ${r.count} matched` : ""}
                          </p>
                        </div>
                        <span className="text-sm text-right text-gray-400 tabular-nums">{fmtCurrency(r.expected)}</span>
                        <span
                          className="text-sm text-right font-medium tabular-nums"
                          style={{ color: missing ? "#9ca3af" : over ? EXPENSE_COLOR : undefined }}
                        >
                          {missing ? "—" : fmtCurrency(r.actual)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Looks-recurring-but-unmatched suggestions */}
            {recurringSuggestions.length > 0 && (
              <div className={`${CARD} mt-3 border-dashed`}>
                <p className="text-xs text-gray-400 mb-2">
                  Looks recurring — no rule yet{" "}
                  <span className="text-gray-400/70">(repeats monthly at a near-identical amount; last 12 months)</span>
                </p>
                <div className="divide-y divide-gray-100 dark:divide-darkBorder">
                  {recurringSuggestions.map((s) => (
                    <div key={s.key} className="flex items-center justify-between py-2 gap-2">
                      <div className="min-w-0">
                        <p className="text-sm truncate">{s.label}</p>
                        <p className="text-[11px] text-gray-400 truncate">
                          {s.cadence} · {s.occurrences}× over {s.months} mo · {s.accountName} · last {fmtDate(s.lastDate)}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 whitespace-nowrap">
                        <span className="text-sm font-medium" style={{ color: EXPENSE_COLOR }}>{fmtCurrency(s.medianAmount)}</span>
                        <NextLink
                          href={{
                            pathname: "/finance/recurring",
                            query: {
                              new: "1",
                              description:  s.label,
                              amount:       s.medianAmount.toFixed(2),
                              accountId:    s.accountId,
                              cadence:      s.cadenceEnum,
                              startDate:    s.firstDate,
                              lastDate:     s.lastDate,
                              matchPattern: s.key,
                            },
                          }}
                          className="text-xs hover:underline"
                          style={{ color: FINANCE_COLOR }}
                        >
                          + Rule
                        </NextLink>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Credit-card spending ─────────────────────────────── */}
            <SectionTitle hint={`${fmtCurrency(cards.total)} charged`}>Credit-card spending</SectionTitle>
            {cards.count === 0 ? (
              <p className="text-sm text-gray-400 py-2">No credit-card charges this period.</p>
            ) : (
              <>
                {cards.perCard.length > 0 && (
                  <div className={`${CARD} mb-3`}>
                    <div className="divide-y divide-gray-100 dark:divide-darkBorder">
                      {cards.perCard.map((c) => (
                        <div key={c.accountId} className="flex items-center justify-between py-2 gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <AccountBadge type={c.type as any} />
                            <span className="text-sm truncate">{c.accountName}</span>
                            <span className="text-xs text-gray-400">{c.count} charges</span>
                          </div>
                          <span className="text-sm font-medium" style={{ color: EXPENSE_COLOR }}>{fmtCurrency(c.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-stretch">
                  <div className={`${CARD} flex flex-col`}>
                    <p className="text-xs text-gray-400 mb-2">By ticket size · spend (bars) + cumulative % of spend</p>
                    <div className="flex-1 min-h-[260px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={cards.buckets} margin={{ left: 8, right: 12, top: 4, bottom: 4 }}>
                          <CartesianGrid vertical={false} strokeOpacity={0.1} />
                          <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                          <YAxis yAxisId="left" tickFormatter={fmtCompact} tick={{ fontSize: 11 }} width={48} />
                          <YAxis
                            yAxisId="right" orientation="right" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]}
                            tickFormatter={(v: any) => `${Math.round(v)}%`} tick={{ fontSize: 11 }} width={44}
                          />
                          <Tooltip
                            formatter={(v: any, name: any, p: any) =>
                              String(name).includes("%")
                                ? `${Number(v).toFixed(0)}%`
                                : `${fmtCurrency(Number(v))} · ${p?.payload?.count ?? 0} tx`}
                            cursor={{ fillOpacity: 0.06 }}
                            labelStyle={TOOLTIP_LABEL_STYLE}
                            contentStyle={TOOLTIP_CONTENT_STYLE}
                          />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Bar yAxisId="left" dataKey="amount" name="Spend" radius={[4, 4, 0, 0]} fill={EXPENSE_COLOR} />
                          <Line yAxisId="right" type="monotone" dataKey="cumSpendPct" name="Cum. % of spend" stroke={AMBER} strokeWidth={2} dot={{ r: 2 }} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                    <p className="text-xs text-gray-400 mt-2">
                      {cards.count} charges · median {fmtCurrency(cards.medianTicket)}
                      {cards.top5Share != null && <> · top 5 = {(cards.top5Share * 100).toFixed(0)}%</>}
                      {" "}· {cards.countForHalf} make up half
                    </p>
                  </div>
                  <div className={`${CARD} flex flex-col`}>
                    <p className="text-xs text-gray-400 mb-2">Biggest charges</p>
                    <div className="divide-y divide-gray-100 dark:divide-darkBorder">
                      {cards.topTransactions.map((t) => (
                        <div key={t.id} className="flex items-center justify-between py-1.5 gap-2">
                          <div className="min-w-0">
                            <p className="text-sm truncate">{t.description}</p>
                            <p className="text-[11px] text-gray-400 truncate">{fmtDate(t.date)} · {t.accountName} · {t.category}</p>
                          </div>
                          <span className="text-sm font-medium whitespace-nowrap" style={{ color: EXPENSE_COLOR }}>{fmtCurrency(t.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* ── Income detail ────────────────────────────────────── */}
            {income.deposits.length > 0 && (
              <>
                <SectionTitle hint={fmtCurrency(income.total)}>Salary deposits</SectionTitle>
                <div className={CARD}>
                  <div className="divide-y divide-gray-100 dark:divide-darkBorder">
                    {income.deposits.map((d) => (
                      <div key={d.id} className="flex items-center justify-between py-1.5 gap-2">
                        <div className="min-w-0">
                          <p className="text-sm truncate">{d.description}</p>
                          <p className="text-[11px] text-gray-400 truncate">{fmtDate(d.date)} · {d.accountName}</p>
                        </div>
                        <span className="text-sm font-medium whitespace-nowrap" style={{ color: INCOME_COLOR }}>{fmtCurrency(d.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* ── Groups (trips / projects) ────────────────────────── */}
            {groups.length > 0 && (
              <>
                <SectionTitle hint="spend tagged to a group this period">Groups</SectionTitle>
                <div className={CARD}>
                  <div className="divide-y divide-gray-100 dark:divide-darkBorder">
                    {groups.map((g) => (
                      <div key={g.groupId} className="flex items-center justify-between py-2 gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <NextLink href="/finance/groups" className="text-sm truncate hover:underline">{g.name}</NextLink>
                          {g.kind && <span className="text-[10px] uppercase tracking-wide text-gray-400">{g.kind.toLowerCase()}</span>}
                          <span className="text-xs text-gray-400">{g.count} tx</span>
                        </div>
                        <span className="text-sm font-medium" style={{ color: EXPENSE_COLOR }}>
                          {fmtCurrency(g.amount)}{g.budget != null ? <span className="text-gray-400 font-normal"> / {fmtCurrency(g.budget)}</span> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* ── Stocks ───────────────────────────────────────────── */}
            <SectionTitle hint="brokerage + retirement">Stocks</SectionTitle>
            {stock.dataSparse && (
              <SparseNote>
                Building price history — period gains and movers populate as daily snapshots accrue (or run the
                backfill script). Realized gains and current values below are exact.
              </SparseNote>
            )}
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">
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
                          <Tooltip
                            formatter={(v: any) => fmtCurrency(Number(v))}
                            labelFormatter={(l) => String(l)}
                            labelStyle={TOOLTIP_LABEL_STYLE}
                            contentStyle={TOOLTIP_CONTENT_STYLE}
                          />
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
        <Tooltip
          formatter={(_v: any, _n: any, p: any) => fmtCurrency(p?.payload?.change, "USD", true)}
          cursor={{ fillOpacity: 0.06 }}
          labelStyle={TOOLTIP_LABEL_STYLE}
          contentStyle={TOOLTIP_CONTENT_STYLE}
        />
        <Bar dataKey="amount" radius={[0, 4, 4, 0]}>
          {data.map((_d, i) => <Cell key={i} fill={color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
