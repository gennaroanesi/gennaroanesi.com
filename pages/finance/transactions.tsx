import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useRouter } from "next/router";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  AccountRecord, TransactionRecord,
  ACCOUNT_TYPES, TX_TYPES, TX_STATUSES, FINANCE_COLOR,
  ACCOUNT_TYPE_LABELS,
  RETIREMENT_TYPES, RETIREMENT_TYPE_LABELS, isInvestedAccount,
  fmtCurrency, fmtDate, todayIso, importHash, amountColor,
  inputCls, labelCls,
  SaveButton, DeleteButton, EmptyState, AccountBadge, StatusBadge,
  parseBankCsv, type ParsedTransaction,
  type AccountType, type TxType, type TxStatus,
  listAll,
} from "@/components/finance/_shared";
import {
  ColDef, DataTable, SearchInput, TableControls, useTableControls,
} from "@/components/common/table";

// ── Panel state ───────────────────────────────────────────────────────────────

type PanelState =
  | { kind: "new-tx" }
  | { kind: "edit-tx";   tx:  TransactionRecord }
  | { kind: "new-acc" }
  | { kind: "edit-acc";  acc: AccountRecord }
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
  const [loading,      setLoading]      = useState(true);
  const [saving,       setSaving]       = useState(false);
  const [panel,        setPanel]        = useState<PanelState>(null);

  // Filters
  const [filterAccount, setFilterAccount] = useState<string>("");
  const [filterStatus,  setFilterStatus]  = useState<string>("");
  const [filterType,    setFilterType]    = useState<string>("");

  // Transaction draft
  const [txDraft, setTxDraft] = useState<Partial<TransactionRecord>>({});

  // Account draft
  const [accDraft, setAccDraft] = useState<Partial<AccountRecord>>({});

  // Import state
  const fileRef = useRef<HTMLInputElement>(null);
  const [importFormat,    setImportFormat]    = useState("");
  const [importRows,      setImportRows]      = useState<ImportRow[]>([]);
  const [importAccountId, setImportAccountId] = useState<string>("");
  const [importReverse,   setImportReverse]   = useState(false);

  // ── Data fetching ─────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [accs, txs] = await Promise.all([
        listAll(client.models.financeAccount),
        listAll(client.models.financeTransaction),
      ]);
      setAccounts(accs);
      setTransactions(txs);
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
    // Convenience hook for the Accounts page's "+ New Account" button — deep-links into the existing account panel.
    if (router.query["new-acc"] === "1") {
      openNewAcc();
      router.replace("/finance/transactions", undefined, { shallow: true });
    }
  }, [router.isReady, router.query.new, router.query["new-acc"]]);

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

  function openNewAcc() {
    setAccDraft({ currency: "USD", active: true, currentBalance: 0 });
    setPanel({ kind: "new-acc" });
  }

  function openEditAcc(acc: AccountRecord) {
    setAccDraft({ ...acc });
    setPanel({ kind: "edit-acc", acc });
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
          setTransactions((prev) => [newTx, ...prev]);
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

  // ── Save account ──────────────────────────────────────────────────────────

  async function handleSaveAcc() {
    if (!accDraft.name?.trim()) return;
    setSaving(true);
    try {
      if (panel?.kind === "new-acc") {
        const { data: newAcc } = await client.models.financeAccount.create({
          name:           accDraft.name!,
          type:           (accDraft.type ?? "CHECKING") as any,
          retirementType: (accDraft.type === "RETIREMENT" ? accDraft.retirementType ?? null : null) as any,
          currentBalance: accDraft.currentBalance ?? 0,
          currency:       accDraft.currency ?? "USD",
          notes:          accDraft.notes ?? null,
          active:         accDraft.active ?? true,
          favorite:       accDraft.favorite ?? false,
          creditLimit:    accDraft.creditLimit ?? null,
        });
        if (newAcc) setAccounts((p) => [...p, newAcc]);
      } else if (panel?.kind === "edit-acc") {
        await client.models.financeAccount.update({
          id:             panel.acc.id,
          name:           accDraft.name!,
          type:           (accDraft.type ?? "CHECKING") as any,
          retirementType: (accDraft.type === "RETIREMENT" ? accDraft.retirementType ?? null : null) as any,
          currentBalance: accDraft.currentBalance ?? 0,
          currency:       accDraft.currency ?? "USD",
          notes:          accDraft.notes ?? null,
          active:         accDraft.active ?? true,
          favorite:       accDraft.favorite ?? false,
          creditLimit:    accDraft.creditLimit ?? null,
        });
        setAccounts((p) => p.map((a) => a.id === panel.acc.id ? { ...a, ...accDraft } as AccountRecord : a));
      }
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteAcc(acc: AccountRecord) {
    if (!confirm(`Delete account "${acc.name}"? This does not delete its transactions.`)) return;
    setSaving(true);
    try {
      await client.models.financeAccount.delete({ id: acc.id });
      setAccounts((p) => p.filter((a) => a.id !== acc.id));
      setPanel(null);
    } finally {
      setSaving(false);
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
        if (tx) created.push(tx);
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
      searchValue: (t) => `${t.description ?? ""} ${t.category ?? ""}`,
      render: (t) => <span className="text-gray-800 dark:text-gray-200 block max-w-[200px] truncate">{t.description || "—"}</span>,
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
      render: (t) => <AccountBadge type={accountById.get(t.accountId ?? "")?.type} />,
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
  ], [accountById]);

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

          {/* Header */}
          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-purple dark:text-rose">Transactions</h1>
            <div className="flex gap-2 flex-wrap">
              <button onClick={openImport} className="px-3 py-1.5 rounded text-xs font-semibold border transition-colors"
                style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR, backgroundColor: FINANCE_COLOR + "18" }}>
                Import CSV
              </button>
              <button onClick={openNewAcc} className="px-3 py-1.5 rounded text-xs font-semibold border transition-colors"
                style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR, backgroundColor: FINANCE_COLOR + "18" }}>
                + Account
              </button>
              <button onClick={openNewTx} className="px-4 py-1.5 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity">
                + Transaction
              </button>
            </div>
          </div>

          {/* Account balance strip */}
          {accounts.filter((a) => a.active !== false).length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {accounts.filter((a) => a.active !== false).map((acc) => (
                <button key={acc.id}
                  onClick={() => { openEditAcc(acc); }}
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
                </button>
              ))}
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
                        onChange={(e) => setTxDraft((d) => ({ ...d, type: e.target.value as any }))}>
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
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>Amount</label>
                      <input type="number" step="0.01" className={inputCls} placeholder="0.00"
                        value={txDraft.amount ?? ""}
                        onChange={(e) => setTxDraft((d) => ({ ...d, amount: parseFloat(e.target.value) || 0 }))} />
                      <p className="text-[10px] text-gray-400 mt-0.5">Positive = income · Negative = expense</p>
                    </div>
                    <div>
                      <label className={labelCls}>Date *</label>
                      <input type="date" className={inputCls} value={txDraft.date ?? ""}
                        onChange={(e) => setTxDraft((d) => ({ ...d, date: e.target.value }))} />
                    </div>
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
                  <SaveButton saving={saving} onSave={handleSaveTx}
                    label={panel.kind === "new-tx" ? "Add Transaction" : "Save"} />
                  {panel.kind === "edit-tx" && (
                    <DeleteButton saving={saving} onDelete={() => handleDeleteTx(panel.tx)} />
                  )}
                </div>
              </>
            )}

            {/* ── Account panel ─────────────────────────────────────── */}
            {(panel.kind === "new-acc" || panel.kind === "edit-acc") && (
              <>
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
                  <h2 className="text-base font-semibold dark:text-rose text-purple">
                    {panel.kind === "new-acc" ? "New Account" : "Edit Account"}
                  </h2>
                  <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
                </div>
                <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
                  <div>
                    <label className={labelCls}>Name *</label>
                    <input type="text" className={inputCls} placeholder="Chase Checking"
                      value={accDraft.name ?? ""}
                      onChange={(e) => setAccDraft((d) => ({ ...d, name: e.target.value }))} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>Type</label>
                      <select className={inputCls} value={accDraft.type ?? "CHECKING"}
                        onChange={(e) => setAccDraft((d) => ({ ...d, type: e.target.value as any }))}>
                        {ACCOUNT_TYPES.map((t) => (
                          <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Currency</label>
                      <input type="text" className={inputCls} placeholder="USD" maxLength={3}
                        value={accDraft.currency ?? "USD"}
                        onChange={(e) => setAccDraft((d) => ({ ...d, currency: e.target.value.toUpperCase() }))} />
                    </div>
                  </div>
                  {(accDraft.type ?? "CHECKING") === "RETIREMENT" && (
                    <div>
                      <label className={labelCls}>Retirement Type</label>
                      <select className={inputCls} value={accDraft.retirementType ?? ""}
                        onChange={(e) => setAccDraft((d) => ({ ...d, retirementType: (e.target.value || null) as any }))}>
                        <option value="">— unspecified —</option>
                        {RETIREMENT_TYPES.map((rt) => (
                          <option key={rt} value={rt}>{RETIREMENT_TYPE_LABELS[rt]}</option>
                        ))}
                      </select>
                      <p className="text-[10px] text-gray-400 mt-0.5">Optional, for display only</p>
                    </div>
                  )}
                  <div>
                    <label className={labelCls}>
                      {isInvestedAccount(accDraft.type) ? "Cash Balance" : "Current Balance"}
                    </label>
                    <input type="number" step="0.01" className={inputCls} placeholder="0.00"
                      value={accDraft.currentBalance ?? ""}
                      onChange={(e) => setAccDraft((d) => ({ ...d, currentBalance: parseFloat(e.target.value) || 0 }))} />
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      {isInvestedAccount(accDraft.type)
                        ? "Uninvested cash only. Positions are tracked as lots on the account page."
                        : panel.kind === "new-acc" ? "Opening balance" : "Direct override — use sparingly"}
                    </p>
                  </div>
                  {(accDraft.type ?? "CHECKING") === "CREDIT" && (
                    <div>
                      <label className={labelCls}>Credit Limit</label>
                      <input type="number" step="0.01" min={0} className={inputCls} placeholder="5000.00"
                        value={accDraft.creditLimit ?? ""}
                        onChange={(e) => setAccDraft((d) => ({ ...d, creditLimit: parseFloat(e.target.value) || null as any }))} />
                      {(accDraft.creditLimit ?? 0) > 0 && (accDraft.currentBalance ?? 0) < 0 && (() => {
                        const owed = -(accDraft.currentBalance ?? 0);
                        const util = Math.min(1, owed / (accDraft.creditLimit ?? 1));
                        const color = util > 0.7 ? "#ef4444" : util > 0.3 ? "#f59e0b" : FINANCE_COLOR;
                        return (
                          <p className="text-[10px] mt-1" style={{ color }}>
                            {Math.round(util * 100)}% utilization · {fmtCurrency((accDraft.creditLimit ?? 0) - owed)} available
                          </p>
                        );
                      })()}
                    </div>
                  )}
                  <div>
                    <label className={labelCls}>Notes</label>
                    <input type="text" className={inputCls} placeholder="Last 4 digits, bank name…"
                      value={accDraft.notes ?? ""}
                      onChange={(e) => setAccDraft((d) => ({ ...d, notes: e.target.value }))} />
                  </div>
                  <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                    <input type="checkbox" checked={accDraft.active ?? true}
                      onChange={(e) => setAccDraft((d) => ({ ...d, active: e.target.checked }))} />
                    Active
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                    <input type="checkbox" checked={accDraft.favorite ?? false}
                      onChange={(e) => setAccDraft((d) => ({ ...d, favorite: e.target.checked }))} />
                    <span className="mr-1" style={{ color: "#f59e0b" }}>★</span> Favorite
                    <span className="text-[10px] text-gray-400">(pin to dashboard)</span>
                  </label>
                  <SaveButton saving={saving} onSave={handleSaveAcc}
                    label={panel.kind === "new-acc" ? "Create Account" : "Save"} />
                  {panel.kind === "edit-acc" && (
                    <DeleteButton saving={saving} onDelete={() => handleDeleteAcc(panel.acc)} />
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
