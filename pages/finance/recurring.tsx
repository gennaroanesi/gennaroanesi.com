import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useRouter } from "next/router";
import NextLink from "next/link";
import FinanceLayout from "@/layouts/finance";
import { SlideOverPanel, PageTitle, PageLoading } from "@/components/common/ui";
import {
  client,
  AccountRecord, RecurringRecord, TransactionRecord,
  CADENCES, CADENCE_LABELS, CADENCE_MONTHLY_FACTOR, FINANCE_COLOR,
  fmtCurrency, fmtDate, todayIso, nextOccurrence, advanceByCadence, amountColor,
  isRecurrenceLive, normalizeAmountSign,
  inputCls, labelCls,
  SaveButton, DeleteButton, EmptyState,
  listAll,
  findMatchingTransactionsForRule, applyRecurringMatch,
  type Cadence,
} from "@/components/finance/_shared";
import {
  ColDef, DataTable, SearchInput, useTableControls,
} from "@/components/common/table";

const UNCATEGORIZED = "Uncategorized";

type CategoryGroup = {
  key:     string;
  items:   RecurringRecord[];
  monthly: number;
};

type PanelState =
  | { kind: "new" }
  | { kind: "edit"; rec: RecurringRecord }
  | { kind: "match"; rec: RecurringRecord }
  | null;

