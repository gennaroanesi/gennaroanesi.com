import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useRouter } from "next/router";
import NextLink from "next/link";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  AccountRecord, RecurringRecord,
  CADENCES, CADENCE_LABELS, CADENCE_MONTHLY_FACTOR, FINANCE_COLOR,
  fmtCurrency, fmtDate, todayIso, nextOccurrence, advanceByCadence, amountColor,
  isRecurrenceLive,
  inputCls, labelCls,
  SaveButton, DeleteButton, EmptyState,
  listAll,
  type Cadence,
} from "@/components/finance/_shared";
import {
  ColDef, DataTable, SearchInput, TableControls, useTableControls,
} from "@/components/common/table";

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
      const [accs, recs] = await Promise.all([
        listAll(client.models.financeAccount),
        listAll(client.models.financeRecurring),
      ]);
      setAccounts(accs);
      setRecurrings(recs);
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
          endDate:     draft.endDate ?? null,
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
          endDate:     draft.endDate ?? null,
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
      // Advance nextDate past today, preserving the startDate's day-of-month anchor
      const cadence = rec.cadence as Cadence;
      const anchor  = rec.startDate ?? rec.nextDate ?? today;
      let advancedNext = rec.nextDate ?? rec.startDate ?? today;
      while (advancedNext <= today) {
        advancedNext = advanceByCadence(advancedNext, cadence, anchor);
      }

      // If the new next occurrence passes the recurrence's end date, deactivate it.
      const endedOut = rec.endDate != null && advancedNext > rec.endDate;
      const patch: Partial<RecurringRecord> = { nextDate: advancedNext };
      if (endedOut) patch.active = false;

      await client.models.financeRecurring.update({ id: rec.id, ...patch });
      setRecurrings((p) => p.map((r) => r.id === rec.id ? { ...r, ...patch } as RecurringRecord : r));
    } finally {
      setSaving(false);
    }
  }

  // Split live vs inactive once; the live list feeds the sortable table below.
  const active   = useMemo(() => recurrings.filter(isRecurrenceLive), [recurrings]);
  const inactive = useMemo(() => recurrings.filter((r) => !isRecurrenceLive(r)), [recurrings]);

  const monthlyNet = active.reduce((s, r) => {
    const amt = r.amount ?? 0;
    const factor = CADENCE_MONTHLY_FACTOR[r.cadence as Cadence] ?? 1;
    return s + amt * factor;
  }, 0);

  // Resolve display helpers that are reused as both sort values and search text
  const accountName = useCallback(
    (r: RecurringRecord) => accounts.find((a) => a.id === r.accountId)?.name ?? "",
    [accounts],
  );
  const nextDate = useCallback(
    (r: RecurringRecord) => nextOccurrence(r.nextDate ?? r.startDate ?? todayIso(), r.cadence as Cadence, r.startDate ?? undefined),
    [],
  );

  const columns: ColDef<RecurringRecord>[] = useMemo(() => [
    {
      key: "description",
      label: "Description",
      sortValue: (r) => (r.description ?? "").toLowerCase(),
      searchValue: (r) => `${r.description ?? ""} ${r.category ?? ""} ${accountName(r)}`,
      render: (r) => {
        const acc = accounts.find((a) => a.id === r.accountId);
        return (
          <div>
            <p className="text-gray-800 dark:text-gray-200 font-medium">{r.description}</p>
            {r.category && <p className="text-[11px] text-gray-400">{r.category}</p>}
            {acc && <p className="text-[11px] text-gray-400">{acc.name}</p>}
          </div>
        );
      },
    },
    {
      key: "cadence",
      label: "Cadence",
      sortValue: (r) => CADENCE_LABELS[r.cadence as Cadence] ?? "",
      mobileHidden: true,
      render: (r) => (
        <span className="text-gray-500 text-xs">{CADENCE_LABELS[r.cadence as Cadence]}</span>
      ),
    },
    {
      key: "next",
      label: "Next",
      sortValue: (r) => nextDate(r),
      mobileHidden: true,
      render: (r) => <span className="text-gray-500 text-xs">{fmtDate(nextDate(r))}</span>,
    },
    {
      key: "amount",
      label: "Amount",
      sortValue: (r) => r.amount ?? 0,
      align: "right",
      render: (r) => {
        const acc = accounts.find((a) => a.id === r.accountId);
        return (
          <span
            className="tabular-nums font-semibold whitespace-nowrap"
            style={{ color: amountColor(r.amount ?? 0) }}
          >
            {fmtCurrency(r.amount, acc?.currency ?? "USD", true)}
          </span>
        );
      },
    },
    {
      key: "actions",
      label: "",
      align: "right",
      className: "w-36",
      render: (r) => (
        <div className="flex gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => handlePostNow(r)}
            disabled={saving}
            className="text-[10px] px-2 py-0.5 rounded border transition-colors"
            style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR }}
            title="Post one occurrence now"
          >
            Post
          </button>
          <button
            onClick={() => openEdit(r)}
            className="text-[10px] px-2 py-0.5 rounded border border-gray-200 dark:border-darkBorder text-gray-400 hover:text-gray-600 transition-colors"
          >
            Edit
          </button>
        </div>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [accounts, saving, accountName, nextDate]);

  const ctl = useTableControls(active, {
    defaultSortKey: "next",
    defaultSortDir: "asc",
    getSortValue: (row, key) => columns.find((c) => c.key === key)?.sortValue?.(row),
    getSearchText: (row) =>
      columns.map((c) => c.searchValue?.(row) ?? "").filter(Boolean).join(" "),
    initialPageSize: 50,
  });

  if (authState !== "authenticated") return null;

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

          <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
            <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
          </div>

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
              <div>
                <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                  <p className="text-xs uppercase tracking-widest text-gray-400 font-medium">
                    Active · {active.length}
                  </p>
                  <SearchInput value={ctl.search} onChange={ctl.setSearch} placeholder="Search description, category, account…" />
                </div>
                <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
                  <DataTable
                    rows={ctl.paged}
                    columns={columns}
                    sortKey={ctl.sortKey}
                    sortDir={ctl.sortDir}
                    onSort={ctl.handleSort}
                    onRowClick={openEdit}
                    emptyMessage={ctl.search ? "No matches" : "No active recurrences"}
                  />
                  <TableControls
                    page={ctl.page}
                    totalPages={ctl.totalPages}
                    totalItems={ctl.totalItems}
                    totalUnfiltered={ctl.totalUnfiltered}
                    pageSize={ctl.pageSize}
                    setPage={ctl.setPage}
                    setPageSize={ctl.setPageSize}
                  />
                </div>
              </div>

              {/* Inactive — kept as-is: typically small, read-only listing */}
              {inactive.length > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-widest text-gray-400 mb-2">Inactive · {inactive.length}</p>
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
              <div>
                <label className={labelCls}>Amount</label>
                <input type="number" step="0.01" className={inputCls} placeholder="0.00"
                  value={draft.amount ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, amount: parseFloat(e.target.value) || 0 }))} />
                <p className="text-[10px] text-gray-400 mt-0.5">Positive = income · Negative = expense</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Next Date</label>
                  <input type="date" className={inputCls} value={draft.nextDate ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, nextDate: e.target.value }))} />
                </div>
                <div>
                  <label className={labelCls}>End Date</label>
                  <input type="date" className={inputCls} value={draft.endDate ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, endDate: e.target.value || (null as any) }))} />
                  <p className="text-[10px] text-gray-400 mt-0.5">Leave blank for no end (default)</p>
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
