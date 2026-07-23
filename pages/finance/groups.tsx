import React, { useCallback, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  listAll,
  FINANCE_COLOR,
  fmtCurrency,
  fmtDate,
  amountColor,
  inputCls,
  labelCls,
  SaveButton,
  DeleteButton,
  EmptyState,
  type TransactionRecord,
  type AccountRecord,
  type SpendGroupRecord,
} from "@/components/finance/_shared";
import { effectiveCategory } from "@/components/finance/categories";
import { SlideOverPanel } from "@/components/common/ui";

const KINDS = ["TRIP", "PROJECT", "EVENT", "OTHER"] as const;
type Kind = (typeof KINDS)[number];
const KIND_LABELS: Record<Kind, string> = { TRIP: "Trip", PROJECT: "Project", EVENT: "Event", OTHER: "Other" };

type Panel = { kind: "new" } | { kind: "edit"; group: SpendGroupRecord } | null;

/** Counted spend for a transaction tagged to a group: outflows only, no transfers/trades. */
function outflowAmount(tx: TransactionRecord): number | null {
  if (tx.status === "PENDING") return null;
  if (tx.type === "TRANSFER" || tx.type === "BUY" || tx.type === "SELL") return null;
  const amt = tx.amount ?? 0;
  if (!(tx.type === "EXPENSE" || amt < 0)) return null;
  return Math.abs(amt);
}

type GroupStats = {
  actual: number;
  count: number;
  byCategory: { category: string; amount: number }[];
};