export default function RecurringPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [accounts,   setAccounts]   = useState<AccountRecord[]>([]);
  const [recurrings, setRecurrings] = useState<RecurringRecord[]>([]);
  const [recentTxs,  setRecentTxs]  = useState<TransactionRecord[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [panel,      setPanel]      = useState<PanelState>(null);
  const [draft,      setDraft]      = useState<Partial<RecurringRecord>>({});
  const [errors,     setErrors]     = useState<{ amount?: string; description?: string; accountId?: string; toAccountId?: string }>({});
  // Checked candidates in the match-panel multi-select.
  const [selectedTxIds, setSelectedTxIds] = useState<Set<string>>(new Set());
  // All transactions linked to the currently-edited rule. Fetched on demand
  // because we want every historical match (not just the 180-day window
  // recentTxs covers).
  const [linkedTxs,        setLinkedTxs]        = useState<TransactionRecord[]>([]);
  const [linkedTxsLoading, setLinkedTxsLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Trailing 180 days covers weekly → quarterly cadences. Longer-tail
      // cadences (semiannual, annual) will only surface one candidate at a
      // time, which is fine — candidates are a one-shot helper, not a
      // bulk-audit tool.
      const sinceIso = new Date(Date.now() - 180 * 24 * 3600 * 1000)
        .toISOString().slice(0, 10);
      const [accs, recs, txs] = await Promise.all([
        listAll(client.models.financeAccount),
        listAll(client.models.financeRecurring),
        listAll(client.models.financeTransaction, { date: { ge: sinceIso } }),
      ]);
      setAccounts(accs);
      setRecurrings(recs);
      setRecentTxs(txs);
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
      const q = router.query;
      const s = (v: unknown) => (typeof v === "string" ? v : undefined);
      const cadence = (s(q.cadence) as Cadence | undefined) ?? "MONTHLY";
      const startDate = s(q.startDate) ?? todayIso();
      const lastDate = s(q.lastDate);
      // If we have a lastDate, project the next occurrence forward from
      // there so nextDate lands on a real future cycle (not today).
      let nextDate = todayIso();
      if (lastDate) {
        try {
          nextDate = nextOccurrence(advanceByCadence(lastDate, cadence, startDate), cadence, startDate);
        } catch { /* fall back to today */ }
      }
      const amtNum = q.amount != null ? parseFloat(String(q.amount)) : NaN;
      openNew({
        description:  s(q.description),
        amount:       Number.isFinite(amtNum) ? amtNum : undefined,
        accountId:    s(q.accountId),
        cadence,
        startDate,
        nextDate,
        matchPattern: s(q.matchPattern),
      });
      router.replace("/finance/recurring", undefined, { shallow: true });
    }
  }, [router.isReady, router.query.new]);

  function openNew(prefill?: Partial<RecurringRecord>) {
    setDraft({
      active:    true,
      type:      "EXPENSE" as any,
      cadence:   "MONTHLY" as any,
      startDate: todayIso(),
      nextDate:  todayIso(),
      ...prefill,
    });
    setErrors({});
    setPanel({ kind: "new" });
  }

  function openEdit(rec: RecurringRecord) {
    setDraft({ ...rec });
    setErrors({});
    setPanel({ kind: "edit", rec });
  }

  function openMatch(rec: RecurringRecord) {
    setSelectedTxIds(new Set());
    setPanel({ kind: "match", rec });
  }

  // Pull every transaction linked to the edited rule (full history, not
  // just the 180-day candidate window) whenever the edit panel opens or
  // the rule's id changes.
  useEffect(() => {
    if (panel?.kind !== "edit") { setLinkedTxs([]); return; }
    const ruleId = panel.rec.id;
    setLinkedTxsLoading(true);
    (async () => {
      try {
        const rows = await listAll(client.models.financeTransaction, { recurringId: { eq: ruleId } });
        setLinkedTxs(rows.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")));
      } finally {
        setLinkedTxsLoading(false);
      }
    })();
  }, [panel]);

  async function handleUnlinkTx(tx: TransactionRecord) {
    setSaving(true);
    try {
      await client.models.financeTransaction.update({ id: tx.id, recurringId: null });
      setLinkedTxs((p) => p.filter((t) => t.id !== tx.id));
      // Reflect into recentTxs too so the rule's "matched (N)" + "last
      // matched" chips on the list page stay accurate.
      setRecentTxs((p) => p.map((t) => t.id === tx.id ? ({ ...t, recurringId: null } as TransactionRecord) : t));
    } finally {
      setSaving(false);
    }
  }

  // Batch-link the checked candidates to the rule, then refetch so
  // local state (nextDate advance, linked chips, candidate counts) updates.
  async function handleBatchLink(rec: RecurringRecord) {
    const ids = Array.from(selectedTxIds);
    if (ids.length === 0) return;
    setSaving(true);
    try {
      for (const id of ids) {
        const tx = recentTxs.find((t) => t.id === id);
        if (!tx) continue;
        await applyRecurringMatch(client, tx, rec);
      }
      await fetchData();
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  // Field-level validation shared by on-blur checks and Save.
  function validateDraft(d: Partial<RecurringRecord>): typeof errors {
    const e: typeof errors = {};
    if (!d.description?.trim()) e.description = "Description is required.";
    if (!d.accountId) e.accountId = d.type === "TRANSFER" ? "Choose a source account." : "Account is required.";
    if (d.amount == null || d.amount === 0 || Number.isNaN(d.amount)) e.amount = "Enter a non-zero amount.";
    if (d.type === "TRANSFER") {
      if (!d.toAccountId) e.toAccountId = "Choose a destination account.";
      else if (d.toAccountId === d.accountId) e.toAccountId = "Destination must differ from the source.";
    }
    return e;
  }

  // Apply `overrides`, snap the amount's sign to match the type (income +,
  // expense −, transfer +), commit the draft, and refresh validation. Called on
  // amount blur and whenever the type changes so signs stay canonical.
  const reNormalize = (overrides: Partial<RecurringRecord> = {}) => {
    const next: Partial<RecurringRecord> = { ...draft, ...overrides };
    if (next.amount != null) next.amount = normalizeAmountSign(next.amount, next.type);
    setDraft(next);
    setErrors(validateDraft(next));
  };

  async function handleSave() {
    const normalized = { ...draft, amount: draft.amount != null ? normalizeAmountSign(draft.amount, draft.type) : draft.amount };
    const errs = validateDraft(normalized);
    setErrors(errs);
    if (Object.keys(errs).length > 0) { setDraft(normalized); return; }
    const draftToSave = normalized;
    const isTransfer = draftToSave.type === "TRANSFER";
    setSaving(true);
    try {
      if (panel?.kind === "new") {
        const { data: newRec } = await client.models.financeRecurring.create({
          accountId:    draftToSave.accountId!,
          amount:       draftToSave.amount!,
          type:         (draftToSave.type ?? "EXPENSE") as any,
          toAccountId:  isTransfer ? draftToSave.toAccountId! : null,
          category:     draftToSave.category ?? null,
          description:  draftToSave.description!,
          cadence:      (draftToSave.cadence ?? "MONTHLY") as any,
          startDate:    draftToSave.startDate ?? todayIso(),
          endDate:      draftToSave.endDate ?? null,
          nextDate:     draftToSave.nextDate ?? draftToSave.startDate ?? todayIso(),
          active:       draftToSave.active ?? true,
          goalId:       draftToSave.goalId ?? null,
          matchPattern: draftToSave.matchPattern?.trim() || null,
        });
        if (newRec) setRecurrings((p) => [...p, newRec]);
      } else if (panel?.kind === "edit") {
        await client.models.financeRecurring.update({
          id:           panel.rec.id,
          accountId:    draftToSave.accountId!,
          amount:       draftToSave.amount!,
          type:         (draftToSave.type ?? "EXPENSE") as any,
          toAccountId:  isTransfer ? draftToSave.toAccountId! : null,
          category:     draftToSave.category ?? null,
          description:  draftToSave.description!,
          cadence:      (draftToSave.cadence ?? "MONTHLY") as any,
          startDate:    draftToSave.startDate ?? todayIso(),
          endDate:      draftToSave.endDate ?? null,
          nextDate:     draftToSave.nextDate ?? draftToSave.startDate ?? todayIso(),
          active:       draftToSave.active ?? true,
          goalId:       draftToSave.goalId ?? null,
          matchPattern: draftToSave.matchPattern?.trim() || null,
        });
        setRecurrings((p) => p.map((r) => r.id === panel.rec.id ? { ...r, ...draftToSave } as RecurringRecord : r));
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
      const isTransfer = rec.type === "TRANSFER";
      // A transfer moves |amount| out of the source (magnitude-based, so a
      // mis-signed stored amount can't invert it); non-transfers use amount as-is.
      const srcDelta = isTransfer ? -Math.abs(rec.amount ?? 0) : (rec.amount ?? 0);
      await client.models.financeTransaction.create({
        accountId:   rec.accountId!,
        amount:      srcDelta,
        type:        (rec.type ?? "EXPENSE") as any,
        category:    rec.category ?? null,
        description: rec.description ?? "",
        date:        today,
        status:      "POSTED" as any,
        goalId:      rec.goalId ?? null,
        toAccountId: isTransfer ? (rec.toAccountId ?? null) : null,
        importHash:  null,
      });
      // Adjust balances: srcDelta hits the source; a TRANSFER lands |amount| in
      // the destination account.
      const acc = accounts.find((a) => a.id === rec.accountId);
      if (acc) {
        const newBal = (acc.currentBalance ?? 0) + srcDelta;
        await client.models.financeAccount.update({ id: acc.id, currentBalance: newBal });
        setAccounts((p) => p.map((a) => a.id === acc.id ? { ...a, currentBalance: newBal } : a));
      }
      if (isTransfer && rec.toAccountId) {
        const dest = accounts.find((a) => a.id === rec.toAccountId);
        if (dest) {
          const destBal = (dest.currentBalance ?? 0) + Math.abs(rec.amount ?? 0);
          await client.models.financeAccount.update({ id: dest.id, currentBalance: destBal });
          setAccounts((p) => p.map((a) => a.id === dest.id ? { ...a, currentBalance: destBal } : a));
        }
      }
      // Advance nextDate past today using the current value's own day-of-
      // month as the anchor. Respects manual edits to nextDate (e.g. a
      // user-shifted late payment date carries forward) rather than
      // snapping back to startDate's original anchor.
      const cadence = rec.cadence as Cadence;
      let advancedNext = rec.nextDate ?? rec.startDate ?? today;
      while (advancedNext <= today) {
        advancedNext = advanceByCadence(advancedNext, cadence);
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
    (r: RecurringRecord) => nextOccurrence(r.nextDate ?? r.startDate ?? todayIso(), r.cadence as Cadence),
    [],
  );

  // Latest linked-transaction date per rule, for the "last matched" chip.
  const lastMatchByRule = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of recentTxs) {
      if (!t.recurringId || !t.date) continue;
      const prev = m.get(t.recurringId);
      if (!prev || t.date > prev) m.set(t.recurringId, t.date);
    }
    return m;
  }, [recentTxs]);

  // Candidate transactions per rule — drives the "Match (N)" button count.
  // findMatchingTransactionsForRule already skips already-linked txs.
  const candidateCountByRule = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of recurrings) {
      m.set(r.id, findMatchingTransactionsForRule(r, recentTxs).length);
    }
    return m;
  }, [recurrings, recentTxs]);

  const columns: ColDef<RecurringRecord>[] = useMemo(() => [
    {
      key: "description",
      label: "Description",
      sortValue: (r) => (r.description ?? "").toLowerCase(),
      searchValue: (r) => `${r.description ?? ""} ${r.category ?? ""} ${accountName(r)}`,
      render: (r) => {
        const acc = accounts.find((a) => a.id === r.accountId);
        const lastMatched = lastMatchByRule.get(r.id);
        return (
          <div>
            <p className="text-gray-800 dark:text-gray-200 font-medium">{r.description}</p>
            {r.category && <p className="text-[11px] text-gray-400">{r.category}</p>}
            {acc && <p className="text-[11px] text-gray-400">{acc.name}{r.type === "TRANSFER" && r.toAccountId ? ` → ${accounts.find((a) => a.id === r.toAccountId)?.name ?? "?"}` : ""}</p>}
            {lastMatched && (
              <p className="text-[10px]" style={{ color: FINANCE_COLOR }}>
                · last matched {fmtDate(lastMatched)}
              </p>
            )}
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
      className: "w-48",
      render: (r) => {
        const matchCount = candidateCountByRule.get(r.id) ?? 0;
        return (
          <div className="flex gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
            {matchCount > 0 && (
              <button
                onClick={() => openMatch(r)}
                className="text-[10px] px-2 py-0.5 rounded border transition-colors"
                style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR, backgroundColor: FINANCE_COLOR + "18" }}
                title={`${matchCount} candidate transaction${matchCount === 1 ? "" : "s"} to link`}
              >
                Match ({matchCount})
              </button>
            )}
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
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [accounts, saving, accountName, nextDate, lastMatchByRule, candidateCountByRule]);

  const ctl = useTableControls(active, {
    defaultSortKey: "next",
    defaultSortDir: "asc",
    getSortValue: (row, key) => columns.find((c) => c.key === key)?.sortValue?.(row),
    getSearchText: (row) =>
      columns.map((c) => c.searchValue?.(row) ?? "").filter(Boolean).join(" "),
    initialPageSize: 10_000,   // pagination disabled — grouped rendering shows everything
  });

  // Group the filtered+sorted items by category. Items within each group preserve
  // the current sort (ctl.sorted applies the global sort key across all items, then
  // we partition). Groups are ordered by abs(monthly subtotal) desc, with
  // "Uncategorized" always last.
  const groups: CategoryGroup[] = useMemo(() => {
    const map = new Map<string, RecurringRecord[]>();
    for (const r of ctl.sorted) {
      const cat = r.category?.trim() || UNCATEGORIZED;
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(r);
    }
    const arr: CategoryGroup[] = Array.from(map.entries()).map(([key, items]) => {
      const monthly = items.reduce((s, r) => {
        const amt = r.amount ?? 0;
        const factor = CADENCE_MONTHLY_FACTOR[r.cadence as Cadence] ?? 1;
        return s + amt * factor;
      }, 0);
      return { key, items, monthly };
    });
    arr.sort((a, b) => {
      if (a.key === UNCATEGORIZED && b.key !== UNCATEGORIZED) return 1;
      if (b.key === UNCATEGORIZED && a.key !== UNCATEGORIZED) return -1;
      return Math.abs(b.monthly) - Math.abs(a.monthly);
    });
    return arr;
  }, [ctl.sorted]);

  // Unique non-empty categories across all recurrences — feeds the datalist typeahead
  // in the edit panel. Includes inactive so a paused category doesn't disappear.
  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of recurrings) {
      const c = r.category?.trim();
      if (c) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [recurrings]);

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
              <PageTitle>Recurring</PageTitle>
              {active.length > 0 && (
                <p className="text-xs text-gray-400 mt-0.5">
                  Monthly net: <span className="font-semibold tabular-nums" style={{ color: amountColor(monthlyNet) }}>{fmtCurrency(monthlyNet, "USD", true)}</span>
                </p>
              )}
            </div>
            <button onClick={() => openNew()} className="px-4 py-1.5 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity">
              + Add Recurring
            </button>
          </div>

          {loading ? (
            <PageLoading />
          ) : recurrings.length === 0 ? (
            <EmptyState label="recurring transactions" onAdd={openNew} />
          ) : (
            <div className="flex flex-col gap-6">
              {/* Active — grouped by category, subtotal per group */}
              <div>
                <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                  <p className="text-xs uppercase tracking-widest text-gray-400 font-medium">
                    Active · {active.length}
                    {ctl.search && ctl.totalItems !== active.length && (
                      <span className="ml-1 normal-case tracking-normal text-gray-500">
                        ({ctl.totalItems} matching)
                      </span>
                    )}
                  </p>
                  <SearchInput value={ctl.search} onChange={ctl.setSearch} placeholder="Search description, category, account…" />
                </div>
                {groups.length === 0 ? (
                  <div className="rounded-lg border border-gray-200 dark:border-darkBorder p-6 text-center text-sm text-gray-400">
                    {ctl.search ? "No matches" : "No active recurrences"}
                  </div>
                ) : (
                  <div className="flex flex-col gap-4">
                    {groups.map((g) => (
                      <div key={g.key}>
                        <div className="flex items-baseline justify-between mb-1.5 gap-2 flex-wrap px-1">
                          <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                            {g.key}
                            <span className="ml-2 text-[11px] font-normal text-gray-400">
                              {g.items.length} item{g.items.length === 1 ? "" : "s"}
                            </span>
                          </p>
                          <p className="text-[11px] text-gray-400">
                            Monthly{" "}
                            <span className="font-semibold tabular-nums" style={{ color: amountColor(g.monthly) }}>
                              {fmtCurrency(g.monthly, "USD", true)}
                            </span>
                          </p>
                        </div>
                        <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
                          <DataTable
                            rows={g.items}
                            columns={columns}
                            sortKey={ctl.sortKey}
                            sortDir={ctl.sortDir}
                            onSort={ctl.handleSort}
                            onRowClick={openEdit}
                            emptyMessage="No matches"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
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

        {/* ── Side panel — create/edit ─────────────────────────────── */}
        {panel && (panel.kind === "new" || panel.kind === "edit") && (
          <SlideOverPanel
            title={panel.kind === "new" ? "New Recurring" : "Edit Recurring"}
            onClose={() => setPanel(null)}
          >
              <div>
                <label className={labelCls}>Description *</label>
                <input type="text" className={`${inputCls} ${errors.description ? "border-red-400" : ""}`} placeholder="e.g. Rent, Netflix, Salary…"
                  value={draft.description ?? ""}
                  onChange={(e) => { setDraft((d) => ({ ...d, description: e.target.value })); if (errors.description) setErrors((x) => ({ ...x, description: undefined })); }}
                  onBlur={() => setErrors((x) => ({ ...x, description: draft.description?.trim() ? undefined : "Description is required." }))} />
                {errors.description && <p className="text-[11px] text-red-500 mt-0.5">{errors.description}</p>}
              </div>
              <div>
                <label className={labelCls}>{draft.type === "TRANSFER" ? "From account *" : "Account *"}</label>
                <select className={`${inputCls} ${errors.accountId ? "border-red-400" : ""}`} value={draft.accountId ?? ""}
                  onChange={(e) => { setDraft((d) => ({ ...d, accountId: e.target.value })); setErrors((x) => ({ ...x, accountId: undefined })); }}>
                  <option value="">Select account…</option>
                  {accounts.filter((a) => a.active !== false).map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                {errors.accountId && <p className="text-[11px] text-red-500 mt-0.5">{errors.accountId}</p>}
              </div>
              {draft.type === "TRANSFER" && (
                <div>
                  <label className={labelCls}>To account *</label>
                  <select className={`${inputCls} ${errors.toAccountId ? "border-red-400" : ""}`} value={draft.toAccountId ?? ""}
                    onChange={(e) => { setDraft((d) => ({ ...d, toAccountId: e.target.value })); setErrors((x) => ({ ...x, toAccountId: undefined })); }}>
                    <option value="">Select destination…</option>
                    {accounts.filter((a) => a.active !== false && a.id !== draft.accountId).map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                  {errors.toAccountId
                    ? <p className="text-[11px] text-red-500 mt-0.5">{errors.toAccountId}</p>
                    : <p className="text-[10px] text-gray-400 mt-0.5">Money moves out of the “from” account into this one. Enter a positive amount.</p>}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Type</label>
                  <select className={inputCls} value={draft.type ?? "EXPENSE"}
                    onChange={(e) => reNormalize({ type: e.target.value as any, ...(e.target.value !== "TRANSFER" ? { toAccountId: null } : {}) })}>
                    <option value="INCOME">Income</option>
                    <option value="EXPENSE">Expense</option>
                    <option value="TRANSFER">Transfer</option>
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
                <label className={labelCls}>{draft.type === "TRANSFER" ? "Amount to move" : "Amount"}</label>
                <input type="number" step="0.01" className={`${inputCls} ${errors.amount ? "border-red-400" : ""}`} placeholder="0.00"
                  value={draft.amount != null && Number.isFinite(draft.amount)
                    ? (draft.type === "TRANSFER" ? Math.abs(draft.amount) : draft.amount)
                    : ""}
                  onChange={(e) => {
                    const s = e.target.value;
                    setDraft((d) => ({ ...d, amount: s === "" ? undefined : parseFloat(s) }));
                    if (errors.amount) setErrors((x) => ({ ...x, amount: undefined }));
                  }}
                  onBlur={() => reNormalize()} />
                {errors.amount
                  ? <p className="text-[11px] text-red-500 mt-0.5">{errors.amount}</p>
                  : <p className="text-[10px] text-gray-400 mt-0.5">{draft.type === "INCOME" ? "Income is stored positive — sign set automatically." : draft.type === "TRANSFER" ? "Transfers move a positive amount from → to." : "Expenses are stored negative — sign set automatically."}</p>}
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
                <input
                  type="text"
                  className={inputCls}
                  placeholder="Housing, Subscription…"
                  list="recurring-category-options"
                  value={draft.category ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
                />
                <datalist id="recurring-category-options">
                  {categoryOptions.map((c) => <option key={c} value={c} />)}
                </datalist>
              </div>
              <div>
                <label className={labelCls}>Match pattern</label>
                <input
                  type="text"
                  className={inputCls}
                  placeholder={"CHASE MORTGAGE  —  or /netflix.*us/i"}
                  value={draft.matchPattern ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, matchPattern: e.target.value }))}
                />
                <p className="text-[10px] text-gray-400 mt-0.5">
                  Optional. Case-insensitive substring, or <code>/regex/flags</code>. When set, a match
                  gives a big scoring bump and a miss disqualifies the transaction.
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                <input type="checkbox" checked={draft.active ?? true}
                  onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))} />
                Active
              </label>

              {/* Linked transactions — every tx with recurringId === rule.id.
                  Lets the user audit history and unlink a wrong match. */}
              {panel.kind === "edit" && (
                <div className="border-t border-gray-200 dark:border-darkBorder pt-3">
                  <div className="flex items-baseline justify-between mb-2">
                    <label className={labelCls}>
                      Linked transactions{linkedTxsLoading ? "" : ` · ${linkedTxs.length}`}
                    </label>
                    {linkedTxs.length > 0 && (
                      <span className="text-[10px] text-gray-400 tabular-nums">
                        Σ {fmtCurrency(
                          linkedTxs.reduce((s, t) => s + (t.amount ?? 0), 0),
                          "USD", true,
                        )}
                      </span>
                    )}
                  </div>
                  {linkedTxsLoading ? (
                    <p className="text-[11px] text-gray-400 italic">Loading…</p>
                  ) : linkedTxs.length === 0 ? (
                    <p className="text-[11px] text-gray-400 italic">
                      No transactions linked yet. Use Match (N) on the rule list to bulk-link
                      candidates, or link individual transactions from /finance/transactions.
                    </p>
                  ) : (
                    <div className="rounded border border-gray-200 dark:border-darkBorder max-h-64 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700">
                      {linkedTxs.map((t) => {
                        const acc = accounts.find((a) => a.id === t.accountId);
                        return (
                          <div key={t.id} className="flex items-center gap-2 px-2 py-1.5">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-gray-700 dark:text-gray-200 truncate">{t.description || "—"}</p>
                              <p className="text-[10px] text-gray-400">
                                {t.date ? fmtDate(t.date) : "—"} · {acc?.name ?? "—"}
                              </p>
                            </div>
                            <span className="text-xs tabular-nums font-medium whitespace-nowrap"
                              style={{ color: amountColor(t.amount ?? 0) }}>
                              {fmtCurrency(t.amount, acc?.currency ?? "USD", true)}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleUnlinkTx(t)}
                              disabled={saving}
                              title="Unlink this transaction from the rule"
                              className="text-xs text-gray-400 hover:text-red-500 disabled:opacity-30 px-1"
                            >×</button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <SaveButton saving={saving} onSave={handleSave}
                label={panel.kind === "new" ? "Create Recurring" : "Save"} />
              {panel.kind === "edit" && (
                <DeleteButton saving={saving} onDelete={() => handleDelete(panel.rec)} />
              )}
          </SlideOverPanel>
        )}

        {/* ── Side panel — batch-match candidates ──────────────────── */}
        {panel && panel.kind === "match" && (() => {
          const rec = panel.rec;
          const candidates = findMatchingTransactionsForRule(rec, recentTxs);
          const allSelected = candidates.length > 0 && candidates.every((c) => selectedTxIds.has(c.tx.id));
          const toggleAll = () => {
            if (allSelected) setSelectedTxIds(new Set());
            else setSelectedTxIds(new Set(candidates.map((c) => c.tx.id)));
          };
          const toggleOne = (id: string) => {
            setSelectedTxIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          };
          return (
            <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-[28rem] border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold dark:text-rose text-purple truncate">Match — {rec.description}</h2>
                  <p className="text-[11px] text-gray-400">
                    {candidates.length} candidate{candidates.length === 1 ? "" : "s"} · last 180d · {fmtCurrency(rec.amount, "USD", true)}
                  </p>
                </div>
                <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
              </div>

              {candidates.length === 0 ? (
                <div className="flex-1 flex items-center justify-center px-6 py-8">
                  <p className="text-xs text-gray-400 text-center">
                    No unlinked transactions in the last 180 days match this rule.
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between px-6 py-2 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
                    <label className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400 cursor-pointer">
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                      Select all
                    </label>
                    <span className="text-[11px] text-gray-400 tabular-nums">
                      {selectedTxIds.size} selected
                    </span>
                  </div>

                  <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-1.5">
                    {candidates.map(({ tx, score, reasons }) => {
                      const checked = selectedTxIds.has(tx.id);
                      return (
                        <label
                          key={tx.id}
                          className={[
                            "flex items-center gap-3 px-3 py-2 rounded border cursor-pointer transition-colors",
                            checked
                              ? ""
                              : "border-gray-200 dark:border-darkBorder hover:border-gray-300 dark:hover:border-gray-500",
                          ].join(" ")}
                          style={checked ? { borderColor: FINANCE_COLOR, backgroundColor: FINANCE_COLOR + "14" } : undefined}
                          title={reasons.join(" · ")}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleOne(tx.id)}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs text-gray-700 dark:text-gray-200 truncate">{tx.description || "—"}</p>
                            <p className="text-[10px] text-gray-400">
                              {tx.date ? fmtDate(tx.date) : "—"} · {fmtCurrency(tx.amount, "USD", true)}
                            </p>
                          </div>
                          <span
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
                            style={{ backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR }}
                          >
                            {Math.round(score)}
                          </span>
                        </label>
                      );
                    })}
                  </div>

                  <div className="border-t border-gray-200 dark:border-darkBorder px-6 py-3 flex-shrink-0 flex items-center justify-between gap-3">
                    <p className="text-[10px] text-gray-400">
                      Linking advances the rule's next date past the latest matched tx.
                    </p>
                    <button
                      onClick={() => handleBatchLink(rec)}
                      disabled={saving || selectedTxIds.size === 0}
                      className="px-4 py-1.5 rounded text-sm font-semibold text-white disabled:opacity-50 transition-opacity"
                      style={{ backgroundColor: FINANCE_COLOR }}
                    >
                      {saving ? "Linking…" : `Link ${selectedTxIds.size || ""}`.trim()}
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })()}
      </div>
    </FinanceLayout>
  );
}
