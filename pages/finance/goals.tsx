import React, { useEffect, useState, useCallback } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useRouter } from "next/router";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  GoalRecord, MilestoneRecord, MilestoneStatus,
  FINANCE_COLOR,
  fmtCurrency, fmtDate, todayIso, monthsUntil, goalPctColor,
  sortMilestones, milestoneStatus,
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
      const [{ data: gs }, { data: ms }] = await Promise.all([
        client.models.financeSavingsGoal.list({ limit: 100 }),
        client.models.financeGoalMilestone.list({ limit: 500 }),
      ]);
      setGoals(gs ?? []);
      setMilestones(ms ?? []);
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

  if (authState !== "authenticated") return null;

  const sorted = [...goals].sort((a, b) => {
    // Incomplete first, then by targetDate
    const aPct = (a.targetAmount ?? 0) > 0 ? (a.currentAmount ?? 0) / a.targetAmount! : 0;
    const bPct = (b.targetAmount ?? 0) > 0 ? (b.currentAmount ?? 0) / b.targetAmount! : 0;
    if (aPct >= 1 && bPct < 1) return 1;
    if (bPct >= 1 && aPct < 1) return -1;
    return (a.targetDate ?? "9999").localeCompare(b.targetDate ?? "9999");
  });

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

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
                const current = goal.currentAmount ?? 0;
                const pct     = target > 0 ? Math.min(1, current / target) : 0;
                const color   = goalPctColor(pct);
                const months  = goal.targetDate ? monthsUntil(goal.targetDate) : null;
                const needed  = target - current;
                const monthly = months && months > 0 ? needed / months : null;
                const done    = pct >= 1;
                const ms      = milestonesFor(goal.id);

                return (
                  <div
                    key={goal.id}
                    onClick={() => openEdit(goal)}
                    className="rounded-xl border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface px-5 py-4 flex flex-col gap-3 cursor-pointer hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
                  >
                    {/* Title row */}
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{goal.name}</h3>
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

                    {/* Deadline + projection */}
                    {goal.targetDate && (
                      <div className="text-[11px] text-gray-400 flex flex-col gap-0.5">
                        <span>Target: <span className="text-gray-600 dark:text-gray-300 font-medium">{fmtDate(goal.targetDate)}</span>
                          {months && months > 0 && <> · {Math.ceil(months)}mo left</>}
                          {months && months <= 0 && <span className="text-amber-500"> · Overdue</span>}
                        </span>
                        {monthly && !done && monthly > 0 && (
                          <span>Need <span className="font-medium" style={{ color: FINANCE_COLOR }}>{fmtCurrency(monthly)}/mo</span> to hit goal</span>
                        )}
                        {needed <= 0 && !done && (
                          <span className="text-green-500">On track!</span>
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
                  <input type="number" step="0.01" min={0} className={inputCls} placeholder="0"
                    value={draft.currentAmount ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, currentAmount: parseFloat(e.target.value) || 0 }))} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Target Date</label>
                <input type="date" className={inputCls} value={draft.targetDate ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, targetDate: e.target.value || null as any }))} />
              </div>

              {/* Live projection preview */}
              {(draft.targetAmount ?? 0) > 0 && (draft.currentAmount ?? 0) < (draft.targetAmount ?? 0) && draft.targetDate && (() => {
                const months  = monthsUntil(draft.targetDate);
                const needed  = (draft.targetAmount ?? 0) - (draft.currentAmount ?? 0);
                const monthly = months > 0 ? needed / months : null;
                return (
                  <div className="rounded-lg bg-gray-50 dark:bg-darkElevated px-3 py-2 text-xs text-gray-500 dark:text-gray-400 flex flex-col gap-1">
                    <span>{Math.ceil(months)} months remaining</span>
                    {monthly && <span>Monthly contribution needed: <span className="font-semibold" style={{ color: FINANCE_COLOR }}>{fmtCurrency(monthly)}</span></span>}
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
