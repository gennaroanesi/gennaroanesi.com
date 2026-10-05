import React, { useCallback, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import FinanceLayout from "@/layouts/finance";
import { mutate, reportError, notifyError } from "@/components/common/mutate";
import {
  client, listAll, fetchTransactions, fetchBudgets,
  FINANCE_COLOR, fmtCurrency, fmtDate, todayIso, amountColor,
  inputCls, labelCls, SaveButton, EmptyState,
  type TransactionRecord, type RecurringRecord, type AccountRecord,
} from "@/components/finance/_shared";
import { occurrencesInWindow } from "@/components/finance/cashflow";
import {
  resolveBudgetLines, validateBudgetHistory, planBudgetChange, bucketCategories,
  resolutionDate, versionsInWindow, listBudgetSeries,
  elapsedFraction, daysBetween, committedByCategory,
  computeLineView, summarizePools, unassignedCategories,
  actualByCategory, budgetKind, budgetTransactions,
  FUNDING_SOURCES, FUNDING_SOURCE_LABELS, DEFAULT_PERIOD,
  BUDGET_PERIODS, BUDGET_PERIOD_LABELS,
  type BudgetLine, type BudgetLineView, type FundingSource, type BudgetPeriod, type BudgetKind,
  type BudgetSeries,
} from "@/components/finance/budget";
import { effectiveCategory } from "@/components/finance/categories";
import { periodRange, summarizeIncomeSources, type Period } from "@/components/finance/review";
import { POSITIVE, NEGATIVE, WARNING, withAlpha } from "@/lib/colors";
import { SlideOverPanel, PageTitle, PageLoading, Card, Badge } from "@/components/common/ui";

type Draft = {
  seriesId: string;
  name: string;
  kind: BudgetKind;
  fundingSource: FundingSource;
  period: BudgetPeriod;
  amount: number | null;
  rollover: boolean;
  categories: string[];
  label: string;
  notes: string;
  /** This version's own validity. Editable when correcting, so a date entered
   *  wrong can be put right without inventing a new version. */
  effectiveFrom: string;
  /** Empty string = open-ended. Never a sentinel date. */
  effectiveTo: string;
};

/** One entry point. Correct vs change is chosen inside the panel, not by which
 *  button opened it — they opened the same form, so two buttons said nothing. */
type Panel =
  | { kind: "new" }
  | { kind: "edit"; current: BudgetLine }
  | null;

type EditMode = "correct" | "change";

/** Status is a fact (above/below budget); the colour is the judgment, and it
 *  flips by kind — under-spending is good, under-earning is not. */
const STATUS_COLOR = {
  EXPENSE: { under: POSITIVE, on: FINANCE_COLOR, over: NEGATIVE },
  INCOME:  { under: NEGATIVE, on: FINANCE_COLOR, over: POSITIVE },
} as const;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const THIS_YEAR = new Date().getFullYear();

export default function BudgetPage() {
  const { authState } = useRequireAuth();

  const [budgets, setBudgets]       = useState<BudgetLine[]>([]);
  const [txs, setTxs]               = useState<TransactionRecord[]>([]);
  const [recurrings, setRecurrings] = useState<RecurringRecord[]>([]);
  const [accounts, setAccounts]     = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);

  // The time window under review — the same shape as the Review page's picker,
  // so "did I adhere in July?" is one selection rather than a different screen.
  const [pKind, setPKind]   = useState<"month" | "quarter" | "year" | "last3">("month");
  const [pYear, setPYear]   = useState(new Date().getFullYear());
  const [pMonth, setPMonth] = useState(new Date().getMonth() + 1);
  const [pQuarter, setPQuarter] = useState(Math.floor(new Date().getMonth() / 3) + 1);

  const [panel, setPanel]       = useState<Panel>(null);
  const [draft, setDraft]       = useState<Draft | null>(null);
  const [editMode, setEditMode] = useState<EditMode>("change");
  const [showAll, setShowAll]   = useState(false);
  const [changeFrom, setChangeFrom] = useState<string>("");

  const today = todayIso();

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [bs, ts, recs, accs] = await Promise.all([
        fetchBudgets(),
        fetchTransactions(),
        listAll(client.models.financeRecurring),
        listAll(client.models.financeAccount),
      ]);
      setBudgets(bs as BudgetLine[]);
      setTxs(ts as TransactionRecord[]);
      setRecurrings(recs as RecurringRecord[]);
      setAccounts(accs as any[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (authState === "authenticated") fetchData(); }, [authState, fetchData]);

  const accountName = useMemo(
    () => new Map((accounts as AccountRecord[]).map((a) => [a.id, a.name])),
    [accounts],
  );

  const availableYears = useMemo(() => {
    const ys = new Set<number>([THIS_YEAR]);
    for (const t of txs) if (t.date) ys.add(Number(t.date.slice(0, 4)));
    return [...ys].sort((a, b) => b - a);
  }, [txs]);

  const period: Period = useMemo(() => {
    switch (pKind) {
      case "month":   return { kind: "month", year: pYear, month: pMonth };
      case "quarter": return { kind: "quarter", year: pYear, quarter: pQuarter };
      case "last3":   return { kind: "last3", anchorIso: today };
      default:        return { kind: "year", year: pYear };
    }
  }, [pKind, pYear, pMonth, pQuarter, today]);
  const window = useMemo(() => periodRange(period), [period]);

  /** Occurrence count for a rule inside a window — the cashflow engine, not a second copy. */
  const occurrencesOf = useCallback((r: RecurringRecord, from: string, to: string) =>
    occurrencesInWindow({
      id: r.id, description: r.description ?? "", amount: r.amount ?? 0, type: r.type as string,
      category: r.category, cadence: r.cadence as string, nextDate: r.nextDate,
      startDate: r.startDate, endDate: r.endDate, active: r.active,
      accountId: r.accountId, toAccountId: r.toAccountId,
    } as any, from, to).length, []);

  const model = useMemo(() => {
    // Resolved at the latest date in the window that has actually happened, so
    // a closed period answers with the version that governed its end and the
    // current one answers with what is in force today — see resolutionDate.
    const asOf      = resolutionDate(window, today);
    const inForce   = resolveBudgetLines(budgets, asOf);
    const versions  = versionsInWindow(budgets, window);
    const outflow   = actualByCategory(txs, window, "EXPENSE");
    const committed = committedByCategory(recurrings, window, occurrencesOf);

    // Income lines are measured against money arriving, expense lines against
    // money leaving — same arithmetic, opposite direction.
    // Income lines declare a pool; they are not measured per line. Every inflow
    // carries the same "Income" category, so categories cannot tell salary from
    // an RSU sale — the income classifier can, and it is the same split the
    // funding sources are named after.
    const income = summarizeIncomeSources(txs, accounts as any, window);
    const received = {
      SALARY: income.salary, BONUS: income.bonus, RSU: income.rsu, OTHER: income.other,
    };

    // Income lines feed the pools at the top; they are never rendered as budget
    // rows. A salary shown both as a pool and as a row that "spends" nothing was
    // the same fact twice, in two shapes that disagreed.
    const expenseLines = inForce.filter((l) => budgetKind(l) !== "INCOME");
    const incomeLines  = inForce.filter((l) => budgetKind(l) === "INCOME");
    const views       = expenseLines.map((l) => computeLineView(l, window, outflow, committed, today));
    const incomeViews = incomeLines.map((l) => computeLineView(l, window, new Map(), new Map(), today));

    const series = listBudgetSeries(budgets, today);

    // A period before a budget existed still has real spending. Show it against
    // the bucket's own categories with no budget figure, rather than dumping it
    // into "categories in no budget" as though it were a setup error.
    const covered = new Set(expenseLines.map((l) => l.seriesId));
    const realized = series
      .filter((sx) => sx.kind !== "INCOME" && !covered.has(sx.seriesId))
      .map((sx) => ({
        series: sx,
        spent: bucketCategories(sx.latest).reduce((sum, c) => sum + (outflow.get(c) ?? 0), 0),
        rows: budgetTransactions(txs, window, bucketCategories(sx.latest)),
      }))
      .filter((r) => r.spent > 0)
      .sort((a, b) => b.spent - a.spent);

    const rowsByLine = new Map<string, TransactionRecord[]>();
    for (const l of expenseLines) {
      rowsByLine.set(l.id, budgetTransactions(txs, window, bucketCategories(l)));
    }
    // Per-category rows, for the categories no bucket covers. Same source as
    // every other figure on the page, so the amounts agree.
    const rowsByCategory = new Map<string, TransactionRecord[]>();
    for (const cat of outflow.keys()) {
      rowsByCategory.set(cat, budgetTransactions(txs, window, [cat]));
    }

    const budgetedTotal = views.reduce((s, v) => s + v.budgeted, 0);
    const spentTotal    = views.reduce((s, v) => s + v.spent, 0);
    const pools         = summarizePools([...views, ...incomeViews], received);
    const incomeTotal   = pools.reduce((s, p) => s + p.forecast, 0);
    const receivedTotal = pools.reduce((s, p) => s + p.received, 0);

    // Only the buckets actually over, not netted against the ones under. Being
    // $400 under on Dining does not pay for being $400 over on Travel: the
    // money is already gone, and netting would report a problem as fine.
    const overspend = views.reduce((s, v) => s + Math.max(0, v.spent - v.budgeted), 0);

    // Where the whole period lands if the current rate holds. Meaningless
    // before any time has passed, and for a closed period the answer is simply
    // what happened.
    const elapsed = elapsedFraction(window, today);
    const closed  = window.toIso < today;
    const projected = closed ? spentTotal : (elapsed > 0.02 ? spentTotal / elapsed : null);

    return {
      window,
      asOf,
      views,
      incomeViews,
      rowsByLine,
      rowsByCategory,
      realized,
      overall: {
        budgeted: budgetedTotal,
        spent: spentTotal,
        remaining: budgetedTotal - spentTotal,
        pct: budgetedTotal > 0 ? spentTotal / budgetedTotal : null,
        income: incomeTotal,
        received: receivedTotal,
        /** What actually happened to cash: money in minus money out. */
        net: receivedTotal - spentTotal,
        /** Income not promised to any budget — what you keep if you spend to plan. */
        unallocated: incomeTotal - budgetedTotal,
        overspend,
        projected,
      },
      versions,
      series,
      pools,
      // Categories no bucket covers AT ALL. A category whose bucket simply had
      // no budget yet this period is reported above as realized spend, not here
      // — listing it twice would make a historical period look misconfigured.
      unassigned: unassignedCategories(
        outflow,
        [...expenseLines, ...realized.map((r) => r.series.latest)],
      ),
      issues: validateBudgetHistory(budgets, asOf),
      elapsed: elapsedFraction(window, today),
      daysLeft: Math.max(0, daysBetween(today, window.toIso)),
      closed: window.toIso < today,
    };
  }, [budgets, txs, recurrings, accounts, window, today, occurrencesOf]);

  // Spending buckets only — income lines carry no categories (see the panel).
  const categoryOptions = useMemo(() => {
    const allTime = { fromIso: "1900-01-01", toIso: "2999-12-31", label: "" };
    const all = new Set<string>();
    for (const [c] of actualByCategory(txs, allTime, "EXPENSE")) all.add(c);
    // Categories already in a bucket, even if nothing has landed in them
    // lately, so an existing selection never disappears from the list.
    for (const b of budgets) if (budgetKind(b) !== "INCOME") for (const c of bucketCategories(b)) all.add(c);

    const owner = new Map<string, BudgetLine>();
    for (const l of resolveBudgetLines(budgets, resolutionDate(window, today))) {
      if (budgetKind(l) === "INCOME") continue;
      for (const c of bucketCategories(l)) owner.set(c, l);
    }
    return { list: [...all].sort(), owner };
  }, [txs, budgets, window, today]);

  function openNew() {
    setDraft({
      seriesId: (globalThis.crypto?.randomUUID?.() ?? `s-${Date.now()}`),
      name: "", kind: "EXPENSE", fundingSource: "SALARY", period: "MONTHLY",
      amount: null, rollover: false, categories: [], label: "", notes: "",
      // Starts with the period you are looking at, so a budget created while
      // viewing October applies to the whole of October rather than a part-month
      // slice. Shown in the form and editable — never applied silently.
      effectiveFrom: window.fromIso, effectiveTo: "",
    });
    setEditMode("change");
    setPanel({ kind: "new" });
  }

  function openEdit(line: BudgetLine) {
    setDraft({
      seriesId: line.seriesId,
      name: line.name ?? "",
      kind: budgetKind(line),
      fundingSource: (line.fundingSource ?? "SALARY") as FundingSource,
      period: (line.period ?? "MONTHLY") as BudgetPeriod,
      amount: line.amount ?? null,
      rollover: line.rollover ?? false,
      categories: bucketCategories(line),
      label: line.label ?? "",
      notes: line.notes ?? "",
      effectiveFrom: line.effectiveFrom ?? "",
      effectiveTo: line.effectiveTo ?? "",
    });
    // A change defaults to the next period boundary: mid-period it would make
    // every pace number ambiguous (which budget was it measured against?), so
    // the new version starts when the current one is done.
    setEditMode("change");
    setChangeFrom(nextDayIso(window.toIso));
    setPanel({ kind: "edit", current: line });
  }

  async function handleSave() {
    if (!draft || !panel) return;
    if (!draft.name.trim())       { notifyError("Name is required"); return; }
    if (draft.amount == null)     { notifyError("Amount is required"); return; }
    if (!draft.effectiveFrom) { notifyError("A budget needs a date it takes effect"); return; }
    if (draft.effectiveTo && draft.effectiveTo < draft.effectiveFrom) {
      notifyError("“In force until” is before “in force from” — that version could never apply");
      return;
    }
    if (draft.kind !== "INCOME" && draft.categories.length === 0) {
      notifyError("Pick at least one category — a spending bucket with none measures nothing");
      return;
    }
    setSaving(true);
    try {
      if (panel.kind === "edit" && editMode === "correct") {
        // The old value was never true — there is no history to preserve.
        await mutate(client.models.financeBudget.update({
          id: panel.current.id,
          name: draft.name.trim(), kind: draft.kind as any, fundingSource: draft.fundingSource as any,
          categories: draft.categories, amount: draft.amount,
          period: draft.period as any, rollover: draft.rollover,
          label: draft.label || null, notes: draft.notes || null,
          // Validity is editable here too: a date typed wrong is a correction,
          // not a reason to manufacture another version.
          effectiveFrom: draft.effectiveFrom,
          effectiveTo: draft.effectiveTo || null,
        } as any));
      } else {
        const current = panel.kind === "edit" ? panel.current : null;
        // A new budget starts on the date shown in the form; only a change to an
        // existing one uses the separate "new version from" date.
        const from    = panel.kind === "edit" ? changeFrom : draft.effectiveFrom;
        const { insert, close } = planBudgetChange(current, {
          seriesId: draft.seriesId, name: draft.name.trim(), kind: draft.kind, categories: draft.categories,
          amount: draft.amount, fundingSource: draft.fundingSource, period: draft.period,
          rollover: draft.rollover, label: draft.label || null, notes: draft.notes || null,
        }, from);
        // Insert BEFORE closing: a failure here leaves a harmless overlap
        // (greatest effectiveFrom wins), where the reverse order would leave a
        // gap with no budget at all — the failure you cannot see on the page.
        await mutate(client.models.financeBudget.create(insert as any));
        if (close) {
          await mutate(client.models.financeBudget.update({ id: close.id, effectiveTo: close.effectiveTo } as any));
        }
      }
      setPanel(null); setDraft(null);
      await fetchData();
    } catch (e) {
      reportError(e, "Save budget");
    } finally {
      setSaving(false);
    }
  }

  /**
   * End a budget without erasing it. Expiring closes the current version on a
   * date; every past period still resolves to the version that governed it, so
   * "did I adhere in July?" keeps working for a budget retired in September.
   * This is the one people actually want — deleting would rewrite the past.
   */
  async function handleExpire(line: BudgetLine, on: string) {
    if (!confirm(`Stop budgeting "${line.name}" after ${fmtDate(on)}?\n\nIts history is kept, so past periods still report against it.`)) return;
    setSaving(true);
    try {
      await mutate(client.models.financeBudget.update({ id: line.id, effectiveTo: on } as any));
      setPanel(null); setDraft(null);
      await fetchData();
    } catch (e) {
      reportError(e, "Expire budget");
    } finally {
      setSaving(false);
    }
  }

  /** Delete one version, or the whole series. Both rewrite history — hence the
   *  explicit choice and the warning, rather than a single ambiguous Delete. */
  async function handleDelete(line: BudgetLine, scope: "version" | "series") {
    const siblings = budgets.filter((b) => b.seriesId === line.seriesId);
    const msg = scope === "series"
      ? `Delete "${line.name}" and all ${siblings.length} version(s)?\n\nPast periods will no longer report against it. To stop budgeting going forward while keeping the history, expire it instead.`
      : `Delete just this version of "${line.name}"?\n\n${siblings.length > 1 ? "The other versions remain, which may leave a gap in its history." : "This removes the budget entirely."}`;
    if (!confirm(msg)) return;
    setSaving(true);
    try {
      const targets = scope === "series" ? siblings : [line];
      for (const t of targets) await mutate(client.models.financeBudget.delete({ id: t.id }));
      setPanel(null); setDraft(null);
      await fetchData();
    } catch (e) {
      reportError(e, "Delete");
    } finally {
      setSaving(false);
    }
  }

  if (authState !== "authenticated") return null;

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 min-w-0 overflow-y-auto px-4 py-5 md:px-8">
          {/* Breadcrumb */}
          <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
            <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
            <span>/</span>
            <span>Budget</span>
          </div>

          {/* Header + period selector — same layout as Review, deliberately. */}
          <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
            <div>
              <PageTitle>Budget</PageTitle>
              <p className="text-xs text-gray-400 mt-0.5">
                {model ? model.window.label : "—"} · what&apos;s left to spend, the forward view of{" "}
                <NextLink href="/finance/review" className="hover:underline" style={{ color: FINANCE_COLOR }}>Review</NextLink>
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="inline-flex rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
                {([["month", "Month"], ["quarter", "Quarter"], ["year", "Year"], ["last3", "Last 3 mo"]] as const).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setPKind(k)}
                    className="px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap"
                    style={pKind === k ? { backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR } : undefined}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {pKind === "month" && (
                <select
                  value={pMonth}
                  onChange={(e) => setPMonth(Number(e.target.value))}
                  className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-2 text-gray-700 dark:text-gray-200"
                >
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              )}
              {pKind === "quarter" && (
                <select
                  value={pQuarter}
                  onChange={(e) => setPQuarter(Number(e.target.value))}
                  className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-2 text-gray-700 dark:text-gray-200"
                >
                  {[1, 2, 3, 4].map((q) => <option key={q} value={q}>Q{q}</option>)}
                </select>
              )}
              {pKind !== "last3" && (
                <select
                  value={pYear}
                  onChange={(e) => setPYear(Number(e.target.value))}
                  className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-2 text-gray-700 dark:text-gray-200"
                >
                  {availableYears.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              )}
              <button
                onClick={openNew}
                className="rounded-lg px-3 py-2 text-xs font-medium whitespace-nowrap"
                style={{ backgroundColor: withAlpha(FINANCE_COLOR, 0x22), color: FINANCE_COLOR }}
              >
                + Add budget
              </button>
            </div>
          </div>

          {loading && <PageLoading />}

          {!loading && model && (
            <>
              {/* Window */}

              {/* History problems — these are datastore invariants nothing else enforces. */}
              {model.issues.length > 0 && (
                <Card className="mt-4" >
                  <p className="text-sm font-semibold mb-2" style={{ color: NEGATIVE }}>
                    {model.issues.length} problem{model.issues.length === 1 ? "" : "s"} in budget history
                  </p>
                  <ul className="space-y-1">
                    {model.issues.map((i, n) => (
                      <li key={n} className="text-xs text-gray-600 dark:text-gray-300">
                        <span className="font-mono text-[10px] uppercase mr-1.5" style={{ color: NEGATIVE }}>{i.kind}</span>
                        <strong>{i.name}</strong> — {i.detail}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              {/* Row 1 — the period at a glance. */}
              <SectionTitle hint={model.closed
                ? "period closed"
                : `${Math.round(model.elapsed * 100)}% elapsed · ${model.daysLeft} day${model.daysLeft === 1 ? "" : "s"} left`}>
                Overview
              </SectionTitle>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <Card>
                  <p className="text-[10px] uppercase tracking-widest text-gray-400">Budget consumed</p>
                  {model.overall.budgeted > 0 ? (
                    <>
                      <div className="flex items-baseline justify-between gap-2 mt-1">
                        <span className="text-lg font-bold"
                          style={{ color: model.overall.pct != null && model.overall.pct > model.elapsed + 0.05 ? NEGATIVE : POSITIVE }}>
                          {fmtCurrency(model.overall.spent)}
                        </span>
                        <span className="text-xs text-gray-400">of {fmtCurrency(model.overall.budgeted)}</span>
                      </div>
                      <div className="relative h-2 rounded-full bg-gray-100 dark:bg-white/10 mt-2 overflow-hidden">
                        <div className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, (model.overall.pct ?? 0) * 100)}%`,
                            backgroundColor: model.overall.pct != null && model.overall.pct > model.elapsed + 0.05 ? NEGATIVE : POSITIVE,
                          }} />
                        {!model.closed && (
                          <div className="absolute top-0 bottom-0 w-px bg-gray-400 dark:bg-gray-300"
                            style={{ left: `${model.elapsed * 100}%` }} title="where you'd be exactly on pace" />
                        )}
                      </div>
                      <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1.5">
                        {model.overall.remaining >= 0
                          ? `${fmtCurrency(model.overall.remaining)} left across ${model.views.length} budget${model.views.length === 1 ? "" : "s"}`
                          : `${fmtCurrency(-model.overall.remaining)} over across ${model.views.length} budget${model.views.length === 1 ? "" : "s"}`}
                      </p>
                      {!model.closed && model.overall.projected != null && (
                        <p className="text-[11px] mt-0.5"
                          style={{ color: model.overall.projected > model.overall.budgeted ? NEGATIVE : POSITIVE }}>
                          {fmtCurrency(model.overall.projected)} projected at this rate
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-[11px] text-gray-400 mt-2">No spending budgets in force for this period.</p>
                  )}
                </Card>

                {/* Income not promised to any budget — what you keep if you
                    spend exactly to plan. Negative means the budgets promise
                    more than the income declares. */}
                <Card>
                  <p className="text-[10px] uppercase tracking-widest text-gray-400">Unallocated income</p>
                  <p className="text-lg font-bold mt-1"
                    style={{ color: model.overall.unallocated < 0 ? NEGATIVE : POSITIVE }}>
                    {fmtCurrency(model.overall.unallocated)}
                  </p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                    {fmtCurrency(model.overall.income)} declared − {fmtCurrency(model.overall.budgeted)} budgeted
                  </p>
                  <p className="text-[11px] mt-1" style={{ color: model.overall.unallocated < 0 ? NEGATIVE : "inherit" }}>
                    {model.overall.income === 0
                      ? "No income declared for this period."
                      : model.overall.unallocated >= 0
                        ? "Saved if you spend exactly to budget."
                        : "Budgets promise more than the declared income."}
                  </p>
                </Card>

                {/* Only the buckets actually over — not netted against the ones
                    under, because being under on one does not pay for the other. */}
                <Card>
                  <p className="text-[10px] uppercase tracking-widest text-gray-400">Over budget</p>
                  <p className="text-lg font-bold mt-1"
                    style={{ color: model.overall.overspend > 0 ? NEGATIVE : POSITIVE }}>
                    {fmtCurrency(model.overall.overspend)}
                  </p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                    {model.views.filter((v) => v.spent > v.budgeted).length} of {model.views.length} budget
                    {model.views.length === 1 ? "" : "s"} exceeded
                  </p>
                  <p className="text-[11px] mt-1">
                    {model.overall.overspend > 0
                      ? "Recovered by holding each to its budget."
                      : "Nothing over yet."}
                  </p>
                </Card>

                {/* Money in minus money out. The only card here about cash
                    rather than plan, and the one that still means something
                    once the period has closed. */}
                <Card>
                  <p className="text-[10px] uppercase tracking-widest text-gray-400">Net this period</p>
                  <p className="text-lg font-bold mt-1"
                    style={{ color: model.overall.net >= 0 ? POSITIVE : NEGATIVE }}>
                    {fmtCurrency(model.overall.net)}
                  </p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                    {fmtCurrency(model.overall.received)} received − {fmtCurrency(model.overall.spent)} spent
                  </p>
                  <p className="text-[11px] mt-1">
                    {model.overall.received === 0
                      ? "No income has landed in this period."
                      : model.overall.net >= 0 ? "Kept." : "Spent more than arrived."}
                  </p>
                </Card>
              </div>

              {/* Row 2 — income. Everything money COMING IN lives here; the
                  list below is only money going out. */}
              <SectionTitle hint={`${fmtCurrency(model.overall.income)} declared`}>Income</SectionTitle>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {model.pools.map((p) => {
                  const over = p.unallocated < 0;
                  const lines = model.incomeViews.filter(
                    (v) => (v.line.fundingSource ?? "OTHER") === p.source);
                  return (
                    <Card key={p.source}>
                      <p className="text-[10px] uppercase tracking-widest text-gray-400">
                        {FUNDING_SOURCE_LABELS[p.source]} income
                      </p>
                      {p.declared ? (
                        <>
                          <div className="flex items-baseline justify-between gap-2 mt-1">
                            <span className="text-lg font-bold">{fmtCurrency(p.forecast)}</span>
                            <span className="text-xs text-gray-400">{fmtCurrency(p.received)} received</span>
                          </div>
                          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                            {fmtCurrency(p.allocated)} allocated to budgets
                          </p>
                          <p className="text-[11px] mt-0.5" style={{ color: over ? NEGATIVE : POSITIVE }}>
                            {over ? `${fmtCurrency(-p.unallocated)} over-committed` : `${fmtCurrency(p.unallocated)} unallocated`}
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-lg font-bold mt-1 text-gray-400">—</p>
                          <p className="text-[11px] mt-0.5" style={{ color: WARNING }}>
                            No income budget declares this pool. {fmtCurrency(p.allocated)} allocated against nothing.
                          </p>
                        </>
                      )}
                      {lines.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-gray-100 dark:border-darkBorder space-y-1">
                          {lines.map((v) => (
                            <div key={v.line.id} className="flex items-center justify-between gap-2">
                              <span className="text-[11px] truncate">{v.line.name}</span>
                              <span className="flex items-center gap-2 flex-shrink-0">
                                <span className="text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
                                  {fmtCurrency(v.budgeted)}
                                </span>
                                <button onClick={() => openEdit(v.line)} className="text-[11px] px-1 py-2 hover:underline"
                                  style={{ color: FINANCE_COLOR }}>Edit</button>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>

              {/* Row 3 — spending buckets, money going out only. */}
              <SectionTitle hint={model.views.length > 0
                ? `${fmtCurrency(model.overall.spent)} of ${fmtCurrency(model.overall.budgeted)}`
                : undefined}>
                Budgets
              </SectionTitle>
              {model.views.length === 0 && model.realized.length === 0 ? (
                <div>
                  <EmptyState
                    label="No budgets in force for this period — group a few categories into a bucket to start."
                    onAdd={openNew}
                  />
                </div>
              ) : (
                <div className="space-y-3">
                  {model.views.map((v) => (
                    <BucketRow key={v.line.id} v={v} onEdit={openEdit} closed={model.closed}
                      versions={model.versions.get(v.line.seriesId)?.length ?? 1}
                      rows={model.rowsByLine.get(v.line.id) ?? []} accountName={accountName} />
                  ))}
                </div>
              )}

              {/* Real spending in a period that predates the budget. Shown as
                  what happened, with no budget figure invented for it. */}
              {model.realized.length > 0 && (
                <div>
                  <SectionTitle hint="real spending, no budget was in force">
                    Before these budgets existed
                  </SectionTitle>
                  <div className="space-y-2">
                    {model.realized.map((r) => (
                      <RealizedRow key={r.series.seriesId} s={r.series} spent={r.spent}
                        rows={r.rows} accountName={accountName} />
                    ))}
                  </div>
                </div>
              )}

              {/* Unassigned — deliberately loud: there is no default funding source. */}
              {model.unassigned.length > 0 && (
                <>
                <SectionTitle hint={`${fmtCurrency(model.unassigned.reduce((a, u) => a + u.spent, 0))} unbudgeted`}>
                  In no budget
                </SectionTitle>
                <Card>
                  <p className="text-sm font-semibold mb-1" style={{ color: WARNING }}>
                    {model.unassigned.length} categor{model.unassigned.length === 1 ? "y" : "ies"} with no budget
                  </p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-3">
                    Spending here counts against nothing. Every category needs a funding source — none is assumed.
                  </p>
                  <div className="divide-y divide-gray-100 dark:divide-gray-700 border-t border-gray-100 dark:border-darkBorder">
                    {model.unassigned.map((u) => (
                      <UnassignedRow key={u.category} category={u.category} spent={u.spent}
                        rows={model.rowsByCategory.get(u.category) ?? []} accountName={accountName} />
                    ))}
                  </div>
                </Card>
                </>
              )}
              {/* Every budget that exists, in force or not. A period view cannot
                  show a budget staged for next year or retired last spring. */}
              {model.series.length > 0 && (
                <div>
                  <SectionTitle hint={`${model.series.length} in total, in force or not`}>
                    All budgets
                  </SectionTitle>
                  <button
                    onClick={() => setShowAll((x) => !x)}
                    className="text-xs py-3 hover:underline"
                    style={{ color: FINANCE_COLOR }}
                  >
                    {showAll ? "Hide" : "Show"} all {model.series.length} budget{model.series.length === 1 ? "" : "s"} {showAll ? "▴" : "▾"}
                  </button>
                  {showAll && (
                    <div className="mt-2 rounded-lg border border-gray-200 dark:border-darkBorder overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50 dark:bg-darkElevated text-[10px] uppercase tracking-widest text-gray-400">
                          <tr>
                            <th className="px-3 py-2 text-left">Budget</th>
                            <th className="px-3 py-2 text-left">Funded by</th>
                            <th className="px-3 py-2 text-right">Current</th>
                            <th className="px-3 py-2 text-left">Status</th>
                            <th className="px-3 py-2 text-left">History</th>
                            <th className="px-3 py-2" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                          {model.series.map((sx) => <SeriesRow key={sx.seriesId} s={sx} onEdit={openEdit} />)}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {panel && draft && (
          <SlideOverPanel
            title={panel.kind === "new" ? "New budget" : `Edit “${draft.name}”`}
            onClose={() => { setPanel(null); setDraft(null); }}
            footer={
              <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-gray-200 dark:border-darkBorder flex-shrink-0">
                {panel.kind === "edit" ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    {panel.current.effectiveTo == null && (
                      <button
                        onClick={() => handleExpire(panel.current, model?.window.toIso ?? today)}
                        disabled={saving}
                        className="px-3 py-2 rounded-lg text-xs font-semibold border border-gray-300 dark:border-darkBorder disabled:opacity-50"
                        style={{ color: WARNING }}
                        title="Stop budgeting this after the selected period, keeping its history"
                      >
                        Expire
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(panel.current, "version")}
                      disabled={saving}
                      className="px-3 py-2 rounded-lg text-xs font-semibold border border-red-300 dark:border-red-800 text-red-500 dark:text-red-400 disabled:opacity-50"
                    >
                      Delete version
                    </button>
                    {budgets.filter((b) => b.seriesId === panel.current.seriesId).length > 1 && (
                      <button
                        onClick={() => handleDelete(panel.current, "series")}
                        disabled={saving}
                        className="px-3 py-2 rounded-lg text-xs font-semibold border border-red-300 dark:border-red-800 text-red-500 dark:text-red-400 disabled:opacity-50"
                      >
                        Delete all
                      </button>
                    )}
                  </div>
                ) : <span />}
                <SaveButton
                  onSave={handleSave}
                  saving={saving}
                  disabled={!draft.name.trim() || draft.amount == null
                    || (draft.kind !== "INCOME" && draft.categories.length === 0)}
                />
              </div>
            }
          >
            {panel.kind === "new" && (
              <div>
                <label className={labelCls}>In force from *</label>
                <input type="date" className={inputCls} value={draft.effectiveFrom}
                  onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })} />
                <p className="text-[11px] text-gray-400 mt-1">
                  The first day this budget applies. Periods before it report no budget for this
                  line, rather than pretending it existed.
                </p>
              </div>
            )}

            {panel.kind === "edit" && (
              <div>
                <label className={labelCls}>What kind of edit?</label>
                <div className="space-y-2 mt-1">
                  <label className="flex items-start gap-2 p-2 rounded-lg cursor-pointer border border-gray-200 dark:border-darkBorder">
                    <input type="radio" className="mt-1" checked={editMode === "change"}
                      onChange={() => setEditMode("change")} />
                    <span className="text-xs">
                      <strong>Change it</strong> — the budget genuinely moved.
                      <span className="block text-gray-500 dark:text-gray-400 mt-0.5">
                        Keeps this version as history and starts a new one, so past periods stay judged
                        against the budget that was actually in force.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 p-2 rounded-lg cursor-pointer border border-gray-200 dark:border-darkBorder">
                    <input type="radio" className="mt-1" checked={editMode === "correct"}
                      onChange={() => setEditMode("correct")} />
                    <span className="text-xs">
                      <strong>Correct it</strong> — the number was wrong.
                      <span className="block text-gray-500 dark:text-gray-400 mt-0.5">
                        Rewrites this version in place. History reads as though the corrected value
                        always applied, because the old one was never true.
                      </span>
                    </span>
                  </label>
                </div>
                {editMode === "change" ? (
                  <div className="mt-2">
                    <label className={labelCls}>New version in force from</label>
                    <input type="date" className={inputCls} value={changeFrom}
                      onChange={(e) => setChangeFrom(e.target.value)} />
                    <p className="text-[11px] text-gray-400 mt-1">
                      Prefilled with the start of the next period ({fmtDate(nextDayIso(model?.window.toIso ?? today))}),
                      so this period keeps one budget and its pace stays unambiguous — change it to
                      anything you like. The current version is closed the day before. Expire, below,
                      ends the budget on that date instead of replacing it.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div>
                      <label className={labelCls}>In force from</label>
                      <input type="date" className={inputCls} value={draft.effectiveFrom}
                        onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })} />
                    </div>
                    <div>
                      <label className={labelCls}>In force until</label>
                      <input type="date" className={inputCls} value={draft.effectiveTo}
                        onChange={(e) => setDraft({ ...draft, effectiveTo: e.target.value })} />
                      <p className="text-[11px] text-gray-400 mt-1">Blank = open-ended.</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className={labelCls}>Name *</label>
              <input type="text" className={inputCls} placeholder="Discretionary purchases"
                value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>

            <div>
              <label className={labelCls}>This budget is *</label>
              <select className={inputCls} value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as BudgetKind })}>
                <option value="EXPENSE">Money going out — a spending bucket</option>
                <option value="INCOME">Money coming in — declares the pool</option>
              </select>
              {draft.kind === "INCOME" && (
                <p className="text-[11px] text-gray-400 mt-1">
                  This is what you say the pool is worth, not what the feed guesses. Expense budgets
                  on the same funding source are measured against it.
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>Funded by *</label>
                <select className={inputCls} value={draft.fundingSource}
                  onChange={(e) => {
                    const fs = e.target.value as FundingSource;
                    setDraft({ ...draft, fundingSource: fs, period: DEFAULT_PERIOD[fs] });
                  }}>
                  {FUNDING_SOURCES.map((s) => <option key={s} value={s}>{FUNDING_SOURCE_LABELS[s]}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Per</label>
                <select className={inputCls} value={draft.period}
                  onChange={(e) => setDraft({ ...draft, period: e.target.value as BudgetPeriod })}>
                  {BUDGET_PERIODS.map((p) => (
                    <option key={p} value={p}>{BUDGET_PERIOD_LABELS[p]}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className={labelCls}>Amount *</label>
              <input type="number" step="0.01" min={0} className={inputCls} placeholder="0.00"
                value={draft.amount ?? ""}
                onChange={(e) => setDraft({ ...draft, amount: e.target.value === "" ? null : parseFloat(e.target.value) })} />
            </div>

            {draft.kind === "INCOME" ? (
              <p className="text-[11px] text-gray-400 rounded-lg p-3" style={{ backgroundColor: withAlpha(FINANCE_COLOR, 0x14) }}>
                No categories to pick. Every deposit is tagged &ldquo;Income&rdquo;, so a category could not
                tell salary from an RSU sale — what actually arrives is matched by funding source
                instead, using the same split Review uses, and reported on the pool rather than per line.
              </p>
            ) : (
              <div>
                <label className={labelCls}>Categories * ({draft.categories.length})</label>
                <p className="text-[11px] text-gray-400 mb-1.5">
                  A category can sit in only one spending budget — its spend cannot be split between two.
                </p>
                <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-200 dark:border-darkBorder divide-y divide-gray-100 dark:divide-gray-700">
                  {categoryOptions.list.length === 0 && (
                    <p className="px-3 py-3 text-xs text-gray-400">No spending categories seen yet.</p>
                  )}
                  {categoryOptions.list.map((cat) => {
                    const owner = categoryOptions.owner.get(cat);
                    const takenBy = owner && owner.seriesId !== draft.seriesId ? owner.name : null;
                    const checked = draft.categories.includes(cat);
                    return (
                      <label key={cat}
                        className={`flex items-center gap-2 px-3 py-3 text-xs ${takenBy ? "opacity-50" : "cursor-pointer"}`}>
                        <input type="checkbox" checked={checked} disabled={!!takenBy}
                          onChange={(e) => setDraft({
                            ...draft,
                            categories: e.target.checked
                              ? [...draft.categories, cat]
                              : draft.categories.filter((c) => c !== cat),
                          })} />
                        <span className="flex-1">{cat}</span>
                        {takenBy && <span className="text-[10px] text-gray-400">in &ldquo;{takenBy}&rdquo;</span>}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <label className="flex items-center gap-2 text-xs p-1 cursor-pointer">
              <input type="checkbox" checked={draft.rollover}
                onChange={(e) => setDraft({ ...draft, rollover: e.target.checked })} />
              Unspent carries into the next period
            </label>

            <div>
              <label className={labelCls}>Why it changed</label>
              <input type="text" className={inputCls} placeholder="post-raise, baby arrives…"
                value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </div>

            <div>
              <label className={labelCls}>Notes</label>
              <textarea rows={2} className={`${inputCls} resize-none`}
                value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
            </div>
          </SlideOverPanel>
        )}
      </div>
    </FinanceLayout>
  );
}

/** Matches the Review page's section heading exactly. */
function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between mb-3 gap-2 flex-wrap mt-8">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-purple dark:text-rose">{children}</h2>
      {hint && <span className="text-xs text-gray-400">{hint}</span>}
    </div>
  );
}

function nextDayIso(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function BucketRow({ v, onEdit, closed, versions, rows, accountName }: {
  v: BudgetLineView; onEdit: (l: BudgetLine) => void; closed: boolean; versions: number;
  rows: TransactionRecord[]; accountName: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const income = budgetKind(v.line) === "INCOME";
  const color = STATUS_COLOR[income ? "INCOME" : "EXPENSE"][v.status];
  const spentPct    = v.budgeted > 0 ? Math.min(100, (v.spent / v.budgeted) * 100) : 0;
  const expectedPct = Math.min(100, v.elapsed * 100);
  const cats = bucketCategories(v.line);

  return (
    <Card>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{v.line.name}</span>
            <Badge color={income ? POSITIVE : FINANCE_COLOR} size="xs">
              {income ? "Income · " : ""}{FUNDING_SOURCE_LABELS[(v.line.fundingSource ?? "OTHER") as FundingSource]}
            </Badge>
            {v.line.label && <span className="text-[10px] text-gray-400">{v.line.label}</span>}
            {versions > 1 && (
              <Badge color={WARNING} size="xs" uppercase={false}>
                {versions} versions this period — showing the one in force
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {cats.map((c) => (
              <span key={c} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-300">{c}</span>
            ))}
          </div>
        </div>
        <button onClick={() => onEdit(v.line)} className="text-xs px-2 py-3 hover:underline flex-shrink-0" style={{ color: FINANCE_COLOR }}>
          Edit
        </button>
      </div>

      <div className="flex items-baseline justify-between gap-2 mt-3">
        <span className="text-lg font-bold" style={{ color }}>{fmtCurrency(v.spent)}</span>
        <span className="text-xs text-gray-400">of {fmtCurrency(v.budgeted)}</span>
      </div>

      {/* Spend bar with an elapsed-time marker — the comparison that matters is
          spend against time gone, not spend against the whole period. */}
      <div className="relative h-2 rounded-full bg-gray-100 dark:bg-white/10 mt-2 overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${spentPct}%`, backgroundColor: color }} />
        {!closed && (
          <div className="absolute top-0 bottom-0 w-px bg-gray-400 dark:bg-gray-300"
            style={{ left: `${expectedPct}%` }} title="where you'd be exactly on pace" />
        )}
      </div>

      <div className="flex items-center justify-between gap-2 mt-2 text-[11px] text-gray-500 dark:text-gray-400 flex-wrap">
        <span>
          {v.committed > 0 && <>{fmtCurrency(v.committed)} committed · {fmtCurrency(v.variable)} variable · </>}
          {v.remaining >= 0 ? `${fmtCurrency(v.remaining)} left` : `${fmtCurrency(-v.remaining)} over`}
        </span>
        <span style={{ color }}>
          {closed
              ? (v.remaining >= 0
                  ? `${income ? "short by" : "under by"} ${fmtCurrency(Math.abs(v.remaining))}`
                  : `over by ${fmtCurrency(-v.remaining)}`)
              : v.pace == null ? "not started" : `${v.pace.toFixed(2)}× pace`}
          {!closed && v.safeDailyRemaining > 0 && ` · ${fmtCurrency(v.safeDailyRemaining)}/day`}
        </span>
      </div>

      <TransactionList txs={rows} accountName={accountName} open={open} onToggle={() => setOpen((x) => !x)} />
    </Card>
  );
}

/**
 * The rows behind a figure. Shares budgetTransactions with the total it sits
 * under, so the list always adds up to the number it opened from — a breakdown
 * that can disagree with its own headline is worse than none.
 */
function TransactionList({ txs, accountName, open, onToggle }: {
  txs: TransactionRecord[];
  accountName: Map<string, string>;
  open: boolean;
  onToggle: () => void;
}) {
  if (txs.length === 0) {
    return <p className="text-[11px] text-gray-400 mt-2">No transactions in this period.</p>;
  }
  const total = txs.reduce((s, t) => s + Math.abs(t.amount ?? 0), 0);
  return (
    <>
      <button onClick={onToggle} aria-expanded={open}
        className="text-[11px] py-3 hover:underline" style={{ color: FINANCE_COLOR }}>
        {open ? "Hide" : "Show"} {txs.length} transaction{txs.length === 1 ? "" : "s"} {open ? "▴" : "▾"}
      </button>
      {open && (
        <div className="-mx-1 border-t border-gray-100 dark:border-darkBorder max-h-96 overflow-y-auto">
          {txs.map((t) => (
            <div key={t.id} className="flex items-center gap-2 px-1 py-2 rounded hover:bg-gray-50 dark:hover:bg-white/5">
              <span className="text-[11px] text-gray-400 tabular-nums flex-shrink-0 w-16">{fmtDate(t.date)}</span>
              <span className="text-xs truncate flex-1">{t.description || "—"}</span>
              <span className="text-[10px] text-gray-400 flex-shrink-0 hidden sm:inline">
                {effectiveCategory(t)} · {accountName.get(t.accountId) ?? "—"}
              </span>
              <span className="text-xs tabular-nums flex-shrink-0" style={{ color: amountColor(t.amount ?? 0) }}>
                {fmtCurrency(Math.abs(t.amount ?? 0))}
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between px-1 py-2 border-t border-gray-100 dark:border-darkBorder">
            <span className="text-[11px] text-gray-400">{txs.length} transactions</span>
            <span className="text-xs font-semibold tabular-nums">{fmtCurrency(total)}</span>
          </div>
        </div>
      )}
    </>
  );
}

function SeriesRow({ s, onEdit }: { s: BudgetSeries; onEdit: (l: BudgetLine) => void }) {
  const income = s.kind === "INCOME";
  const status = s.startsOn ? { text: `starts ${fmtDate(s.startsOn)}`, color: WARNING }
    : s.endedOn ? { text: `ended ${fmtDate(s.endedOn)}`, color: "#9ca3af" }
    : s.latest.active === false ? { text: "paused", color: WARNING }
    : { text: "in force", color: POSITIVE };

  return (
    <tr>
      <td className="px-3 py-2.5">
        <span className="font-medium">{s.name}</span>
        {income && <span className="ml-1.5 text-[10px]" style={{ color: POSITIVE }}>income</span>}
        {!income && (
          <span className="block text-[10px] text-gray-400 mt-0.5">
            {bucketCategories(s.latest).join(", ") || "no categories"}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-gray-500 dark:text-gray-400">
        {FUNDING_SOURCE_LABELS[(s.fundingSource ?? "OTHER") as FundingSource]}
        <span className="block text-[10px] text-gray-400">
          per {BUDGET_PERIOD_LABELS[(s.latest.period ?? "MONTHLY") as BudgetPeriod].toLowerCase()}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">{fmtCurrency(Math.abs(s.latest.amount ?? 0))}</td>
      <td className="px-3 py-2.5"><span style={{ color: status.color }}>{status.text}</span></td>
      <td className="px-3 py-2.5 text-gray-500 dark:text-gray-400">
        {s.versions.length === 1 ? "—" : (
          <span title={s.versions.map((v) =>
            `${v.effectiveFrom}→${v.effectiveTo ?? "open"}: ${fmtCurrency(Math.abs(v.amount ?? 0))}${v.label ? ` (${v.label})` : ""}`
          ).join("\n")}>
            {s.versions.length} versions, since {fmtDate(s.versions[s.versions.length - 1].effectiveFrom ?? "")}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-right">
        <button onClick={() => onEdit(s.latest)} className="px-2 py-2 hover:underline" style={{ color: FINANCE_COLOR }}>Edit</button>
      </td>
    </tr>
  );
}

/** A bucket's real spending in a period that predates its budget. Same
 *  drill-down as a budgeted row, so every figure on the page opens. */
function RealizedRow({ s, spent, rows, accountName }: {
  s: BudgetSeries; spent: number; rows: TransactionRecord[]; accountName: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <span className="text-sm font-semibold">{s.name}</span>
          <span className="block text-[10px] text-gray-400 mt-0.5">
            {bucketCategories(s.latest).join(", ")}
          </span>
        </div>
        <div className="text-right flex-shrink-0">
          <span className="text-base font-bold" style={{ color: NEGATIVE }}>{fmtCurrency(spent)}</span>
          <span className="block text-[11px] text-gray-400">
            no budget {s.startsOn ? `until ${fmtDate(s.startsOn)}` : "this period"}
          </span>
        </div>
      </div>
      <TransactionList txs={rows} accountName={accountName} open={open} onToggle={() => setOpen((x) => !x)} />
    </Card>
  );
}

/** A category no budget covers. Expands like every other figure on the page —
 *  deciding where spending belongs is much easier once you can see what it is. */
function UnassignedRow({ category, spent, rows, accountName }: {
  category: string; spent: number; rows: TransactionRecord[]; accountName: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-1">
      <button onClick={() => setOpen((x) => !x)} aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 py-2 text-left">
        <span className="text-xs flex items-center gap-1.5">
          <span className="text-gray-400">{open ? "▴" : "▾"}</span>
          {category}
          <span className="text-[10px] text-gray-400">
            {rows.length} transaction{rows.length === 1 ? "" : "s"}
          </span>
        </span>
        <span className="text-xs tabular-nums font-semibold" style={{ color: WARNING }}>{fmtCurrency(spent)}</span>
      </button>
      {open && (
        <div className="max-h-80 overflow-y-auto border-t border-gray-100 dark:border-darkBorder">
          {rows.map((t) => (
            <div key={t.id} className="flex items-center gap-2 px-1 py-2">
              <span className="text-[11px] text-gray-400 tabular-nums flex-shrink-0 w-16">{fmtDate(t.date)}</span>
              <span className="text-xs truncate flex-1">{t.description || "—"}</span>
              <span className="text-[10px] text-gray-400 flex-shrink-0 hidden sm:inline">
                {accountName.get(t.accountId) ?? "—"}
              </span>
              <span className="text-xs tabular-nums flex-shrink-0" style={{ color: amountColor(t.amount ?? 0) }}>
                {fmtCurrency(Math.abs(t.amount ?? 0))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
