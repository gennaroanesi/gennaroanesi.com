import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useRouter } from "next/router";
import NextLink from "next/link";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  AccountRecord, TransactionRecord, GoalRecord, GoalFundingSourceRecord,
  HoldingLotRecord, TickerQuoteRecord, RecurringRecord,
  FINANCE_COLOR,
  fmtCurrency, fmtDate, todayIso, amountColor,
  computeGoalAllocations,
  inputCls, labelCls,
  SaveButton, DeleteButton, EmptyState, AccountBadge, StatusBadge,
  parseBankCsv, type ParsedTransaction,
  type TxType,
  listAll,
  findRecurringMatches, applyRecurringMatch,
  RECURRING_MATCH_AUTO_THRESHOLD,
} from "@/components/finance/_shared";
import {
  ColDef, DataTable, SearchInput, TableControls, useTableControls,
} from "@/components/common/table";

// ── Panel state ───────────────────────────────────────────────────────────────

type PanelState =
  | { kind: "new-tx" }
  | { kind: "edit-tx";   tx:  TransactionRecord }
  | { kind: "import" }
  | null;

// ── Import preview row ────────────────────────────────────────────────────────

type ImportRow = ParsedTransaction & {
  selected:  boolean;
  duplicate: boolean;
};

export default function TransactionsPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [accounts,     setAccounts]     = useState<AccountRecord[]>([]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  // Goals, mappings, lots, quotes are fetched only for the surplus-badge computation
  // on the account chips. Actual mapping CRUD lives on /finance/accounts/[id].
  const [goals,        setGoals]        = useState<GoalRecord[]>([]);
  const [mappings,     setMappings]     = useState<GoalFundingSourceRecord[]>([]);
  const [lots,         setLots]         = useState<HoldingLotRecord[]>([]);
  const [quotes,       setQuotes]       = useState<TickerQuoteRecord[]>([]);
  const [recurrings,   setRecurrings]   = useState<RecurringRecord[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [saving,       setSaving]       = useState(false);
  const [panel,        setPanel]        = useState<PanelState>(null);

  // Filters
  const [filterAccount, setFilterAccount] = useState<string>("");
  const [filterStatus,  setFilterStatus]  = useState<string>("");
  const [filterType,    setFilterType]    = useState<string>("");

  // Transaction draft
  const [txDraft, setTxDraft] = useState<Partial<TransactionRecord>>({});

  // Import state
  const fileRef = useRef<HTMLInputElement>(null);
  const [importFormat,    setImportFormat]    = useState("");
  const [importRows,      setImportRows]      = useState<ImportRow[]>([]);
  const [importAccountId, setImportAccountId] = useState<string>("");
  const [importReverse,   setImportReverse]   = useState(false);

  const today = todayIso();

  // ── Data fetching ─────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [accs, txs, gls, maps, lotRecs, quoteRecs, recRecs] = await Promise.all([
        listAll(client.models.financeAccount),
        listAll(client.models.financeTransaction),
        listAll(client.models.financeSavingsGoal),
        listAll(client.models.financeGoalFundingSource),
        listAll(client.models.financeHoldingLot),
        listAll(client.models.financeTickerQuote),
        listAll(client.models.financeRecurring),
      ]);
      setAccounts(accs);
      setTransactions(txs);
      setGoals(gls);
      setMappings(maps);
      setLots(lotRecs);
      setQuotes(quoteRecs);
      setRecurrings(recRecs);
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
      openNewTx();
      router.replace("/finance/transactions", undefined, { shallow: true });
    }
  }, [router.isReady, router.query.new]);

  // Preselect account filter from ?account= query param
  useEffect(() => {
    if (!router.isReady) return;
    const qAcc = router.query.account;
    if (typeof qAcc === "string" && qAcc) {
      setFilterAccount(qAcc);
    }
  }, [router.isReady, router.query.account]);

  // ── Openers ───────────────────────────────────────────────────────────────

  function openNewTx() {
    setTxDraft({ date: todayIso(), status: "POSTED", type: "EXPENSE" });
    setPanel({ kind: "new-tx" });
  }

  function openEditTx(tx: TransactionRecord) {
    setTxDraft({ ...tx });
    setPanel({ kind: "edit-tx", tx });
  }

  function openImport() {
    setImportRows([]);
    setImportFormat("");
    setImportAccountId(accounts[0]?.id ?? "");
    setImportReverse(false);
    setPanel({ kind: "import" });
  }

  // ── Save transaction ──────────────────────────────────────────────────────

  async function handleSaveTx() {
    if (!txDraft.accountId || txDraft.amount == null || !txDraft.date) return;
    setSaving(true);
    try {
      const isPosted = txDraft.status === "POSTED";

      if (panel?.kind === "new-tx") {
        const { data: newTx } = await client.models.financeTransaction.create({
          accountId:   txDraft.accountId!,
          amount:      txDraft.amount!,
          type:        (txDraft.type ?? "EXPENSE") as any,
          category:    txDraft.category ?? null,
          description: txDraft.description ?? null,
          date:        txDraft.date!,
          status:      (txDraft.status ?? "POSTED") as any,
          goalId:      txDraft.goalId ?? null,
          toAccountId: txDraft.toAccountId ?? null,
          importHash:  txDraft.importHash ?? null,
        });
        if (newTx) {
          // Auto-match against recurring rules. High-confidence hits link
          // immediately and advance the rule's nextDate. Lower-confidence
          // suggestions are deferred to UI (not surfaced here).
          const candidates = findRecurringMatches(newTx, recurrings);
          let linked: TransactionRecord = newTx;
          if (candidates[0] && candidates[0].score >= RECURRING_MATCH_AUTO_THRESHOLD) {
            await applyRecurringMatch(client, newTx, candidates[0].rule);
            linked = { ...newTx, recurringId: candidates[0].rule.id } as unknown as TransactionRecord;
          }
          setTransactions((prev) => [linked, ...prev]);
          if (isPosted) await adjustBalance(txDraft.accountId!, txDraft.amount!, txDraft.toAccountId ?? null, txDraft.type as TxType);
        }

      } else if (panel?.kind === "edit-tx") {
        const prev = panel.tx;
        await client.models.financeTransaction.update({
          id:          prev.id,
          accountId:   txDraft.accountId!,
          amount:      txDraft.amount!,
          type:        (txDraft.type ?? "EXPENSE") as any,
          category:    txDraft.category ?? null,
          description: txDraft.description ?? null,
          date:        txDraft.date!,
          status:      (txDraft.status ?? "POSTED") as any,
          goalId:      txDraft.goalId ?? null,
          toAccountId: txDraft.toAccountId ?? null,
          recurringId: txDraft.recurringId ?? null,
        });

        // Reverse old balance effect, apply new
        if (prev.status === "POSTED") await adjustBalance(prev.accountId!, -(prev.amount ?? 0), prev.toAccountId ?? null, prev.type as TxType);
        if (isPosted)                 await adjustBalance(txDraft.accountId!, txDraft.amount!, txDraft.toAccountId ?? null, txDraft.type as TxType);

        setTransactions((p) => p.map((t) => t.id === prev.id ? { ...t, ...txDraft } as TransactionRecord : t));
        // Refetch accounts to get updated balances
        const accs = await listAll(client.models.financeAccount);
        setAccounts(accs);
      }

      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  // ── Delete transaction ────────────────────────────────────────────────────

  async function handleDeleteTx(tx: TransactionRecord) {
    if (!confirm("Delete this transaction?")) return;
    setSaving(true);
    try {
      if (tx.status === "POSTED") await adjustBalance(tx.accountId!, -(tx.amount ?? 0), tx.toAccountId ?? null, tx.type as TxType);
      await client.models.financeTransaction.delete({ id: tx.id });
      setTransactions((p) => p.filter((t) => t.id !== tx.id));
      const accs = await listAll(client.models.financeAccount);
      setAccounts(accs);
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  // ── Adjust account balance helper ─────────────────────────────────────────

  async function adjustBalance(accountId: string, delta: number, toAccountId: string | null, type: TxType | string) {
    const acc = accounts.find((a) => a.id === accountId);
    if (acc) {
      const newBal = (acc.currentBalance ?? 0) + delta;
      await client.models.financeAccount.update({ id: accountId, currentBalance: newBal });
      setAccounts((p) => p.map((a) => a.id === accountId ? { ...a, currentBalance: newBal } : a));
    }
    // For TRANSFER, credit the destination account
    if (type === "TRANSFER" && toAccountId) {
      const dest = accounts.find((a) => a.id === toAccountId);
      if (dest) {
        const newBal = (dest.currentBalance ?? 0) + Math.abs(delta);
        await client.models.financeAccount.update({ id: toAccountId, currentBalance: newBal });
        setAccounts((p) => p.map((a) => a.id === toAccountId ? { ...a, currentBalance: newBal } : a));
      }
    }
  }

  // ── CSV Import ────────────────────────────────────────────────────────────

  // If the reverse-sign toggle is on, flip the amount for all import math (display,
  // classification, commit, balance preview). Dedup hash stays keyed on the parser's
  // original amount so toggling doesn't break duplicate detection across re-imports.
  function effectiveAmount(raw: number): number {
    return importReverse ? -raw : raw;
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const { format, rows } = parseBankCsv(text);
      setImportFormat(format);
      const existingHashes = new Set(transactions.map((t) => t.importHash).filter(Boolean));
      setImportRows(
        rows.map((r) => ({
          ...r,
          selected:  !existingHashes.has(r.hash),
          duplicate: existingHashes.has(r.hash),
        })),
      );
    };
    reader.readAsText(file);
  }

  async function handleImport() {
    const toImport = importRows.filter((r) => r.selected && !r.duplicate);
    if (toImport.length === 0 || !importAccountId) return;
    setSaving(true);
    try {
      const created: TransactionRecord[] = [];
      for (const row of toImport) {
        const amt: number  = effectiveAmount(row.amount);
        const type: TxType = amt >= 0 ? "INCOME" : "EXPENSE";
        const { data: tx } = await client.models.financeTransaction.create({
          accountId:   importAccountId,
          amount:      amt,
          type:        type as any,
          category:    row.category || null,
          description: row.description,
          date:        row.date,
          status:      "POSTED" as any,
          goalId:      null,
          toAccountId: null,
          importHash:  row.hash,
        });
        if (tx) {
          // Same inline match attempt as manual entry. Imports often *are*
          // recurring realizations, so the auto-link is the whole point.
          const candidates = findRecurringMatches(tx, recurrings);
          if (candidates[0] && candidates[0].score >= RECURRING_MATCH_AUTO_THRESHOLD) {
            await applyRecurringMatch(client, tx, candidates[0].rule);
            created.push({ ...tx, recurringId: candidates[0].rule.id } as unknown as TransactionRecord);
          } else {
            created.push(tx);
          }
        }
      }

      // Adjust account balance by sum of imported amounts (using effective signs)
      const delta = toImport.reduce((s, r) => s + effectiveAmount(r.amount), 0);
      await adjustBalance(importAccountId, delta, null, "INCOME");

      setTransactions((p) => [...created, ...p]);
      const accs = await listAll(client.models.financeAccount);
      setAccounts(accs);
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  // ── Filtered transactions ─────────────────────────────────────────────────

  // Base filtered list: dropdowns act as filters first; search + sort run on top.
  const filtered = useMemo(
    () => transactions
      .filter((t) => !filterAccount || t.accountId === filterAccount)
      .filter((t) => !filterStatus  || t.status    === filterStatus)
      .filter((t) => !filterType    || t.type      === filterType),
    [transactions, filterAccount, filterStatus, filterType],
  );

  // Quick account lookup for columns
  const accountById = useMemo(() => {
    const m = new Map<string, AccountRecord>();
    for (const a of accounts) m.set(a.id, a);
    return m;
  }, [accounts]);

  const recurringById = useMemo(() => {
    const m = new Map<string, RecurringRecord>();
    for (const r of recurrings) m.set(r.id, r);
    return m;
  }, [recurrings]);

  // Goal allocations — used to show surplus badges on account chips so the user can
  // see at a glance which accounts have cash that isn't earmarked for any goal.
  const allocations = useMemo(
    () => computeGoalAllocations(accounts, goals, mappings, lots, quotes),
    [accounts, goals, mappings, lots, quotes],
  );

  const txColumns: ColDef<TransactionRecord>[] = useMemo(() => [
    {
      key: "date",
      label: "Date",
      sortValue: (t) => t.date ?? "",
      render: (t) => <span className="text-gray-500 dark:text-gray-400 whitespace-nowrap text-xs">{fmtDate(t.date)}</span>,
    },
    {
      key: "description",
      label: "Description",
      sortValue: (t) => (t.description ?? "").toLowerCase(),
      searchValue: (t) => {
        const rule = t.recurringId ? recurringById.get(t.recurringId) : null;
        return `${t.description ?? ""} ${t.category ?? ""} ${rule?.description ?? ""}`;
      },
      render: (t) => {
        const rule = t.recurringId ? recurringById.get(t.recurringId) : null;
        return (
          <div className="flex flex-col gap-0.5">
            <span className="text-gray-800 dark:text-gray-200 block max-w-[240px] truncate">{t.description || "—"}</span>
            {rule && (
              <span
                className="inline-flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400"
                title={`Linked to recurring rule: ${rule.description ?? ""}`}
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: FINANCE_COLOR }}
                />
                {rule.description ?? "recurring"}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "category",
      label: "Category",
      sortValue: (t) => (t.category ?? "").toLowerCase(),
      mobileHidden: true,
      render: (t) => <span className="text-gray-400 text-xs">{t.category || "—"}</span>,
    },
    {
      key: "account",
      label: "Account",
      sortValue: (t) => accountById.get(t.accountId ?? "")?.name?.toLowerCase() ?? "",
      searchValue: (t) => accountById.get(t.accountId ?? "")?.name ?? "",
      mobileHidden: true,
      render: (t) => {
        const acc = accountById.get(t.accountId ?? "");
        return (
          <div className="flex items-center gap-1.5">
            <span className="text-gray-700 dark:text-gray-200 text-xs truncate max-w-[120px]">{acc?.name ?? "—"}</span>
            <AccountBadge type={acc?.type} />
          </div>
        );
      },
    },
    {
      key: "status",
      label: "Status",
      sortValue: (t) => t.status ?? "",
      align: "center",
      mobileHidden: true,
      render: (t) => <StatusBadge status={t.status} />,
    },
    {
      key: "amount",
      label: "Amount",
      sortValue: (t) => t.amount ?? 0,
      align: "right",
      render: (t) => {
        const acc = accountById.get(t.accountId ?? "");
        return (
          <span className="tabular-nums font-semibold whitespace-nowrap" style={{ color: amountColor(t.amount ?? 0) }}>
            {fmtCurrency(t.amount, acc?.currency ?? "USD", true)}
          </span>
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [accountById, recurringById]);

  const txCtl = useTableControls(filtered, {
    defaultSortKey: "date",
    defaultSortDir: "desc",
    getSortValue: (row, key) => txColumns.find((c) => c.key === key)?.sortValue?.(row),
    getSearchText: (row) => txColumns.map((c) => c.searchValue?.(row) ?? "").filter(Boolean).join(" "),
    initialPageSize: 100,
  });

  if (authState !== "authenticated") return null;

  return (
    <FinanceLayout>
      <div className="flex h-full">

        {/* ── Main ─────────────────────────────────────────────────────── */}
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

          {/* Breadcrumb */}
          <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
            <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
          </div>

          {/* Header */}
          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-purple dark:text-rose">Transactions</h1>
            <div className="flex gap-2 flex-wrap">
              <button onClick={openImport} className="px-3 py-1.5 rounded text-xs font-semibold border transition-colors"
                style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR, backgroundColor: FINANCE_COLOR + "18" }}>
                Import CSV
              </button>
              <button onClick={openNewTx} className="px-4 py-1.5 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity">
                + Transaction
              </button>
            </div>
          </div>

          {/* Account balance strip */}
          {accounts.filter((a) => a.active !== false).length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {accounts.filter((a) => a.active !== false).map((acc) => {
                // Surplus: cash on this account that no mapped goal has absorbed.
                // undefined = no mappings at all on this account; skip badge.
                // > 0     = there's unallocated cash; nudge to map it.
                const surplus = allocations.surplusByAccount.get(acc.id);
                const showSurplus = surplus !== undefined && surplus > 0.5 && acc.type !== "CREDIT" && acc.type !== "LOAN";
                return (
                  <a key={acc.id}
                    href={`/finance/accounts/${acc.id}`}
                    className="px-3 py-1 rounded-full text-xs font-semibold transition-opacity hover:opacity-80 border"
                    style={{ backgroundColor: FINANCE_COLOR + "18", color: FINANCE_COLOR, borderColor: FINANCE_COLOR + "55" }}
                  >
                    {acc.name}:
                    {acc.type === "CREDIT" && (acc.creditLimit ?? 0) > 0 ? (() => {
                      // currentBalance is negative when money is owed; flip sign for utilization
                      const owed = Math.max(0, -(acc.currentBalance ?? 0));
                      const util = Math.min(1, owed / (acc.creditLimit ?? 1));
                      return (
                        <span className="tabular-nums">
                          {" "}{fmtCurrency(acc.currentBalance, acc.currency ?? "USD")} /{" "}
                          {fmtCurrency(acc.creditLimit, acc.currency ?? "USD")}{" "}
                          ({Math.round(util * 100)}%)
                        </span>
                      );
                    })() : (
                      <span className="tabular-nums">{" "}{fmtCurrency(acc.currentBalance, acc.currency ?? "USD")}</span>
                    )}
                    {showSurplus && (
                      <span
                        className="ml-1 tabular-nums font-medium"
                        style={{ color: "#f59e0b", opacity: 0.9 }}
                        title={`${fmtCurrency(surplus, acc.currency ?? "USD")} not allocated to any goal`}
                      >
                        · +{fmtCurrency(surplus, acc.currency ?? "USD")}
                      </span>
                    )}
                  </a>
                );
              })}
            </div>
          )}

          {/* Filters + search */}
          <div className="flex flex-wrap gap-2 mb-4 items-center">
            <select className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-1 text-gray-600 dark:text-gray-300"
              value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)}>
              <option value="">All accounts</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-1 text-gray-600 dark:text-gray-300"
              value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="POSTED">Posted</option>
              <option value="PENDING">Pending</option>
            </select>
            <select className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-1 text-gray-600 dark:text-gray-300"
              value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="">All types</option>
              <option value="INCOME">Income</option>
              <option value="EXPENSE">Expense</option>
              <option value="TRANSFER">Transfer</option>
            </select>
            <div className="ml-auto">
              <SearchInput value={txCtl.search} onChange={txCtl.setSearch} placeholder="Search description, category, account…" />
            </div>
          </div>

          {/* Table */}
          {loading ? (
            <p className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</p>
          ) : filtered.length === 0 ? (
            <EmptyState label="transactions" onAdd={openNewTx} />
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
              <DataTable
                rows={txCtl.paged}
                columns={txColumns}
                sortKey={txCtl.sortKey}
                sortDir={txCtl.sortDir}
                onSort={txCtl.handleSort}
                onRowClick={openEditTx}
                emptyMessage={txCtl.search ? "No matches" : "No transactions"}
              />
              <TableControls
                page={txCtl.page}
                totalPages={txCtl.totalPages}
                totalItems={txCtl.totalItems}
                totalUnfiltered={txCtl.totalUnfiltered}
                pageSize={txCtl.pageSize}
                setPage={txCtl.setPage}
                setPageSize={txCtl.setPageSize}
              />
            </div>
          )}
        </div>

        {/* ── Side panel ───────────────────────────────────────────────── */}
        {panel && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-96 border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">

            {/* ── Transaction panel ─────────────────────────────────── */}
            {(panel.kind === "new-tx" || panel.kind === "edit-tx") && (
              <>
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
                  <h2 className="text-base font-semibold dark:text-rose text-purple">
                    {panel.kind === "new-tx" ? "New Transaction" : "Edit Transaction"}
                  </h2>
                  <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
                </div>
                <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
                  <div>
                    <label className={labelCls}>Account *</label>
                    <select className={inputCls} value={txDraft.accountId ?? ""}
                      onChange={(e) => setTxDraft((d) => ({ ...d, accountId: e.target.value }))}>
                      <option value="">Select account…</option>
                      {accounts.filter((a) => a.active !== false).map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>Type</label>
                      <select className={inputCls} value={txDraft.type ?? "EXPENSE"}
                        onChange={(e) => {
                          const newType = e.target.value as TxType;
                          setTxDraft((d) => {
                            const raw = Math.abs(d.amount ?? 0);
                            return {
                              ...d,
                              type: newType as any,
                              amount: newType === "INCOME" ? raw : -raw,
                            };
                          });
                        }}>
                        <option value="INCOME">Income</option>
                        <option value="EXPENSE">Expense</option>
                        <option value="TRANSFER">Transfer</option>
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Status</label>
                      <select className={inputCls} value={txDraft.status ?? "POSTED"}
                        onChange={(e) => setTxDraft((d) => ({ ...d, status: e.target.value as any }))}>
                        <option value="POSTED">Posted</option>
                        <option value="PENDING">Pending</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className={labelCls}>Amount *</label>
                    <input type="number" step="0.01" min="0" className={inputCls} placeholder="0.00"
                      value={Math.abs(txDraft.amount ?? 0) || ""}
                      onChange={(e) => {
                        const raw = parseFloat(e.target.value) || 0;
                        // Income = positive, Expense = negative, Transfer = negative (leaving source account)
                        const signed = txDraft.type === "INCOME" ? Math.abs(raw) : -Math.abs(raw);
                        setTxDraft((d) => ({ ...d, amount: signed }));
                      }} />
                  </div>
                  <div>
                    <label className={labelCls}>Date *</label>
                    <input type="date" className={inputCls} value={txDraft.date ?? ""}
                      onChange={(e) => {
                        const newDate = e.target.value;
                        setTxDraft((d) => ({
                          ...d,
                          date: newDate,
                          // Auto-set PENDING for future dates on new transactions
                          ...(panel?.kind === "new-tx" && newDate > today
                            ? { status: "PENDING" }
                            : panel?.kind === "new-tx" && newDate <= today
                            ? { status: "POSTED" }
                            : {}),
                        }));
                      }} />
                  </div>
                  <div>
                    <label className={labelCls}>Description</label>
                    <input type="text" className={inputCls} placeholder="e.g. Rent, Salary…"
                      value={txDraft.description ?? ""}
                      onChange={(e) => setTxDraft((d) => ({ ...d, description: e.target.value }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Category</label>
                    <input type="text" className={inputCls} placeholder="e.g. Housing, Food…"
                      value={txDraft.category ?? ""}
                      onChange={(e) => setTxDraft((d) => ({ ...d, category: e.target.value }))} />
                  </div>
                  {txDraft.type === "TRANSFER" && (
                    <div>
                      <label className={labelCls}>To Account</label>
                      <select className={inputCls} value={txDraft.toAccountId ?? ""}
                        onChange={(e) => setTxDraft((d) => ({ ...d, toAccountId: e.target.value }))}>
                        <option value="">Select destination…</option>
                        {accounts.filter((a) => a.id !== txDraft.accountId && a.active !== false).map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {/* Linked recurring rule (edit only) — read-only with unlink.
                      Re-linking uses the auto-matcher on save. */}
                  {panel.kind === "edit-tx" && txDraft.recurringId && (
                    <div className="rounded-lg border border-gray-200 dark:border-darkBorder bg-gray-50 dark:bg-darkElevated px-3 py-2 flex items-center justify-between gap-2">
                      <div className="flex flex-col">
                        <span className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Linked to recurring</span>
                        <span className="text-xs text-gray-700 dark:text-gray-200">
                          {recurringById.get(txDraft.recurringId)?.description ?? "(deleted rule)"}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setTxDraft((d) => ({ ...d, recurringId: null as any }))}
                        className="text-[11px] text-gray-400 hover:text-red-500 transition-colors"
                      >
                        Unlink
                      </button>
                    </div>
                  )}
                  <SaveButton saving={saving} onSave={handleSaveTx}
                    label={panel.kind === "new-tx" ? "Add Transaction" : "Save"} />
                  {panel.kind === "edit-tx" && (
                    <DeleteButton saving={saving} onDelete={() => handleDeleteTx(panel.tx)} />
                  )}
                </div>
              </>
            )}

            {/* ── Import panel ──────────────────────────────────────── */}
            {panel.kind === "import" && (
              <>
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
                  <h2 className="text-base font-semibold dark:text-rose text-purple">Import CSV</h2>
                  <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
                </div>
                <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
                  <p className="text-xs text-gray-400">
                    Supports Chase, Bank of America, Amex, and generic CSV exports. Duplicates are detected automatically.
                  </p>

                  <div>
                    <label className={labelCls}>Target Account</label>
                    <select className={inputCls} value={importAccountId}
                      onChange={(e) => setImportAccountId(e.target.value)}>
                      <option value="">Select account…</option>
                      {accounts.filter((a) => a.active !== false).map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className={labelCls}>CSV File</label>
                    <input ref={fileRef} type="file" accept=".csv,text/csv"
                      className="text-sm text-gray-600 dark:text-gray-300 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:cursor-pointer"
                      style={{ ["--file-bg" as any]: FINANCE_COLOR + "22" }}
                      onChange={handleFileChange} />
                  </div>

                  <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
                    <input type="checkbox" checked={importReverse}
                      onChange={(e) => setImportReverse(e.target.checked)} />
                    Reverse sign
                    <span className="text-gray-400">— flip all amounts if this file's convention is inverted</span>
                  </label>

                  {importFormat && (
                    <p className="text-xs text-gray-400">
                      Detected format: <span className="font-medium text-gray-600 dark:text-gray-300">{importFormat}</span>
                      {" · "}{importRows.length} rows
                      {" · "}<span style={{ color: FINANCE_COLOR }}>{importRows.filter((r) => r.selected).length} selected</span>
                      {importRows.some((r) => r.duplicate) && (
                        <span className="text-amber-500"> · {importRows.filter((r) => r.duplicate).length} duplicates</span>
                      )}
                    </p>
                  )}

                  {/* Balance preview — shows current vs predicted balance after selected imports apply */}
                  {importAccountId && importRows.length > 0 && (() => {
                    const tgt = accounts.find((a) => a.id === importAccountId);
                    if (!tgt) return null;
                    const delta = importRows
                      .filter((r) => r.selected && !r.duplicate)
                      .reduce((s, r) => s + effectiveAmount(r.amount), 0);
                    const currentBal   = tgt.currentBalance ?? 0;
                    const predictedBal = currentBal + delta;
                    const cur = tgt.currency ?? "USD";
                    return (
                      <div className="rounded-lg border border-gray-200 dark:border-darkBorder bg-gray-50 dark:bg-darkElevated px-3 py-2 flex flex-col gap-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-400">Current balance</span>
                          <span className="tabular-nums font-medium" style={{ color: amountColor(currentBal) }}>
                            {fmtCurrency(currentBal, cur)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-400">Net change</span>
                          <span className="tabular-nums font-medium" style={{ color: amountColor(delta) }}>
                            {fmtCurrency(delta, cur, true)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm pt-1 border-t border-gray-200 dark:border-gray-700">
                          <span className="text-gray-500 dark:text-gray-400 font-medium">Predicted balance</span>
                          <span className="tabular-nums font-bold" style={{ color: amountColor(predictedBal) }}>
                            {fmtCurrency(predictedBal, cur)}
                          </span>
                        </div>
                      </div>
                    );
                  })()}

                  {importRows.length > 0 && (
                    <>
                      <div className="flex gap-2">
                        <button onClick={() => setImportRows((r) => r.map((row) => ({ ...row, selected: !row.duplicate })))}
                          className="text-xs underline" style={{ color: FINANCE_COLOR }}>Select all new</button>
                        <button onClick={() => setImportRows((r) => r.map((row) => ({ ...row, selected: false })))}
                          className="text-xs underline text-gray-400">Deselect all</button>
                      </div>

                      <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden max-h-64 overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead className="bg-gray-50 dark:bg-darkElevated sticky top-0">
                            <tr>
                              <th className="px-2 py-1.5 w-6" />
                              <th className="px-2 py-1.5 text-left text-gray-400 font-medium">Date</th>
                              <th className="px-2 py-1.5 text-left text-gray-400 font-medium">Description</th>
                              <th className="px-2 py-1.5 text-right text-gray-400 font-medium">Amount</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                            {importRows.map((row, idx) => (
                              <tr key={idx}
                                className={row.duplicate ? "opacity-40" : ""}
                                onClick={() => !row.duplicate && setImportRows((r) =>
                                  r.map((x, i) => i === idx ? { ...x, selected: !x.selected } : x))}>
                                <td className="px-2 py-1">
                                  <input type="checkbox" checked={row.selected} readOnly
                                    className="pointer-events-none" />
                                </td>
                                <td className="px-2 py-1 whitespace-nowrap text-gray-500">{fmtDate(row.date)}</td>
                                <td className="px-2 py-1 truncate max-w-[140px] text-gray-700 dark:text-gray-300">
                                  {row.description}
                                  {row.duplicate && <span className="ml-1 text-amber-500">(dup)</span>}
                                </td>
                                <td className="px-2 py-1 text-right tabular-nums font-medium"
                                  style={{ color: amountColor(effectiveAmount(row.amount)) }}>
                                  {fmtCurrency(effectiveAmount(row.amount), "USD", true)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <SaveButton saving={saving} onSave={handleImport}
                        label={`Import ${importRows.filter((r) => r.selected && !r.duplicate).length} transactions`} />
                    </>
                  )}
                </div>
              </>
            )}

          </div>
        )}
      </div>
    </FinanceLayout>
  );
}
