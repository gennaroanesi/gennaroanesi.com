import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useRouter } from "next/router";
import NextLink from "next/link";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  AccountRecord, TransactionRecord, GoalRecord, GoalFundingSourceRecord,
  HoldingLotRecord, TickerQuoteRecord, RecurringRecord, SpendGroupRecord,
  FINANCE_COLOR,
  fmtCurrency, fmtDate, amountColor,
  computeGoalAllocations,
  EmptyState, AccountBadge, StatusBadge,
  isTradeType, realizedGain,
  listAll,
} from "@/components/finance/_shared";
import {
  ColDef, DataTable, SearchInput, TableControls, useTableControls,
} from "@/components/common/table";
import { TransactionPanel } from "@/components/finance/TransactionPanel";
import { CATEGORY_RULES } from "@/components/finance/categories";

const CATEGORY_LIST_ID = "tx-category-options";

/** Inline category editor: a datalist-backed typeahead. Stops row-click
 *  propagation so editing doesn't open the full edit panel. Commits on
 *  blur / Enter when the value changed. */
function CategoryCell({
  tx, onSave,
}: { tx: TransactionRecord; onSave: (id: string, category: string) => void }) {
  const [val, setVal] = React.useState(tx.category ?? "");
  React.useEffect(() => { setVal(tx.category ?? ""); }, [tx.id, tx.category]);
  const commit = () => { if ((tx.category ?? "") !== val.trim()) onSave(tx.id, val.trim()); };
  return (
    <input
      list={CATEGORY_LIST_ID}
      value={val}
      placeholder="—"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") { setVal(tx.category ?? ""); (e.target as HTMLInputElement).blur(); }
      }}
      className="w-28 bg-transparent border border-transparent rounded px-1 py-0.5 text-xs text-gray-500 dark:text-gray-300 hover:border-gray-300 dark:hover:border-darkBorder focus:border-gray-400 dark:focus:border-gray-500 focus:outline-none"
    />
  );
}

// The /finance/transactions surface is now a cross-account ledger viewer.
// Creating transactions and importing CSVs both live on the account detail
// page. Clicking a row here opens the same shared <TransactionPanel> in edit
// mode — convenient for bulk corrections across accounts without losing the
// global view.

