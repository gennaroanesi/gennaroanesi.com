import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useRouter } from "next/router";
import NextLink from "next/link";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  GoalRecord, MilestoneRecord, MilestoneStatus,
  AccountRecord, GoalFundingSourceRecord, HoldingLotRecord, TickerQuoteRecord,
  FINANCE_COLOR,
  fmtCurrency, fmtDate, todayIso, monthsUntil, goalPctColor,
  sortMilestones, milestoneStatus,
  computeGoalAllocations, effectiveGoalAmount, goalHasFundingSource, goalHasVolatileFunding,
  projectGoal, resolvedGrowthRate, DEFAULT_EXPECTED_GROWTH,
  accountTotalValue, buildQuoteMap, ACCOUNT_TYPE_LABELS,
  listAll,
  inputCls, labelCls,
  SaveButton, DeleteButton, EmptyState,
} from "@/components/finance/_shared";

type PanelState =
  | { kind: "new" }
  | { kind: "edit"; goal: GoalRecord }
  | null;

// Draft row for a milestone being edited in the goal panel.
// Existing milestones have `id`; new unsaved ones have no id (persisted on Save).
type MilestoneDraft = {
  id?: string;
  targetDate: string;
  targetAmount: number | "";
  label?: string | null;
  notes?: string | null;
};