export default function SpendGroupsPage() {
  const { authState } = useRequireAuth();

  const [groups, setGroups] = useState<SpendGroupRecord[]>([]);
  const [txs, setTxs] = useState<TransactionRecord[]>([]);
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [panel, setPanel] = useState<Panel>(null);
  const [draft, setDraft] = useState<Partial<SpendGroupRecord>>({});

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [gs, ts, accs] = await Promise.all([
        listAll(client.models.financeSpendGroup as any),
        listAll(client.models.financeTransaction),
        listAll(client.models.financeAccount),
      ]);
      setGroups(gs as SpendGroupRecord[]);
      setTxs(ts as TransactionRecord[]);
      setAccounts(accs as AccountRecord[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState === "authenticated") fetchData();
  }, [authState, fetchData]);

  // Per-group stats from tagged transactions.
  const statsByGroup = useMemo(() => {
    const m = new Map<string, GroupStats>();
    const cat = new Map<string, Map<string, number>>();
    for (const g of groups) { m.set(g.id, { actual: 0, count: 0, byCategory: [] }); cat.set(g.id, new Map()); }
    for (const tx of txs) {
      const gid = (tx as any).spendGroupId as string | null | undefined;
      if (!gid || !m.has(gid)) continue;
      const v = outflowAmount(tx);
      if (v == null) continue;
      const s = m.get(gid)!;
      s.actual += v; s.count += 1;
      const cm = cat.get(gid)!;
      const c = effectiveCategory(tx);
      cm.set(c, (cm.get(c) ?? 0) + v);
    }
    for (const g of groups) {
      const cm = cat.get(g.id)!;
      m.get(g.id)!.byCategory = [...cm.entries()].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
    }
    return m;
  }, [groups, txs]);

  function openNew() { setDraft({ kind: "TRIP" }); setPanel({ kind: "new" }); }
  function openEdit(g: SpendGroupRecord) { setDraft({ ...g }); setPanel({ kind: "edit", group: g }); }

  async function handleSave() {
    if (!draft.name) { alert("Name is required"); return; }
    setSaving(true);
    try {
      const payload = {
        name: draft.name,
        kind: (draft.kind ?? "OTHER") as any,
        budget: draft.budget ?? null,
        startDate: draft.startDate || null,
        endDate: draft.endDate || null,
        notes: draft.notes || null,
      };
      if (panel?.kind === "new") {
        const { data } = await client.models.financeSpendGroup.create(payload as any);
        if (data) setGroups((p) => [...p, data as SpendGroupRecord]);
      } else if (panel?.kind === "edit") {
        const id = panel.group.id;
        await client.models.financeSpendGroup.update({ id, ...payload } as any);
        setGroups((p) => p.map((g) => (g.id === id ? ({ ...g, ...payload } as SpendGroupRecord) : g)));
      }
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(group: SpendGroupRecord) {
    const s = statsByGroup.get(group.id);
    const tagged = txs.filter((t) => (t as any).spendGroupId === group.id);
    if (!confirm(`Delete group "${group.name}"?${tagged.length ? ` ${tagged.length} transaction(s) will be untagged.` : ""}`)) return;
    setSaving(true);
    try {
      for (const t of tagged) {
        await client.models.financeTransaction.update({ id: t.id, spendGroupId: null } as any);
      }
      await client.models.financeSpendGroup.delete({ id: group.id });
      setTxs((p) => p.map((t) => ((t as any).spendGroupId === group.id ? ({ ...t, spendGroupId: null } as TransactionRecord) : t)));
      setGroups((p) => p.filter((g) => g.id !== group.id));
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  // Tag every untagged outflow within the group's date window to this group.
  async function autoAssign(group: SpendGroupRecord) {
    if (!group.startDate || !group.endDate) { alert("Set a start and end date on the group first."); return; }
    const candidates = txs.filter((t) => {
      if ((t as any).spendGroupId) return false;
      if (!t.date || t.date < group.startDate! || t.date > group.endDate!) return false;
      return outflowAmount(t) != null;
    });
    if (candidates.length === 0) { alert("No untagged spending found in that date range."); return; }
    if (!confirm(`Tag ${candidates.length} transaction(s) between ${fmtDate(group.startDate)} and ${fmtDate(group.endDate)} to "${group.name}"?`)) return;
    setSaving(true);
    try {
      for (const t of candidates) {
        await client.models.financeTransaction.update({ id: t.id, spendGroupId: group.id } as any);
      }
      const ids = new Set(candidates.map((c) => c.id));
      setTxs((p) => p.map((t) => (ids.has(t.id) ? ({ ...t, spendGroupId: group.id } as TransactionRecord) : t)));
    } finally {
      setSaving(false);
    }
  }

  if (authState !== "authenticated") return null;

  const sortedGroups = [...groups].sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? "") || a.name.localeCompare(b.name));

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 min-w-0 overflow-y-auto px-4 py-5 md:px-8">
          <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
            <div>
              <h1 className="text-2xl font-bold text-purple dark:text-rose">Groups</h1>
              <p className="text-xs text-gray-400 mt-0.5">Trips, projects &amp; events — spending grouped across categories.</p>
            </div>
            <button
              onClick={openNew}
              className="rounded-lg px-3 py-2 text-sm font-medium"
              style={{ backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR }}
            >
              + Add group
            </button>
          </div>

          {loading && <p className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</p>}

          {!loading && groups.length === 0 && (
            <div className="mt-6">
              <EmptyState label="No groups yet — create a trip or project, then tag transactions to it." onAdd={openNew} />
            </div>
          )}

          {!loading && sortedGroups.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-4">
              {sortedGroups.map((g) => {
                const s = statsByGroup.get(g.id) ?? { actual: 0, count: 0, byCategory: [] };
                const hasBudget = g.budget != null && g.budget > 0;
                const pct = hasBudget ? Math.min(100, (s.actual / (g.budget as number)) * 100) : 0;
                const over = hasBudget && s.actual > (g.budget as number);
                const remaining = hasBudget ? (g.budget as number) - s.actual : 0;
                const maxCat = Math.max(1, ...s.byCategory.map((c) => c.amount));
                return (
                  <div key={g.id} className="rounded-lg border border-gray-200 dark:border-darkBorder p-4 bg-white dark:bg-darkSurface">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold truncate">{g.name}</span>
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-300">
                            {KIND_LABELS[(g.kind as Kind) ?? "OTHER"]}
                          </span>
                        </div>
                        <p className="text-[11px] text-gray-400 mt-0.5">
                          {g.startDate ? fmtDate(g.startDate) : "—"}{g.endDate ? ` → ${fmtDate(g.endDate)}` : ""} · {s.count} tx
                        </p>
                      </div>
                      <button onClick={() => openEdit(g)} className="text-xs hover:underline flex-shrink-0" style={{ color: FINANCE_COLOR }}>Edit</button>
                    </div>

                    {/* Spend vs budget */}
                    <div className="mt-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-lg font-bold" style={{ color: amountColor(-s.actual) }}>{fmtCurrency(s.actual)}</span>
                        {hasBudget && (
                          <span className="text-xs" style={{ color: over ? "#ef4444" : "#9ca3af" }}>
                            of {fmtCurrency(g.budget)} · {over ? `${fmtCurrency(-remaining)} over` : `${fmtCurrency(remaining)} left`}
                          </span>
                        )}
                      </div>
                      {hasBudget && (
                        <div className="h-1.5 rounded-full bg-gray-100 dark:bg-white/10 mt-1.5 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: over ? "#ef4444" : FINANCE_COLOR }} />
                        </div>
                      )}
                    </div>

                    {/* Category mini-breakdown */}
                    {s.byCategory.length > 0 && (
                      <div className="mt-3 space-y-1">
                        {s.byCategory.slice(0, 5).map((c) => (
                          <div key={c.category} className="flex items-center gap-2">
                            <span className="text-[11px] text-gray-500 dark:text-gray-400 w-28 truncate">{c.category}</span>
                            <div className="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-white/10 overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${(c.amount / maxCat) * 100}%`, backgroundColor: "#ef4444" }} />
                            </div>
                            <span className="text-[11px] text-gray-500 dark:text-gray-400 w-16 text-right tabular-nums">{fmtCurrency(c.amount)}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {g.startDate && g.endDate && (
                      <button onClick={() => autoAssign(g)} disabled={saving} className="text-[11px] mt-3 hover:underline disabled:opacity-50" style={{ color: FINANCE_COLOR }}>
                        Auto-tag spending in date range
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Side panel ───────────────────────────────────────────────── */}
        {panel && (
          <SlideOverPanel
            title={panel.kind === "new" ? "New Group" : draft.name}
            onClose={() => setPanel(null)}
            footer={
              <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-gray-200 dark:border-darkBorder flex-shrink-0">
                {panel.kind === "edit" ? (
                  <DeleteButton onDelete={() => handleDelete(panel.group)} saving={saving} />
                ) : <span />}
                <SaveButton onSave={handleSave} saving={saving} />
              </div>
            }
          >
              <div>
                <label className={labelCls}>Name *</label>
                <input type="text" className={inputCls} placeholder="Hawaii 2026, Kitchen remodel…"
                  value={draft.name ?? ""} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Kind</label>
                  <select className={inputCls} value={draft.kind ?? "TRIP"} onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as any }))}>
                    {KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Budget</label>
                  <input type="number" step="0.01" min={0} className={inputCls} placeholder="(optional)"
                    value={draft.budget ?? ""} onChange={(e) => setDraft((d) => ({ ...d, budget: e.target.value === "" ? null : parseFloat(e.target.value) }))} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Start date</label>
                  <input type="date" className={inputCls} value={draft.startDate ?? ""} onChange={(e) => setDraft((d) => ({ ...d, startDate: e.target.value || null }))} />
                </div>
                <div>
                  <label className={labelCls}>End date</label>
                  <input type="date" className={inputCls} value={draft.endDate ?? ""} onChange={(e) => setDraft((d) => ({ ...d, endDate: e.target.value || null }))} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Notes</label>
                <textarea rows={3} className={`${inputCls} resize-none`} value={draft.notes ?? ""} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
              </div>
              <p className="text-[11px] text-gray-400">
                Tag transactions to this group from the transaction editor, or set a date range and use “Auto-tag”.
              </p>
          </SlideOverPanel>
        )}
      </div>
    </FinanceLayout>
  );
}