export default function TransactionsPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [accounts,     setAccounts]     = useState<AccountRecord[]>([]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  // Goals + mappings + lots + quotes are loaded only to compute the surplus
  // badge on the account chips. Mapping/lot CRUD lives elsewhere.
  const [goals,        setGoals]        = useState<GoalRecord[]>([]);
  const [mappings,     setMappings]     = useState<GoalFundingSourceRecord[]>([]);
  const [lots,         setLots]         = useState<HoldingLotRecord[]>([]);
  const [quotes,       setQuotes]       = useState<TickerQuoteRecord[]>([]);
  const [recurrings,   setRecurrings]   = useState<RecurringRecord[]>([]);
  const [spendGroups,  setSpendGroups]  = useState<SpendGroupRecord[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [editingTx,    setEditingTx]    = useState<TransactionRecord | null>(null);

  // Bulk / inline category editing
  const [selected,     setSelected]     = useState<Set<string>>(new Set());
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkGroup,    setBulkGroup]    = useState("");
  const [savingCats,   setSavingCats]   = useState(false);

  const saveCategory = useCallback(async (ids: string[], category: string) => {
    const value = category.trim() || null;
    setTransactions((prev) => prev.map((t) => (ids.includes(t.id) ? ({ ...t, category: value } as TransactionRecord) : t)));
    setSavingCats(true);
    try {
      for (const id of ids) {
        try { await client.models.financeTransaction.update({ id, category: value }); }
        catch (e) { console.error("category update failed", id, e); }
      }
    } finally { setSavingCats(false); }
  }, []);
  const saveOne = useCallback((id: string, category: string) => { void saveCategory([id], category); }, [saveCategory]);
  const saveGroup = useCallback(async (ids: string[], groupId: string | null) => {
    setTransactions((prev) => prev.map((t) => (ids.includes(t.id) ? ({ ...t, spendGroupId: groupId } as TransactionRecord) : t)));
    setSavingCats(true);
    try {
      for (const id of ids) {
        try { await client.models.financeTransaction.update({ id, spendGroupId: groupId } as any); }
        catch (e) { console.error("group update failed", id, e); }
      }
    } finally { setSavingCats(false); }
  }, []);
  const toggleSelect = useCallback((id: string) => {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);

  // Filters
  const [filterAccount, setFilterAccount] = useState<string>("");
  const [filterStatus,  setFilterStatus]  = useState<string>("");
  const [filterType,    setFilterType]    = useState<string>("");

  // ── Data fetching ─────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [accs, txs, gls, maps, lotRecs, quoteRecs, recRecs, groupRecs] = await Promise.all([
        listAll(client.models.financeAccount),
        listAll(client.models.financeTransaction),
        listAll(client.models.financeSavingsGoal),
        listAll(client.models.financeGoalFundingSource),
        listAll(client.models.financeHoldingLot),
        listAll(client.models.financeTickerQuote),
        listAll(client.models.financeRecurring),
        listAll(client.models.financeSpendGroup as any),
      ]);
      setAccounts(accs);
      setTransactions(txs);
      setGoals(gls);
      setMappings(maps);
      setLots(lotRecs);
      setQuotes(quoteRecs);
      setRecurrings(recRecs);
      setSpendGroups(groupRecs as SpendGroupRecord[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchData();
  }, [authState, fetchData]);

  // Preselect account filter from ?account= query param
  useEffect(() => {
    if (!router.isReady) return;
    const qAcc = router.query.account;
    if (typeof qAcc === "string" && qAcc) {
      setFilterAccount(qAcc);
    }
  }, [router.isReady, router.query.account]);

  // ── Derived data ──────────────────────────────────────────────────────────

  const filtered = useMemo(
    () => transactions
      .filter((t) => !filterAccount || t.accountId === filterAccount)
      .filter((t) => !filterStatus  || t.status    === filterStatus)
      .filter((t) => !filterType    || t.type      === filterType),
    [transactions, filterAccount, filterStatus, filterType],
  );

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

  const allocations = useMemo(
    () => computeGoalAllocations(accounts, goals, mappings, lots, quotes),
    [accounts, goals, mappings, lots, quotes],
  );

  // Typeahead options: categories already in use + the inference vocabulary.
  const categoryVocab = useMemo(() => {
    const s = new Set<string>();
    for (const t of transactions) if (t.category) s.add(t.category);
    for (const r of CATEGORY_RULES) s.add(r.category);
    ["Uncategorized", "Transfers", "Credit Card Payment", "Investments", "Income", "Cash/ATM"].forEach((c) => s.add(c));
    return [...s].sort();
  }, [transactions]);

  const txColumns: ColDef<TransactionRecord>[] = useMemo(() => [
    {
      key: "select",
      label: "",
      align: "center",
      render: (t) => (
        <input
          type="checkbox"
          checked={selected.has(t.id)}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggleSelect(t.id)}
          className="cursor-pointer align-middle"
        />
      ),
    },
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
        return `${t.description ?? ""} ${t.category ?? ""} ${t.notes ?? ""} ${rule?.description ?? ""}`;
      },
      render: (t) => {
        const rule = t.recurringId ? recurringById.get(t.recurringId) : null;
        const trade = isTradeType(t.type as any);
        const gain  = realizedGain(t);
        return (
          <div className="flex flex-col gap-0.5">
            <span className="text-gray-800 dark:text-gray-200 max-w-[240px] truncate inline-flex items-center gap-1.5">
              {trade && (
                <span className="inline-block px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wide"
                  style={{
                    backgroundColor: t.type === "BUY" ? "#10b98122" : "#f59e0b22",
                    color:           t.type === "BUY" ? "#10b981"   : "#f59e0b",
                  }}>
                  {t.type}
                </span>
              )}
              {t.description || "—"}
            </span>
            {gain != null && (
              <span className="text-[10px] tabular-nums" style={{ color: amountColor(gain) }}
                title="Realized gain on this sale (proceeds − consumed cost basis)">
                Realized {fmtCurrency(gain, "USD", true)}
              </span>
            )}
            {rule && (
              <span className="inline-flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400"
                title={`Linked to recurring rule: ${rule.description ?? ""}`}>
                <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: FINANCE_COLOR }} />
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
      render: (t) => <CategoryCell tx={t} onSave={saveOne} />,
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
  ], [accountById, recurringById, selected, toggleSelect, saveOne]);

  const txCtl = useTableControls(filtered, {
    defaultSortKey: "date",
    defaultSortDir: "desc",
    getSortValue: (row, key) => txColumns.find((c) => c.key === key)?.sortValue?.(row),
    getSearchText: (row) => txColumns.map((c) => c.searchValue?.(row) ?? "").filter(Boolean).join(" "),
    initialPageSize: 100,
  });

  const hasActiveFilter =
    !!filterAccount || !!filterStatus || !!filterType || !!txCtl.search.trim();
  const filteredSum = useMemo(
    () => txCtl.filtered.reduce((s, t) => s + (t.amount ?? 0), 0),
    [txCtl.filtered],
  );
  const filteredCurrency =
    (filterAccount && accountById.get(filterAccount)?.currency) || "USD";

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
            <p className="text-[11px] text-gray-400">
              Create + import from each account&apos;s page.
            </p>
          </div>

          {/* Account balance strip */}
          {accounts.filter((a) => a.active !== false).length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {accounts.filter((a) => a.active !== false).map((acc) => {
                const surplus = allocations.surplusByAccount.get(acc.id);
                const showSurplus = surplus !== undefined && surplus > 0.5 && acc.type !== "CREDIT" && acc.type !== "LOAN";
                return (
                  <a key={acc.id}
                    href={`/finance/accounts/${acc.id}`}
                    className="px-3 py-1 rounded-full text-xs font-semibold transition-opacity hover:opacity-80 border"
                    style={{ backgroundColor: FINANCE_COLOR + "18", color: FINANCE_COLOR, borderColor: FINANCE_COLOR + "55" }}>
                    {acc.name}:
                    {acc.type === "CREDIT" && (acc.creditLimit ?? 0) > 0 ? (() => {
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
                      <span className="ml-1 tabular-nums font-medium"
                        style={{ color: "#f59e0b", opacity: 0.9 }}
                        title={`${fmtCurrency(surplus, acc.currency ?? "USD")} not allocated to any goal`}>
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
              <option value="BUY">Buy</option>
              <option value="SELL">Sell</option>
            </select>
            <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 select-none">
              <input
                type="checkbox"
                checked={txCtl.filtered.length > 0 && txCtl.filtered.every((t) => selected.has(t.id))}
                onChange={(e) => setSelected(e.target.checked ? new Set(txCtl.filtered.map((t) => t.id)) : new Set())}
                className="cursor-pointer"
              />
              Select all{txCtl.filtered.length ? ` (${txCtl.filtered.length})` : ""}
            </label>
            <div className="ml-auto">
              <SearchInput value={txCtl.search} onChange={txCtl.setSearch} placeholder="Search description, category, account…" />
            </div>
          </div>

          {/* Shared category typeahead options */}
          <datalist id={CATEGORY_LIST_ID}>
            {categoryVocab.map((c) => <option key={c} value={c} />)}
          </datalist>

          {/* Bulk category bar */}
          {selected.size > 0 && (
            <div className="flex items-center gap-2 mb-4 p-2 rounded-lg border border-gray-200 dark:border-darkBorder bg-gray-50 dark:bg-white/5 flex-wrap">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">{selected.size} selected</span>
              <input
                list={CATEGORY_LIST_ID}
                value={bulkCategory}
                onChange={(e) => setBulkCategory(e.target.value)}
                placeholder="Set category…"
                className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-1 text-gray-700 dark:text-gray-200"
              />
              <button
                disabled={!bulkCategory.trim() || savingCats}
                onClick={async () => { await saveCategory([...selected], bulkCategory); setBulkCategory(""); setSelected(new Set()); }}
                className="rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
                style={{ backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR }}
              >
                {savingCats ? "Applying…" : "Set category"}
              </button>

              {spendGroups.length > 0 && (
                <>
                  <span className="text-gray-300 dark:text-darkBorder">|</span>
                  <select
                    value={bulkGroup}
                    onChange={(e) => setBulkGroup(e.target.value)}
                    className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-1 text-gray-700 dark:text-gray-200"
                  >
                    <option value="">Set group…</option>
                    <option value="__none__">— None (untag) —</option>
                    {spendGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                  <button
                    disabled={!bulkGroup || savingCats}
                    onClick={async () => { await saveGroup([...selected], bulkGroup === "__none__" ? null : bulkGroup); setBulkGroup(""); setSelected(new Set()); }}
                    className="rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
                    style={{ backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR }}
                  >
                    {savingCats ? "Applying…" : "Set group"}
                  </button>
                </>
              )}

              <button onClick={() => setSelected(new Set())} className="text-xs text-gray-400 hover:underline">Clear</button>
            </div>
          )}

          {/* Table */}
          {loading ? (
            <p className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</p>
          ) : filtered.length === 0 ? (
            <EmptyState label="transactions" />
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
              <DataTable
                rows={txCtl.paged}
                columns={txColumns}
                sortKey={txCtl.sortKey}
                sortDir={txCtl.sortDir}
                onSort={txCtl.handleSort}
                onRowClick={(tx) => setEditingTx(tx)}
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
                summary={hasActiveFilter ? (
                  <span className="tabular-nums font-semibold" style={{ color: amountColor(filteredSum) }}>
                    Σ {fmtCurrency(filteredSum, filteredCurrency, true)}
                  </span>
                ) : undefined}
              />
            </div>
          )}
        </div>

        {/* ── Edit panel (shared) ───────────────────────────────────────── */}
        {editingTx && (
          <TransactionPanel
            mode="edit"
            editingTx={editingTx}
            accounts={accounts}
            lots={lots}
            recurrings={recurrings}
            spendGroups={spendGroups}
            onClose={() => setEditingTx(null)}
            onSetTransactions={setTransactions}
            onSetAccounts={setAccounts}
            onSetLots={setLots}
          />
        )}
      </div>
    </FinanceLayout>
  );
}
