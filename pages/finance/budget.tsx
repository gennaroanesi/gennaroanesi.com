import React, { useCallback, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import FinanceLayout from "@/layouts/finance";
import { mutate, reportError, notifyError } from "@/components/common/mutate";
import {
  client, listAll, fetchTransactions, fetchBudgets,
  FINANCE_COLOR, fmtCurrency, fmtDate, todayIso,
  inputCls, labelCls, SaveButton, DeleteButton, EmptyState,
  type TransactionRecord, type RecurringRecord,
} from "@/components/finance/_shared";
import { occurrencesInWindow } from "@/components/finance/cashflow";
import {
  resolveBudgetLines, validateBudgetHistory, planBudgetChange, bucketCategories,
  budgetWindow, elapsedFraction, daysBetween, spendByCategory, committedByCategory,
  computeLineView, summarizePools, unassignedCategories, forecastBySource, enteredVestDates,
  FUNDING_SOURCES, FUNDING_SOURCE_LABELS, DEFAULT_PERIOD,
  type BudgetLine, type BudgetLineView, type FundingSource, type BudgetPeriod,
} from "@/components/finance/budget";
import { summarizeIncomeSources, periodRange } from "@/components/finance/review";
import { POSITIVE, NEGATIVE, WARNING, withAlpha } from "@/lib/colors";
import { SlideOverPanel, PageTitle, PageLoading, Card, Badge } from "@/components/common/ui";

type Draft = {
  seriesId: string;
  name: string;
  fundingSource: FundingSource;
  period: BudgetPeriod;
  amount: number | null;
  rollover: boolean;
  categories: string[];
  label: string;
  notes: string;
};

type Panel =
  | { kind: "new" }
  | { kind: "edit"; current: BudgetLine; mode: "correct" | "change"; from: string }
  | null;

const STATUS_COLOR = { under: POSITIVE, on: FINANCE_COLOR, over: NEGATIVE } as const;

export default function BudgetPage() {
  const { authState } = useRequireAuth();

  const [budgets, setBudgets]       = useState<BudgetLine[]>([]);
  const [txs, setTxs]               = useState<TransactionRecord[]>([]);
  const [recurrings, setRecurrings] = useState<RecurringRecord[]>([]);
  const [accounts, setAccounts]     = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);

  const [view, setView]   = useState<BudgetPeriod>("MONTHLY");
  const [panel, setPanel] = useState<Panel>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

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

  const vestDates = useMemo(() => enteredVestDates(recurrings), [recurrings]);
  const window    = useMemo(() => budgetWindow(view, today, vestDates), [view, today, vestDates]);

  /** Occurrence count for a rule inside a window — the cashflow engine, not a second copy. */
  const occurrencesOf = useCallback((r: RecurringRecord, from: string, to: string) =>
    occurrencesInWindow({
      id: r.id, description: r.description ?? "", amount: r.amount ?? 0, type: r.type as string,
      category: r.category, cadence: r.cadence as string, nextDate: r.nextDate,
      startDate: r.startDate, endDate: r.endDate, active: r.active,
      accountId: r.accountId, toAccountId: r.toAccountId,
    } as any, from, to).length, []);

  const model = useMemo(() => {
    if (!window) return null;
    const inForce = resolveBudgetLines(budgets, window.fromIso).filter(
      (l) => ((l.period ?? DEFAULT_PERIOD[(l.fundingSource ?? "OTHER") as FundingSource]) === view),
    );
    const spent     = spendByCategory(txs, window);
    const committed = committedByCategory(recurrings, window, occurrencesOf);
    const views     = inForce.map((l) => computeLineView(l, window, spent, committed, today));

    // Salary baseline comes from the Review's own income split, over a rolling
    // trailing window — not from this one, which may be half-elapsed and would
    // read as though half a paycheck existed.
    const trailing = periodRange({ kind: "last3", anchorIso: today });
    const income   = summarizeIncomeSources(txs, accounts as any, trailing);
    const forecast = forecastBySource(recurrings, window, occurrencesOf, income.salaryPerMonth);

    return {
      window,
      views,
      pools: summarizePools(views, forecast),
      unassigned: unassignedCategories(spent, inForce),
      issues: validateBudgetHistory(budgets, window.fromIso),
      elapsed: elapsedFraction(window, today),
      daysLeft: Math.max(0, daysBetween(today, window.toIso)),
    };
  }, [budgets, txs, recurrings, accounts, window, view, today, occurrencesOf]);

  // Every category the user could put in a bucket, plus who already owns it.
  const categoryOptions = useMemo(() => {
    const all = new Set<string>();
    for (const [c] of spendByCategory(txs, { fromIso: "1900-01-01", toIso: "2999-12-31", label: "" })) all.add(c);
    for (const b of budgets) for (const c of bucketCategories(b)) all.add(c);
    const owner = new Map<string, BudgetLine>();
    if (window) {
      for (const l of resolveBudgetLines(budgets, window.fromIso)) {
        for (const c of bucketCategories(l)) owner.set(c, l);
      }
    }
    return { list: [...all].sort(), owner };
  }, [txs, budgets, window]);

  function openNew() {
    setDraft({
      seriesId: (globalThis.crypto?.randomUUID?.() ?? `s-${Date.now()}`),
      name: "", fundingSource: "SALARY", period: "MONTHLY",
      amount: null, rollover: false, categories: [], label: "", notes: "",
    });
    setPanel({ kind: "new" });
  }

  function openEdit(line: BudgetLine, mode: "correct" | "change") {
    setDraft({
      seriesId: line.seriesId,
      name: line.name ?? "",
      fundingSource: (line.fundingSource ?? "SALARY") as FundingSource,
      period: (line.period ?? "MONTHLY") as BudgetPeriod,
      amount: line.amount ?? null,
      rollover: line.rollover ?? false,
      categories: bucketCategories(line),
      label: line.label ?? "",
      notes: line.notes ?? "",
    });
    // A change defaults to the next period boundary: mid-period it would make
    // every pace number on the page ambiguous (which budget was it measured
    // against?), so the new version starts when the current one is done.
    const nextStart = window ? nextDayIso(window.toIso) : today;
    setPanel({ kind: "edit", current: line, mode, from: nextStart });
  }

  async function handleSave() {
    if (!draft || !panel) return;
    if (!draft.name.trim())       { notifyError("Name is required"); return; }
    if (draft.amount == null)     { notifyError("Amount is required"); return; }
    if (draft.categories.length === 0) { notifyError("Pick at least one category"); return; }
    setSaving(true);
    try {
      if (panel.kind === "edit" && panel.mode === "correct") {
        // The old value was never true — there is no history to preserve.
        await mutate(client.models.financeBudget.update({
          id: panel.current.id,
          name: draft.name.trim(), fundingSource: draft.fundingSource as any,
          categories: draft.categories, amount: draft.amount,
          period: draft.period as any, rollover: draft.rollover,
          label: draft.label || null, notes: draft.notes || null,
        } as any));
      } else {
        const current = panel.kind === "edit" ? panel.current : null;
        const from    = panel.kind === "edit" ? panel.from : today;
        const { insert, close } = planBudgetChange(current, {
          seriesId: draft.seriesId, name: draft.name.trim(), categories: draft.categories,
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

  async function handleDelete(line: BudgetLine) {
    if (!confirm(`Delete this version of "${line.name}"? Other versions in its history are kept.`)) return;
    setSaving(true);
    try {
      await mutate(client.models.financeBudget.delete({ id: line.id }));
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
          {/* Header */}
          <div className="flex items-start justify-between mb-1 gap-2 flex-wrap">
            <div>
              <PageTitle>Budget</PageTitle>
              <p className="text-xs text-gray-400 mt-0.5">
                What&apos;s left to spend — the forward view of{" "}
                <NextLink href="/finance/review" className="hover:underline" style={{ color: FINANCE_COLOR }}>Review</NextLink>.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-darkBorder">
                {(["MONTHLY", "CYCLE"] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setView(p)}
                    className="px-3 py-3 text-xs font-medium"
                    style={view === p
                      ? { backgroundColor: withAlpha(FINANCE_COLOR, 0x22), color: FINANCE_COLOR }
                      : undefined}
                  >
                    {p === "MONTHLY" ? "Monthly" : "Per vest cycle"}
                  </button>
                ))}
              </div>
              <button
                onClick={openNew}
                className="rounded-lg px-3 py-3 text-sm font-medium"
                style={{ backgroundColor: withAlpha(FINANCE_COLOR, 0x22), color: FINANCE_COLOR }}
              >
                + Add budget
              </button>
            </div>
          </div>

          {loading && <PageLoading />}

          {/* No cycle boundary: ask rather than invent one. */}
          {!loading && view === "CYCLE" && !window && (
            <Card className="mt-4">
              <p className="text-sm font-semibold mb-1">No upcoming vest entered</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                A cycle budget runs from one vest to the next, so it needs the next vest date. Add it on{" "}
                <NextLink href="/finance/scheduled" className="hover:underline" style={{ color: FINANCE_COLOR }}>Scheduled</NextLink>{" "}
                as a one-time income event with funding source <strong>RSU</strong>. Nothing is assumed here —
                a guessed date would rescale every number on this page.
              </p>
            </Card>
          )}

          {!loading && model && (
            <>
              {/* Window */}
              <p className="text-xs text-gray-400 mt-3">
                {model.window.label} · {Math.round(model.elapsed * 100)}% elapsed · {model.daysLeft} day{model.daysLeft === 1 ? "" : "s"} left
              </p>

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

              {/* Pools */}
              {model.pools.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
                  {model.pools.map((p) => {
                    const over = p.unallocated < 0;
                    return (
                      <Card key={p.source}>
                        <p className="text-[10px] uppercase tracking-widest text-gray-400">{FUNDING_SOURCE_LABELS[p.source]}</p>
                        <p className="text-lg font-bold mt-1">{fmtCurrency(p.forecast)}</p>
                        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                          {fmtCurrency(p.allocated)} allocated
                        </p>
                        <p className="text-[11px] mt-0.5" style={{ color: over ? NEGATIVE : POSITIVE }}>
                          {over ? `${fmtCurrency(-p.unallocated)} over-committed` : `${fmtCurrency(p.unallocated)} unallocated`}
                        </p>
                      </Card>
                    );
                  })}
                </div>
              )}

              {/* Buckets */}
              {model.views.length === 0 ? (
                <div className="mt-6">
                  <EmptyState
                    label={`No ${view === "MONTHLY" ? "monthly" : "per-cycle"} budgets yet — group a few categories into a bucket to start.`}
                    onAdd={openNew}
                  />
                </div>
              ) : (
                <div className="mt-4 space-y-3">
                  {model.views.map((v) => <BucketRow key={v.line.id} v={v} onEdit={openEdit} />)}
                </div>
              )}

              {/* Unassigned — deliberately loud: there is no default funding source. */}
              {model.unassigned.length > 0 && (
                <Card className="mt-4">
                  <p className="text-sm font-semibold mb-1" style={{ color: WARNING }}>
                    {model.unassigned.length} categor{model.unassigned.length === 1 ? "y" : "ies"} in no budget
                  </p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-3">
                    Spending here counts against nothing. Every category needs a funding source — none is assumed.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {model.unassigned.map((u) => (
                      <span key={u.category}
                        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px]"
                        style={{ backgroundColor: withAlpha(WARNING, 0x22), color: WARNING }}>
                        {u.category}
                        <span className="tabular-nums opacity-80">{fmtCurrency(u.spent)}</span>
                      </span>
                    ))}
                  </div>
                </Card>
              )}
            </>
          )}
        </div>

        {panel && draft && (
          <SlideOverPanel
            title={panel.kind === "new" ? "New budget"
              : panel.mode === "correct" ? `Correct “${draft.name}”` : `Change “${draft.name}”`}
            onClose={() => { setPanel(null); setDraft(null); }}
            footer={
              <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-gray-200 dark:border-darkBorder flex-shrink-0">
                {panel.kind === "edit"
                  ? <DeleteButton onDelete={() => handleDelete(panel.current)} saving={saving} />
                  : <span />}
                <SaveButton
                  onSave={handleSave}
                  saving={saving}
                  disabled={!draft.name.trim() || draft.amount == null || draft.categories.length === 0}
                />
              </div>
            }
          >
            {panel.kind === "edit" && (
              <div className="rounded-lg p-3 text-[11px] leading-relaxed"
                style={{ backgroundColor: withAlpha(panel.mode === "correct" ? WARNING : FINANCE_COLOR, 0x18) }}>
                {panel.mode === "correct" ? (
                  <>Rewrites this version in place, keeping its dates. For a wrong number that was never true —
                  the history will read as though the corrected value always applied.</>
                ) : (
                  <>Keeps this version as history and starts a new one on <strong>{fmtDate(panel.from)}</strong>.
                  Past periods stay judged against the budget that was actually in force.</>
                )}
              </div>
            )}

            <div>
              <label className={labelCls}>Name *</label>
              <input type="text" className={inputCls} placeholder="Discretionary purchases"
                value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
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
                  <option value="MONTHLY">Month</option>
                  <option value="CYCLE">Vest cycle</option>
                </select>
              </div>
            </div>

            <div>
              <label className={labelCls}>Amount *</label>
              <input type="number" step="0.01" min={0} className={inputCls} placeholder="0.00"
                value={draft.amount ?? ""}
                onChange={(e) => setDraft({ ...draft, amount: e.target.value === "" ? null : parseFloat(e.target.value) })} />
            </div>

            <div>
              <label className={labelCls}>Categories * ({draft.categories.length})</label>
              <p className="text-[11px] text-gray-400 mb-1.5">
                A category can sit in only one budget — its spend cannot be split between two.
              </p>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-200 dark:border-darkBorder divide-y divide-gray-100 dark:divide-gray-700">
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
                      {takenBy && <span className="text-[10px] text-gray-400">in “{takenBy}”</span>}
                    </label>
                  );
                })}
              </div>
            </div>

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

function nextDayIso(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function BucketRow({ v, onEdit }: { v: BudgetLineView; onEdit: (l: BudgetLine, m: "correct" | "change") => void }) {
  const color = STATUS_COLOR[v.status];
  const spentPct    = v.budgeted > 0 ? Math.min(100, (v.spent / v.budgeted) * 100) : 0;
  const expectedPct = Math.min(100, v.elapsed * 100);
  const cats = bucketCategories(v.line);

  return (
    <Card>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{v.line.name}</span>
            <Badge color={FINANCE_COLOR} size="xs">
              {FUNDING_SOURCE_LABELS[(v.line.fundingSource ?? "OTHER") as FundingSource]}
            </Badge>
            {v.line.label && <span className="text-[10px] text-gray-400">{v.line.label}</span>}
          </div>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {cats.map((c) => (
              <span key={c} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-300">{c}</span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={() => onEdit(v.line, "correct")} className="text-xs px-2 py-3 hover:underline text-gray-400">Correct</button>
          <button onClick={() => onEdit(v.line, "change")} className="text-xs px-2 py-3 hover:underline" style={{ color: FINANCE_COLOR }}>Change</button>
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-2 mt-3">
        <span className="text-lg font-bold" style={{ color }}>{fmtCurrency(v.spent)}</span>
        <span className="text-xs text-gray-400">of {fmtCurrency(v.budgeted)}</span>
      </div>

      {/* Spend bar with an elapsed-time marker — the comparison that matters is
          spend against time gone, not spend against the whole period. */}
      <div className="relative h-2 rounded-full bg-gray-100 dark:bg-white/10 mt-2 overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${spentPct}%`, backgroundColor: color }} />
        <div className="absolute top-0 bottom-0 w-px bg-gray-400 dark:bg-gray-300" style={{ left: `${expectedPct}%` }} title="where you'd be exactly on pace" />
      </div>

      <div className="flex items-center justify-between gap-2 mt-2 text-[11px] text-gray-500 dark:text-gray-400 flex-wrap">
        <span>
          {v.committed > 0 && <>{fmtCurrency(v.committed)} committed · {fmtCurrency(v.variable)} variable · </>}
          {v.remaining >= 0 ? `${fmtCurrency(v.remaining)} left` : `${fmtCurrency(-v.remaining)} over`}
        </span>
        <span style={{ color }}>
          {v.pace == null ? "not started"
            : `${v.pace.toFixed(2)}× pace`}
          {v.safeDailyRemaining > 0 && ` · ${fmtCurrency(v.safeDailyRemaining)}/day`}
        </span>
      </div>
    </Card>
  );
}