export default function GoalsPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [goals,      setGoals]      = useState<GoalRecord[]>([]);
  const [milestones, setMilestones] = useState<MilestoneRecord[]>([]);
  const [accounts,   setAccounts]   = useState<AccountRecord[]>([]);
  const [mappings,   setMappings]   = useState<GoalFundingSourceRecord[]>([]);
  const [lots,       setLots]       = useState<HoldingLotRecord[]>([]);
  const [quotes,     setQuotes]     = useState<TickerQuoteRecord[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [panel,      setPanel]      = useState<PanelState>(null);
  const [draft,      setDraft]      = useState<Partial<GoalRecord>>({});
  const [msDrafts,   setMsDrafts]   = useState<MilestoneDraft[]>([]);
  // IDs of milestones the user has removed via the UI; deleted on Save.
  const [msDeleted,  setMsDeleted]  = useState<string[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [gs, ms, accs, maps, lotRecs, quoteRecs] = await Promise.all([
        listAll(client.models.financeSavingsGoal),
        listAll(client.models.financeGoalMilestone),
        listAll(client.models.financeAccount),
        listAll(client.models.financeGoalFundingSource),
        listAll(client.models.financeHoldingLot),
        listAll(client.models.financeTickerQuote),
      ]);
      setGoals(gs);
      setMilestones(ms);
      setAccounts(accs);
      setMappings(maps);
      setLots(lotRecs);
      setQuotes(quoteRecs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchData();
  }, [authState, fetchData]);

  useEffect(() => {
    if (!router.isReady) return;
    if (router.query.new === "1") {
      openNew();
      router.replace("/finance/goals", undefined, { shallow: true });
    }
  }, [router.isReady, router.query.new]);

  function milestonesFor(goalId: string): MilestoneRecord[] {
    return sortMilestones(milestones.filter((m) => m.goalId === goalId));
  }

  // ── Openers ────────────────────────────────────────────────────────────────

  function openNew() {
    setDraft({ currentAmount: 0 });
    setMsDrafts([]);
    setMsDeleted([]);
    setPanel({ kind: "new" });
  }

  function openEdit(goal: GoalRecord) {
    setDraft({ ...goal });
    setMsDrafts(
      milestonesFor(goal.id).map((m) => ({
        id:           m.id,
        targetDate:   m.targetDate ?? "",
        targetAmount: m.targetAmount ?? 0,
        label:        m.label,
        notes:        m.notes,
      })),
    );
    setMsDeleted([]);
    setPanel({ kind: "edit", goal });
  }

  // ── Milestone draft helpers ────────────────────────────────────────────────

  function addMilestoneRow() {
    setMsDrafts((p) => [...p, { targetDate: "", targetAmount: "", label: "", notes: "" }]);
  }

  function updateMilestoneRow(idx: number, patch: Partial<MilestoneDraft>) {
    setMsDrafts((p) => p.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  }

  function removeMilestoneRow(idx: number) {
    const row = msDrafts[idx];
    if (row?.id) setMsDeleted((d) => [...d, row.id!]);
    setMsDrafts((p) => p.filter((_, i) => i !== idx));
  }

  // ── Save goal (+ sync milestones) ──────────────────────────────────────────

  async function handleSave() {
    if (!draft.name?.trim() || draft.targetAmount == null) return;
    setSaving(true);
    try {
      let goalId: string;

      if (panel?.kind === "new") {
        const { data: newGoal } = await client.models.financeSavingsGoal.create({
          name:          draft.name!,
          targetAmount:  draft.targetAmount!,
          currentAmount: draft.currentAmount ?? 0,
          targetDate:    draft.targetDate ?? null,
          notes:         draft.notes ?? null,
          expectedAnnualGrowth: draft.expectedAnnualGrowth ?? null,
        });
        if (!newGoal) throw new Error("Goal creation failed");
        goalId = newGoal.id;
        setGoals((p) => [...p, newGoal]);
      } else if (panel?.kind === "edit") {
        goalId = panel.goal.id;
        await client.models.financeSavingsGoal.update({
          id:            goalId,
          name:          draft.name!,
          targetAmount:  draft.targetAmount!,
          currentAmount: draft.currentAmount ?? 0,
          targetDate:    draft.targetDate ?? null,
          notes:         draft.notes ?? null,
          expectedAnnualGrowth: draft.expectedAnnualGrowth ?? null,
        });
        setGoals((p) => p.map((g) => g.id === goalId ? { ...g, ...draft } as GoalRecord : g));
      } else {
        return;
      }

      // ── Sync milestones ────────────────────────────────────────────────────
      // 1. Delete milestones the user removed
      for (const id of msDeleted) {
        await client.models.financeGoalMilestone.delete({ id });
      }
      // 2. Upsert the rest (skip rows missing required fields)
      const validDrafts = msDrafts.filter(
        (m) => m.targetDate && m.targetAmount !== "" && !isNaN(Number(m.targetAmount)),
      );
      const fresh: MilestoneRecord[] = [];
      for (const m of validDrafts) {
        const payload = {
          goalId,
          targetDate:   m.targetDate,
          targetAmount: Number(m.targetAmount),
          label:        m.label?.trim() || null,
          notes:        m.notes?.trim() || null,
        };
        if (m.id) {
          const { data } = await client.models.financeGoalMilestone.update({ id: m.id, ...payload });
          if (data) fresh.push(data);
        } else {
          const { data } = await client.models.financeGoalMilestone.create(payload);
          if (data) fresh.push(data);
        }
      }
      // Refetch all milestones for the goal to keep state consistent
      setMilestones((prev) => {
        const others = prev.filter((m) => m.goalId !== goalId && !msDeleted.includes(m.id));
        return [...others, ...fresh];
      });

      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(goal: GoalRecord) {
    const ms = milestonesFor(goal.id);
    const msg = ms.length > 0
      ? `Delete goal "${goal.name}" and its ${ms.length} milestone${ms.length === 1 ? "" : "s"}?`
      : `Delete goal "${goal.name}"?`;
    if (!confirm(msg)) return;
    setSaving(true);
    try {
      // Delete milestones first (preserve referential cleanliness)
      for (const m of ms) {
        await client.models.financeGoalMilestone.delete({ id: m.id });
      }
      await client.models.financeSavingsGoal.delete({ id: goal.id });
      setMilestones((p) => p.filter((m) => m.goalId !== goal.id));
      setGoals((p) => p.filter((g) => g.id !== goal.id));
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  // Compute allocations once per render. Sub-millisecond; safe to recompute freely.
  // IMPORTANT: hooks must come before any early return, so this lives above the
  // authState guard below.
  const allocations = useMemo(
    () => computeGoalAllocations(accounts, goals, mappings, lots, quotes),
    [accounts, goals, mappings, lots, quotes],
  );

  // Lookup used in goal cards to show "funded by X, Y, Z"
  const accountById = useMemo(() => {
    const m = new Map<string, AccountRecord>();
    for (const a of accounts) m.set(a.id, a);
    return m;
  }, [accounts]);

  // Quote map for accountTotalValue calls in the edit panel's funding section.
  // Same map computeGoalAllocations builds internally; memoized separately so we
  // can use it in render without recomputing.
  const quoteMap = useMemo(() => buildQuoteMap(quotes), [quotes]);

  if (authState !== "authenticated") return null;

  const sorted = [...goals].sort((a, b) => {
    // Incomplete first, then by targetDate. Use effective amount so mapped goals
    // sort by true progress, not stale currentAmount.
    const aCur = effectiveGoalAmount(a, allocations, mappings);
    const bCur = effectiveGoalAmount(b, allocations, mappings);
    const aPct = (a.targetAmount ?? 0) > 0 ? aCur / a.targetAmount! : 0;
    const bPct = (b.targetAmount ?? 0) > 0 ? bCur / b.targetAmount! : 0;
    if (aPct >= 1 && bPct < 1) return 1;
    if (bPct >= 1 && aPct < 1) return -1;
    return (a.targetDate ?? "9999").localeCompare(b.targetDate ?? "9999");
  });

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

          <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
            <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
          </div>

          <div className="flex items-center justify-between mb-6 gap-2">
            <h1 className="text-2xl font-bold text-purple dark:text-rose">Savings Goals</h1>
            <button onClick={openNew} className="px-4 py-1.5 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity">
              + New Goal
            </button>
          </div>

          {loading ? (
            <p className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</p>
          ) : goals.length === 0 ? (
            <EmptyState label="savings goals" onAdd={openNew} />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {sorted.map((goal) => {
                const target  = goal.targetAmount ?? 0;
                const current = effectiveGoalAmount(goal, allocations, mappings);
                const hasMapping = goalHasFundingSource(goal, mappings);
                const isVolatile = goalHasVolatileFunding(goal, mappings, accounts);
                const pct     = target > 0 ? Math.min(1, current / target) : 0;
                const color   = goalPctColor(pct);
                const months  = goal.targetDate ? monthsUntil(goal.targetDate) : null;
                const done    = pct >= 1;
                const ms      = milestonesFor(goal.id);

                // Growth-aware projection: if the current balance + assumed annual growth
                // already hits target by targetDate, monthly contribution is null.
                const growth = resolvedGrowthRate(goal);
                const projection = months && months > 0
                  ? projectGoal(current, target, months, growth)
                  : null;
                const monthly = projection?.requiredMonthlyContribution ?? null;
                const onTrackFromGrowth = projection != null
                  && projection.requiredMonthlyContribution == null
                  && !done;

                // Contributing accounts in priority order. Filter to non-zero so the card
                // shows "this is where the money's actually coming from right now."
                const contributingMappings = mappings
                  .filter((m) => m.goalId === goal.id)
                  .map((m) => ({
                    mapping: m,
                    account: accountById.get(m.accountId ?? ""),
                    allocated: allocations.allocatedByMapping.get(m.id) ?? 0,
                  }))
                  .filter((row) => row.account)
                  .sort((a, b) => (b.allocated) - (a.allocated));   // biggest contributor first

                return (
                  <div
                    key={goal.id}
                    onClick={() => openEdit(goal)}
                    className="rounded-xl border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface px-5 py-4 flex flex-col gap-3 cursor-pointer hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
                  >
                    {/* Title row */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">{goal.name}</h3>
                        {isVolatile && (
                          <span
                            className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full flex-shrink-0"
                            style={{ backgroundColor: "#f59e0b22", color: "#f59e0b" }}
                            title="Funded by a brokerage or retirement account — allocation fluctuates with the market"
                          >
                            ≈
                          </span>
                        )}
                      </div>
                      {done
                        ? <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full" style={{ backgroundColor: "#22c55e22", color: "#22c55e" }}>Complete</span>
                        : <span className="text-xs font-bold tabular-nums" style={{ color }}>{Math.round(pct * 100)}%</span>
                      }
                    </div>

                    {/* Progress bar + milestone markers */}
                    <div className="relative h-2 w-full rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${pct * 100}%`, backgroundColor: color }} />
                      {/* Milestone markers overlayed at their target position on the progress bar */}
                      {target > 0 && ms.map((m) => {
                        const pos = Math.min(1, Math.max(0, (m.targetAmount ?? 0) / target));
                        const hit = current >= (m.targetAmount ?? 0);
                        return (
                          <div
                            key={m.id}
                            className="absolute top-0 h-full w-0.5"
                            style={{
                              left: `${pos * 100}%`,
                              backgroundColor: hit ? "#22c55e" : "rgba(0,0,0,0.4)",
                            }}
                            title={`${m.label ? m.label + " — " : ""}${fmtCurrency(m.targetAmount)} by ${fmtDate(m.targetDate ?? "")}`}
                          />
                        );
                      })}
                    </div>

                    {/* Amounts */}
                    <div className="flex justify-between text-xs tabular-nums">
                      <span>
                        <span className="text-gray-400 mr-1">Saved</span>
                        <span className="font-semibold text-gray-700 dark:text-gray-300">{fmtCurrency(current)}</span>
                      </span>
                      <span>
                        <span className="text-gray-400 mr-1">Goal</span>
                        <span className="font-semibold text-gray-700 dark:text-gray-300">{fmtCurrency(target)}</span>
                      </span>
                    </div>

                    {/* Milestones list */}
                    {ms.length > 0 && (
                      <div className="flex flex-col gap-1 border-t border-gray-100 dark:border-gray-700 pt-2">
                        {ms.map((m) => {
                          const status = milestoneStatus(m, current);
                          const icon =
                            status === "HIT"     ? "☑" :
                            status === "MISSED"  ? "✕" :
                                                   "◯";
                          const iconColor =
                            status === "HIT"     ? "#22c55e" :
                            status === "MISSED"  ? "#ef4444" :
                                                   "#9ca3af";
                          return (
                            <div key={m.id} className="flex items-center gap-2 text-[11px]">
                              <span style={{ color: iconColor }} className="font-bold">{icon}</span>
                              <span className="font-semibold text-gray-600 dark:text-gray-300 tabular-nums">
                                {fmtCurrency(m.targetAmount)}
                              </span>
                              <span className="text-gray-400">by {fmtDate(m.targetDate ?? "")}</span>
                              {m.label && <span className="text-gray-400 truncate">· {m.label}</span>}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Funded by — which accounts contribute and how much. Only shown when
                        the goal has mappings, not when falling back to manual currentAmount. */}
                    {hasMapping && contributingMappings.length > 0 && (
                      <div className="flex flex-col gap-1 border-t border-gray-100 dark:border-gray-700 pt-2">
                        <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Funded by</p>
                        {contributingMappings.map((row) => (
                          <div key={row.mapping.id} className="flex items-center justify-between text-[11px] gap-2">
                            <span className="text-gray-600 dark:text-gray-300 truncate">{row.account!.name}</span>
                            <span className="tabular-nums font-semibold" style={{
                              color: row.allocated > 0 ? FINANCE_COLOR : "#9ca3af",
                            }}>
                              {fmtCurrency(row.allocated)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Deadline + projection */}
                    {goal.targetDate && (
                      <div className="text-[11px] text-gray-400 flex flex-col gap-0.5">
                        <span>Target: <span className="text-gray-600 dark:text-gray-300 font-medium">{fmtDate(goal.targetDate)}</span>
                          {months && months > 0 && <> · {Math.ceil(months)}mo left</>}
                          {months && months <= 0 && <span className="text-amber-500"> · Overdue</span>}
                        </span>
                        {onTrackFromGrowth && projection && (
                          <span className="text-green-500">
                            On track from {Math.round(growth * 100)}% growth —
                            projects to <span className="font-semibold tabular-nums">{fmtCurrency(projection.projectedEndValue)}</span>
                          </span>
                        )}
                        {monthly != null && monthly > 0 && !done && (
                          <span>
                            Need <span className="font-medium" style={{ color: FINANCE_COLOR }}>{fmtCurrency(monthly)}/mo</span>
                            {" "}at {Math.round(growth * 100)}% growth
                          </span>
                        )}
                      </div>
                    )}

                    {goal.notes && (
                      <p className="text-[11px] text-gray-400 border-t border-gray-100 dark:border-gray-700 pt-2">{goal.notes}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Side panel ─────────────────────────────────────────────── */}
        {panel && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-96 border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
              <h2 className="text-base font-semibold dark:text-rose text-purple">
                {panel.kind === "new" ? "New Goal" : draft.name}
              </h2>
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <div>
                <label className={labelCls}>Name *</label>
                <input type="text" className={inputCls} placeholder="Emergency fund, House down payment…"
                  value={draft.name ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Target Amount *</label>
                  <input type="number" step="0.01" min={0} className={inputCls} placeholder="10000"
                    value={draft.targetAmount ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, targetAmount: parseFloat(e.target.value) || 0 }))} />
                </div>
                <div>
                  <label className={labelCls}>Current Amount</label>
                  {panel.kind === "edit" && goalHasFundingSource(panel.goal, mappings) ? (
                    <div className={`${inputCls} flex items-center bg-gray-50 dark:bg-darkElevated`}>
                      <span className="tabular-nums font-semibold text-gray-600 dark:text-gray-300">
                        {fmtCurrency(effectiveGoalAmount(panel.goal, allocations, mappings))}
                      </span>
                    </div>
                  ) : (
                    <input type="number" step="0.01" min={0} className={inputCls} placeholder="0"
                      value={draft.currentAmount ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, currentAmount: parseFloat(e.target.value) || 0 }))} />
                  )}
                  {panel.kind === "edit" && goalHasFundingSource(panel.goal, mappings) && (
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      Auto-computed from funding sources. Edit on the account panels.
                    </p>
                  )}
                </div>
              </div>
              <div>
                <label className={labelCls}>Target Date</label>
                <input type="date" className={inputCls} value={draft.targetDate ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, targetDate: e.target.value || null as any }))} />
              </div>

              {/* Expected growth — drives the "need $X/mo" projection. Stored as decimal
                  (0.05 = 5%) but presented as percent so the user doesn't have to think
                  about decimals. Empty input = use DEFAULT_EXPECTED_GROWTH. */}
              <div>
                <label className={labelCls}>Expected Annual Growth</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.1"
                    min={0}
                    max={50}
                    className={inputCls}
                    placeholder={`${(DEFAULT_EXPECTED_GROWTH * 100).toFixed(0)} (default)`}
                    value={draft.expectedAnnualGrowth != null ? (draft.expectedAnnualGrowth * 100).toString() : ""}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setDraft((d) => ({
                        ...d,
                        expectedAnnualGrowth: raw === "" ? null as any : parseFloat(raw) / 100,
                      }));
                    }}
                  />
                  <span className="text-sm text-gray-500 dark:text-gray-400">%/yr</span>
                </div>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  Used to project required monthly contribution. Set to 0 for cash-only goals.
                  {draft.expectedAnnualGrowth == null && ` Default: ${(DEFAULT_EXPECTED_GROWTH * 100).toFixed(0)}%.`}
                </p>
              </div>

              {/* Live projection preview — growth-aware. Replaces the old naive math. */}
              {(draft.targetAmount ?? 0) > 0 && (draft.currentAmount ?? 0) < (draft.targetAmount ?? 0) && draft.targetDate && (() => {
                const months = monthsUntil(draft.targetDate);
                if (months <= 0) return null;
                const rate = draft.expectedAnnualGrowth ?? DEFAULT_EXPECTED_GROWTH;
                const proj = projectGoal(
                  draft.currentAmount ?? 0,
                  draft.targetAmount ?? 0,
                  months,
                  rate,
                );
                const onTrack = proj.requiredMonthlyContribution == null;
                return (
                  <div className="rounded-lg bg-gray-50 dark:bg-darkElevated px-3 py-2 text-xs text-gray-500 dark:text-gray-400 flex flex-col gap-1">
                    <span>{Math.ceil(months)} months remaining · {(rate * 100).toFixed(1)}%/yr assumed</span>
                    <span>
                      Projects to{" "}
                      <span className="font-semibold tabular-nums text-gray-700 dark:text-gray-300">
                        {fmtCurrency(proj.projectedEndValue)}
                      </span>
                      {" "}with no contributions
                    </span>
                    {onTrack ? (
                      <span className="font-semibold text-green-500">On track from growth alone</span>
                    ) : (
                      <span>
                        Monthly contribution needed:{" "}
                        <span className="font-semibold" style={{ color: FINANCE_COLOR }}>
                          {fmtCurrency(proj.requiredMonthlyContribution!)}
                        </span>
                      </span>
                    )}
                  </div>
                );
              })()}

              {/* Funded by these accounts — read-only view of the mappings pointing at this goal.
                  Shows each source account's total balance and how much is allocated to THIS
                  goal specifically. Priority can't be edited here (it's per-account, not
                  per-goal); user goes to the account panel to reorder or remove. */}
              {panel.kind === "edit" && (() => {
                const goalMappings = mappings
                  .filter((m) => m.goalId === panel.goal.id)
                  .map((m) => ({
                    mapping:   m,
                    account:   accountById.get(m.accountId ?? ""),
                    allocated: allocations.allocatedByMapping.get(m.id) ?? 0,
                  }))
                  .filter((row) => row.account)
                  .sort((a, b) => b.allocated - a.allocated);

                return (
                  <div className="border-t border-gray-100 dark:border-gray-700 pt-3 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <label className={labelCls}>Funded by</label>
                      {goalMappings.length > 0 && (
                        <span className="text-[10px] text-gray-400">
                          Priority set per account
                        </span>
                      )}
                    </div>
                    {goalMappings.length === 0 ? (
                      <p className="text-[11px] text-gray-400">
                        No accounts currently fund this goal. Open an account in the Transactions
                        page to link it here.
                      </p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {goalMappings.map((row) => {
                          const acc = row.account!;
                          const totalVal = accountTotalValue(acc, lots, quoteMap);
                          return (
                            <a
                              key={row.mapping.id}
                              href={`/finance/accounts/${acc.id}`}
                              className="rounded border border-gray-200 dark:border-darkBorder bg-gray-50 dark:bg-darkElevated px-3 py-2 hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-semibold text-gray-700 dark:text-gray-200 truncate">
                                  {acc.name}
                                </span>
                                <span
                                  className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full flex-shrink-0"
                                  style={{ backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR }}
                                >
                                  {ACCOUNT_TYPE_LABELS[(acc.type ?? "OTHER") as keyof typeof ACCOUNT_TYPE_LABELS]}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-2 mt-1 text-[11px]">
                                <span className="text-gray-400">
                                  Balance:{" "}
                                  <span className="tabular-nums font-medium text-gray-600 dark:text-gray-300">
                                    {fmtCurrency(totalVal, acc.currency ?? "USD")}
                                  </span>
                                </span>
                                <span>
                                  <span className="text-gray-400 mr-1">Allocated</span>
                                  <span
                                    className="tabular-nums font-semibold"
                                    style={{ color: row.allocated > 0 ? FINANCE_COLOR : "#9ca3af" }}
                                  >
                                    {fmtCurrency(row.allocated, acc.currency ?? "USD")}
                                  </span>
                                </span>
                              </div>
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Milestones subsection */}
              <div className="border-t border-gray-100 dark:border-gray-700 pt-3 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <label className={labelCls}>Milestones</label>
                  <button
                    type="button"
                    onClick={addMilestoneRow}
                    className="text-[11px] font-semibold"
                    style={{ color: FINANCE_COLOR }}
                  >
                    + Add
                  </button>
                </div>
                {msDrafts.length === 0 ? (
                  <p className="text-[11px] text-gray-400">
                    Checkpoints on the road to this goal (e.g. "50% by June, full by Dec"). Optional.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {msDrafts.map((m, idx) => {
                      const currentAmt = draft.currentAmount ?? 0;
                      const status: MilestoneStatus =
                        m.targetAmount !== "" && m.targetDate
                          ? milestoneStatus(
                              {
                                targetAmount: Number(m.targetAmount),
                                targetDate:   m.targetDate,
                              } as MilestoneRecord,
                              currentAmt,
                            )
                          : "PENDING";
                      const statusColor =
                        status === "HIT"    ? "#22c55e" :
                        status === "MISSED" ? "#ef4444" :
                                              "#9ca3af";
                      return (
                        <div
                          key={idx}
                          className="rounded-lg border border-gray-200 dark:border-darkBorder px-3 py-2 flex flex-col gap-2"
                        >
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-[10px] uppercase tracking-wider text-gray-400">Amount</label>
                              <input type="number" step="0.01" min={0} className={inputCls}
                                value={m.targetAmount}
                                onChange={(e) => updateMilestoneRow(idx, {
                                  targetAmount: e.target.value === "" ? "" : parseFloat(e.target.value),
                                })} />
                            </div>
                            <div>
                              <label className="text-[10px] uppercase tracking-wider text-gray-400">Date</label>
                              <input type="date" className={inputCls}
                                value={m.targetDate}
                                onChange={(e) => updateMilestoneRow(idx, { targetDate: e.target.value })} />
                            </div>
                          </div>
                          <input type="text" className={inputCls} placeholder="Label (optional)"
                            value={m.label ?? ""}
                            onChange={(e) => updateMilestoneRow(idx, { label: e.target.value })} />
                          <div className="flex items-center justify-between text-[10px]">
                            <span style={{ color: statusColor }} className="font-semibold uppercase tracking-wide">
                              {status === "HIT" ? "Hit" : status === "MISSED" ? "Missed" : "Pending"}
                            </span>
                            <button
                              type="button"
                              onClick={() => removeMilestoneRow(idx)}
                              className="text-gray-400 hover:text-red-500 transition-colors"
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <label className={labelCls}>Notes</label>
                <textarea className={inputCls} rows={3} placeholder="Context, strategy…"
                  value={draft.notes ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
              </div>
              <SaveButton saving={saving} onSave={handleSave}
                label={panel.kind === "new" ? "Create Goal" : "Save"} />
              {panel.kind === "edit" && (
                <DeleteButton saving={saving} onDelete={() => handleDelete(panel.goal)} />
              )}
            </div>
          </div>
        )}
      </div>
    </FinanceLayout>
  );
}
