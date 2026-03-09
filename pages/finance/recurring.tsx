import React, { useEffect, useState, useCallback } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useRouter } from "next/router";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  AccountRecord, RecurringRecord, TransactionRecord,
  CADENCES, CADENCE_LABELS, FINANCE_COLOR,
  fmtCurrency, fmtDate, todayIso, nextOccurrence, amountColor,
  inputCls, labelCls,
  SaveButton, DeleteButton, EmptyState, StatusBadge,
  type Cadence,
} from "@/components/finance/_shared";

type PanelState =
  | { kind: "new" }
  | { kind: "edit"; rec: RecurringRecord }
  | null;

export default function RecurringPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [accounts,   setAccounts]   = useState<AccountRecord[]>([]);
  const [recurrings, setRecurrings] = useState<RecurringRecord[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [panel,      setPanel]      = useState<PanelState>(null);
  const [draft,      setDraft]      = useState<Partial<RecurringRecord>>({});

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: accs }, { data: recs }] = await Promise.all([
        client.models.financeAccount.list({ limit: 200 }),
        client.models.financeRecurring.list({ limit: 500 }),
      ]);
      setAccounts(accs ?? []);
      setRecurrings(recs ?? []);
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
      router.replace("/finance/recurring", undefined, { shallow: true });
    }
  }, [router.isReady, router.query.new]);

  function openNew() {
    setDraft({ active: true, type: "EXPENSE" as any, cadence: "MONTHLY" as any, startDate: todayIso(), nextDate: todayIso() });
    setPanel({ kind: "new" });
  }

  function openEdit(rec: RecurringRecord) {
    setDraft({ ...rec });
    setPanel({ kind: "edit", rec });
  }

  async function handleSave() {
    if (!draft.accountId || draft.amount == null || !draft.description?.trim()) return;
    setSaving(true);
    try {
      if (panel?.kind === "new") {
        const { data: newRec } = await client.models.financeRecurring.create({
          accountId:   draft.accountId!,
          amount:      draft.amount!,
          type:        (draft.type ?? "EXPENSE") as any,
          category:    draft.category ?? null,
          description: draft.description!,
          cadence:     (draft.cadence ?? "MONTHLY") as any,
          startDate:   draft.startDate ?? todayIso(),
          nextDate:    draft.nextDate ?? draft.startDate ?? todayIso(),
          active:      draft.active ?? true,
          goalId:      draft.goalId ?? null,
        });
        if (newRec) setRecurrings((p) => [...p, newRec]);
      } else if (panel?.kind === "edit") {
        await client.models.financeRecurring.update({
          id:          panel.rec.id,
          accountId:   draft.accountId!,
          amount:      draft.amount!,
          type:        (draft.type ?? "EXPENSE") as any,
          category:    draft.category ?? null,
          description: draft.description!,
          cadence:     (draft.cadence ?? "MONTHLY") as any,
          startDate:   draft.startDate ?? todayIso(),
          nextDate:    draft.nextDate ?? draft.startDate ?? todayIso(),
          active:      draft.active ?? true,
          goalId:      draft.goalId ?? null,
        });
        setRecurrings((p) => p.map((r) => r.id === panel.rec.id ? { ...r, ...draft } as RecurringRecord : r));
      }
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(rec: RecurringRecord) {
    if (!confirm(`Delete recurring "${rec.description}"?`)) return;
    setSaving(true);
    try {
      await client.models.financeRecurring.delete({ id: rec.id });
      setRecurrings((p) => p.filter((r) => r.id !== rec.id));
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  /** Post a single occurrence as a real transaction and advance nextDate */
  async function handlePostNow(rec: RecurringRecord) {
    if (!confirm(`Post one occurrence of "${rec.description}" (${fmtCurrency(rec.amount)})?`)) return;
    setSaving(true);
    try {
      const today = todayIso();
      await client.models.financeTransaction.create({
        accountId:   rec.accountId!,
        amount:      rec.amount!,
        type:        (rec.type ?? "EXPENSE") as any,
        category:    rec.category ?? null,
        description: rec.description ?? "",
        date:        today,
        status:      "POSTED" as any,
        goalId:      rec.goalId ?? null,
        toAccountId: null,
        importHash:  null,
      });
      // Adjust account balance
      const acc = accounts.find((a) => a.id === rec.accountId);
      if (acc) {
        const newBal = (acc.currentBalance ?? 0) + (rec.amount ?? 0);
        await client.models.financeAccount.update({ id: acc.id, currentBalance: newBal });
        setAccounts((p) => p.map((a) => a.id === acc.id ? { ...a, currentBalance: newBal } : a));
      }
      // Advance nextDate
      const nextDate = nextOccurrence(
        nextOccurrence(rec.nextDate ?? rec.startDate ?? today, rec.cadence as Cadence),
        rec.cadence as Cadence,
      );
      // We call nextOccurrence twice: once to get today's occurrence date (already past), once to get the next future one
      const advancedNext = (() => {
        let cur = rec.nextDate ?? rec.startDate ?? today;
        // advance past today
        while (cur <= today) {
          switch (rec.cadence as Cadence) {
            case "WEEKLY":   cur = new Date(new Date(cur + "T12:00:00").setDate(new Date(cur + "T12:00:00").getDate() + 7)).toISOString().slice(0,10); break;
            case "BIWEEKLY": cur = new Date(new Date(cur + "T12:00:00").setDate(new Date(cur + "T12:00:00").getDate() + 14)).toISOString().slice(0,10); break;
            case "MONTHLY":  { const d = new Date(cur + "T12:00:00"); d.setMonth(d.getMonth()+1); cur = d.toISOString().slice(0,10); break; }
            case "ANNUALLY": { const d = new Date(cur + "T12:00:00"); d.setMonth(d.getMonth()+12); cur = d.toISOString().slice(0,10); break; }
          }
        }
        return cur;
      })();
      await client.models.financeRecurring.update({ id: rec.id, nextDate: advancedNext });
      setRecurrings((p) => p.map((r) => r.id === rec.id ? { ...r, nextDate: advancedNext } : r));
    } finally {
      setSaving(false);
    }
  }

  const active   = recurrings.filter((r) => r.active !== false).sort((a, b) => (a.nextDate ?? "").localeCompare(b.nextDate ?? ""));
  const inactive = recurrings.filter((r) => r.active === false);

  const monthlyNet = active.reduce((s, r) => {
    const amt = r.amount ?? 0;
    const factor = r.cadence === "WEEKLY" ? 4.33 : r.cadence === "BIWEEKLY" ? 2.17 : r.cadence === "ANNUALLY" ? 1/12 : 1;
    return s + amt * factor;
  }, 0);

  if (authState !== "authenticated") return null;

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

          <div className="flex items-center justify-between mb-4 gap-2">
            <div>
              <h1 className="text-2xl font-bold text-purple dark:text-rose">Recurring</h1>
              {active.length > 0 && (
                <p className="text-xs text-gray-400 mt-0.5">
                  Monthly net: <span className="font-semibold tabular-nums" style={{ color: amountColor(monthlyNet) }}>{fmtCurrency(monthlyNet, "USD", true)}</span>
                </p>
              )}
            </div>
            <button onClick={openNew} className="px-4 py-1.5 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity">
              + Add Recurring
            </button>
          </div>

          {loading ? (
            <p className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</p>
          ) : recurrings.length === 0 ? (
            <EmptyState label="recurring transactions" onAdd={openNew} />
          ) : (
            <div className="flex flex-col gap-6">
              {/* Active */}
              <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-darkElevated border-b border-gray-200 dark:border-darkBorder">
                    <tr>
                      <th className="px-4 py-2 text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium">Description</th>
                      <th className="px-4 py-2 text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium hidden sm:table-cell">Cadence</th>
                      <th className="px-4 py-2 text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium hidden md:table-cell">Next</th>
                      <th className="px-4 py-2 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium">Amount</th>
                      <th className="px-4 py-2 w-20" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {active.map((rec) => {
                      const acc = accounts.find((a) => a.id === rec.accountId);
                      return (
                        <tr key={rec.id} className="hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
                          <td className="px-4 py-2">
                            <p className="text-gray-800 dark:text-gray-200 font-medium">{rec.description}</p>
                            {rec.category && <p className="text-[11px] text-gray-400">{rec.category}</p>}
                            {acc && <p className="text-[11px] text-gray-400">{acc.name}</p>}
                          </td>
                          <td className="px-4 py-2 text-gray-500 text-xs hidden sm:table-cell">{CADENCE_LABELS[rec.cadence as Cadence]}</td>
                          <td className="px-4 py-2 text-gray-500 text-xs hidden md:table-cell">
                            {fmtDate(nextOccurrence(rec.nextDate ?? rec.startDate ?? todayIso(), rec.cadence as Cadence))}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums font-semibold whitespace-nowrap"
                            style={{ color: amountColor(rec.amount ?? 0) }}>
                            {fmtCurrency(rec.amount, acc?.currency ?? "USD", true)}
                          </td>
                          <td className="px-4 py-2 text-right">
                            <div className="flex gap-1 justify-end">
                              <button onClick={() => handlePostNow(rec)} disabled={saving}
                                className="text-[10px] px-2 py-0.5 rounded border transition-colors"
                                style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR }}
                                title="Post one occurrence now">
                                Post
                              </button>
                              <button onClick={() => openEdit(rec)}
                                className="text-[10px] px-2 py-0.5 rounded border border-gray-200 dark:border-darkBorder text-gray-400 hover:text-gray-600 transition-colors">
                                Edit
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Inactive */}
              {inactive.length > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-widest text-gray-400 mb-2">Inactive</p>
                  <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden opacity-60">
                    <table className="w-full text-sm">
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                        {inactive.map((rec) => (
                          <tr key={rec.id} className="hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer" onClick={() => openEdit(rec)}>
                            <td className="px-4 py-2 text-gray-500">{rec.description}</td>
                            <td className="px-4 py-2 text-gray-400 text-xs hidden sm:table-cell">{CADENCE_LABELS[rec.cadence as Cadence]}</td>
                            <td className="px-4 py-2 text-right tabular-nums text-gray-400">{fmtCurrency(rec.amount, "USD", true)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Side panel ─────────────────────────────────────────────── */}
        {panel && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-96 border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
              <h2 className="text-base font-semibold dark:text-rose text-purple">
                {panel.kind === "new" ? "New Recurring" : "Edit Recurring"}
              </h2>
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <div>
                <label className={labelCls}>Description *</label>
                <input type="text" className={inputCls} placeholder="e.g. Rent, Netflix, Salary…"
                  value={draft.description ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
              </div>
              <div>
                <label className={labelCls}>Account *</label>
                <select className={inputCls} value={draft.accountId ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, accountId: e.target.value }))}>
                  <option value="">Select account…</option>
                  {accounts.filter((a) => a.active !== false).map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Type</label>
                  <select className={inputCls} value={draft.type ?? "EXPENSE"}
                    onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value as any }))}>
                    <option value="INCOME">Income</option>
                    <option value="EXPENSE">Expense</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Cadence</label>
                  <select className={inputCls} value={draft.cadence ?? "MONTHLY"}
                    onChange={(e) => setDraft((d) => ({ ...d, cadence: e.target.value as any }))}>
                    {CADENCES.map((c) => <option key={c} value={c}>{CADENCE_LABELS[c]}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Amount</label>
                  <input type="number" step="0.01" className={inputCls} placeholder="0.00"
                    value={draft.amount ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, amount: parseFloat(e.target.value) || 0 }))} />
                  <p className="text-[10px] text-gray-400 mt-0.5">Positive = income · Negative = expense</p>
                </div>
                <div>
                  <label className={labelCls}>Next Date</label>
                  <input type="date" className={inputCls} value={draft.nextDate ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, nextDate: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Category</label>
                <input type="text" className={inputCls} placeholder="Housing, Subscription…"
                  value={draft.category ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))} />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                <input type="checkbox" checked={draft.active ?? true}
                  onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))} />
                Active
              </label>
              <SaveButton saving={saving} onSave={handleSave}
                label={panel.kind === "new" ? "Create Recurring" : "Save"} />
              {panel.kind === "edit" && (
                <DeleteButton saving={saving} onDelete={() => handleDelete(panel.rec)} />
              )}
            </div>
          </div>
        )}
      </div>
    </FinanceLayout>
  );
}
