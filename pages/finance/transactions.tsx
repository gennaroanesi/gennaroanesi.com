import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useRouter } from "next/router";
import NextLink from "next/link";
import FinanceLayout from "@/layouts/finance";
import { PageTitle, PageLoading } from "@/components/common/ui";
import {
  client,
  AccountRecord, TransactionRecord, GoalRecord, GoalFundingSourceRecord,
  HoldingLotRecord, HoldingRecord, TickerQuoteRecord, RecurringRecord, SpendGroupRecord,
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
  const [holdings,     setHoldings]     = useState<HoldingRecord[]>([]);
  const [quotes,       setQuotes]       = useState<TickerQuoteRecord[]>([]);
  const [recurrings,   setRecurrings]   = useState<RecurringRecord[]>([]);
  const [spendGroups,  setSpendGroups]  = useState<SpendGroupRecord[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [editingTx,    setEditingTx]    = useState<TransactionRecord | null>(null);

  // Bulk / inline category editing
  const [selected,        setSelected]        = useState<Set<string>>(new Set());
  const [bulkCategory,    setBulkCategory]    = useState("");
  const [bulkGroup,       setBulkGroup]       = useState("");
  const [bulkRecurringId, setBulkRecurringId] = useState("");
  const [savingCats,      setSavingCats]      = useState(false);

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
  // Bulk-link to a recurring rule (or unlink when recurringId is null).
  // Doesn't advance the rule's nextDate — that lives in applyRecurringMatch
  // and we don't want to drift the schedule from a bulk-correct action.
  const saveRecurring = useCallback(async (ids: string[], recurringId: string | null) => {
    setTransactions((prev) => prev.map((t) => (ids.includes(t.id) ? ({ ...t, recurringId } as TransactionRecord) : t)));
    setSavingCats(true);
    try {
      for (const id of ids) {
        try { await client.models.financeTransaction.update({ id, recurringId }); }
        catch (e) { console.error("recurring link update failed", id, e); }
      }
    } finally { setSavingCats(false); }
  }, []);
  const toggleSelect = useCallback((id: string) => {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);

  // Filters
  const [filterAccount,     setFilterAccount]     = useState<string>("");
  const [filterAccountType, setFilterAccountType] = useState<string>("");
  const [filterStatus,      setFilterStatus]      = useState<string>("");
  const [filterType,        setFilterType]        = useState<string>("");
  // Recurring-link filter: "" = all, "unlinked" = no rule, "linked" = any
  // rule, or a specific recurring rule id.
  const [filterRecurring, setFilterRecurring] = useState<string>("");
  // Date-range filter (inclusive). Empty string = unbounded on that side.
  // Transaction.date is stored as YYYY-MM-DD, so string compare works.
  const [filterFromDate,  setFilterFromDate]  = useState<string>("");
  const [filterToDate,    setFilterToDate]    = useState<string>("");

  // Bulk-delete progress state
  const [deletingBulk, setDeletingBulk] = useState(false);

  // ── Data fetching ─────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Explicit type args on each listAll: without them TS infers T from the
      // (very deep) Amplify model types, and the 8-way Promise.all tuple trips
      // "Type instantiation is excessively deep" (TS2589). Passing T directly
      // keeps the tuple shallow while preserving full typing.
      const [accs, txs, gls, maps, lotRecs, holdingRecs, quoteRecs, recRecs, groupRecs] = await Promise.all([
        listAll<AccountRecord>(client.models.financeAccount),
        listAll<TransactionRecord>(client.models.financeTransaction),
        listAll<GoalRecord>(client.models.financeSavingsGoal),
        listAll<GoalFundingSourceRecord>(client.models.financeGoalFundingSource),
        listAll<HoldingLotRecord>(client.models.financeHoldingLot),
        listAll<HoldingRecord>(client.models.financeHolding),
        listAll<TickerQuoteRecord>(client.models.financeTickerQuote),
        listAll<RecurringRecord>(client.models.financeRecurring),
        listAll<SpendGroupRecord>(client.models.financeSpendGroup as any),
      ]);
      setAccounts(accs);
      setTransactions(txs);
      setGoals(gls);
      setMappings(maps);
      setLots(lotRecs);
      setHoldings(holdingRecs);
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

  const accountTypeById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts) m.set(a.id, a.type ?? "");
    return m;
  }, [accounts]);

  const filtered = useMemo(
    () => transactions
      .filter((t) => !filterAccount     || t.accountId === filterAccount)
      .filter((t) => !filterAccountType || accountTypeById.get(t.accountId ?? "") === filterAccountType)
      .filter((t) => !filterStatus      || t.status    === filterStatus)
      .filter((t) => !filterType        || t.type      === filterType)
      .filter((t) => !filterFromDate    || (t.date ?? "") >= filterFromDate)
      .filter((t) => !filterToDate      || (t.date ?? "") <= filterToDate)
      .filter((t) => {
        if (!filterRecurring)            return true;
        if (filterRecurring === "unlinked") return !t.recurringId;
        if (filterRecurring === "linked")   return !!t.recurringId;
        return t.recurringId === filterRecurring;
      }),
    [transactions, filterAccount, filterAccountType, filterStatus, filterType, filterFromDate, filterToDate, filterRecurring, accountTypeById],
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

  // Trade rows whose cash impact lives on a sibling EXPENSE/INCOME (linked
  // via `notes: tradeTxId:<id>`). The trade row's stored `amount` is still
  // the signed cash impact (needed for realizedGain), but rendering it in
  // the Amount column would visually double-count alongside the sibling.
  const tradeRowsWithSibling = useMemo(() => {
    const s = new Set<string>();
    for (const t of transactions) {
      const n = t.notes ?? "";
      if (n.startsWith("tradeTxId:")) s.add(n.slice("tradeTxId:".length));
    }
    return s;
  }, [transactions]);

  const allocations = useMemo(
    () => computeGoalAllocations(accounts, goals, mappings, holdings, quotes),
    [accounts, goals, mappings, holdings, quotes],
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
        const rule  = t.recurringId ? recurringById.get(t.recurringId) : null;
        const trade = isTradeType(t.type as any);
        const gain  = realizedGain(t);
        // Schwab-style trade detail: qty · ticker @ price · fees, shown under
        // the description so the row reconstructs the trade economics at a
        // glance. Only renders when at least one trade field is populated.
        const tradeBits: string[] = [];
        if (trade && t.quantity != null) tradeBits.push(`${t.quantity} sh`);
        if (trade && t.ticker)           tradeBits.push(t.ticker);
        if (trade && (t as any).price != null) tradeBits.push(`@ ${fmtCurrency((t as any).price, "USD")}`);
        if (trade && (t as any).fees != null && (t as any).fees > 0) {
          tradeBits.push(`fees ${fmtCurrency((t as any).fees, "USD")}`);
        }
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
            {tradeBits.length > 0 && (
              <span className="text-[10px] text-gray-500 dark:text-gray-400 tabular-nums">
                {tradeBits.join(" · ")}
              </span>
            )}
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
        // Trade row with a cash sibling → blank the amount so the user
        // doesn't read the same dollar value twice (sibling shows it).
        if (isTradeType(t.type as any) && tradeRowsWithSibling.has(t.id)) {
          return <span className="text-gray-400 text-xs">—</span>;
        }
        const acc = accountById.get(t.accountId ?? "");
        return (
          <span className="tabular-nums font-semibold whitespace-nowrap" style={{ color: amountColor(t.amount ?? 0) }}>
            {fmtCurrency(t.amount, acc?.currency ?? "USD", true)}
          </span>
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [accountById, recurringById, selected, toggleSelect, saveOne, tradeRowsWithSibling]);

  const txCtl = useTableControls(filtered, {
    defaultSortKey: "date",
    defaultSortDir: "desc",
    getSortValue: (row, key) => txColumns.find((c) => c.key === key)?.sortValue?.(row),
    getSearchText: (row) => txColumns.map((c) => c.searchValue?.(row) ?? "").filter(Boolean).join(" "),
    initialPageSize: 100,
  });

  const hasActiveFilter =
    !!filterAccount || !!filterAccountType || !!filterStatus || !!filterType ||
    !!filterRecurring || !!filterFromDate || !!filterToDate || !!txCtl.search.trim();

  const deleteSelected = useCallback(async () => {
    if (selected.size === 0 || deletingBulk) return;
    const count = selected.size;
    const ok = confirm(
      `Delete ${count} transaction${count === 1 ? "" : "s"}?\n\n` +
      `⚠️  Account balances will NOT be recomputed. You may need to adjust ` +
      `each affected account's currentBalance manually.\n\n` +
      `This cannot be undone.`
    );
    if (!ok) return;
    setDeletingBulk(true);
    const ids = [...selected];
    const failed: string[] = [];
    try {
      for (const id of ids) {
        try {
          await client.models.financeTransaction.delete({ id });
        } catch (e) {
          console.error("delete failed", id, e);
          failed.push(id);
        }
      }
      const failedSet = new Set(failed);
      setTransactions((prev) => prev.filter((t) => !ids.includes(t.id) || failedSet.has(t.id)));
      setSelected(failedSet);
      if (failed.length > 0) {
        alert(`Deleted ${ids.length - failed.length}. ${failed.length} failed — see console.`);
      }
    } finally {
      setDeletingBulk(false);
    }
  }, [selected, deletingBulk]);
  // Skip trade cash/fee siblings (linked to a parent trade via
  // `notes: tradeTxId:...`) so the visible Σ doesn't double-count the
  // cash impact alongside its parent BUY/SELL row.
  const filteredSum = useMemo(
    () => txCtl.filtered
      .filter((t) => !(t.notes ?? "").startsWith("tradeTxId:"))
      .reduce((s, t) => s + (t.amount ?? 0), 0),
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
            <PageTitle>Transactions</PageTitle>
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
              value={filterAccountType} onChange={(e) => setFilterAccountType(e.target.value)}>
              <option value="">All account types</option>
              <option value="CHECKING">Checking</option>
              <option value="SAVINGS">Savings</option>
              <option value="CREDIT">Credit</option>
              <option value="BROKERAGE">Brokerage</option>
              <option value="RETIREMENT">Retirement</option>
              <option value="LOAN">Loan</option>
              <option value="CASH">Cash</option>
              <option value="OTHER">Other</option>
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
            <select className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-1 text-gray-600 dark:text-gray-300"
              value={filterRecurring} onChange={(e) => setFilterRecurring(e.target.value)}>
              <option value="">All recurring</option>
              <option value="unlinked">Unlinked only</option>
              <option value="linked">Linked (any rule)</option>
              {recurrings.filter((r) => r.active !== false).map((r) => (
                <option key={r.id} value={r.id}>↳ {r.description}</option>
              ))}
            </select>
            <div className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
              <span>From</span>
              <input
                type="date"
                value={filterFromDate}
                onChange={(e) => setFilterFromDate(e.target.value)}
                className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated px-2 py-1 text-gray-600 dark:text-gray-300"
              />
              <span>to</span>
              <input
                type="date"
                value={filterToDate}
                onChange={(e) => setFilterToDate(e.target.value)}
                className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated px-2 py-1 text-gray-600 dark:text-gray-300"
              />
              {(filterFromDate || filterToDate) && (
                <button
                  onClick={() => { setFilterFromDate(""); setFilterToDate(""); }}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 px-1"
                  title="Clear date range"
                >
                  ×
                </button>
              )}
            </div>
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

              {recurrings.filter((r) => r.active !== false).length > 0 && (
                <>
                  <span className="text-gray-300 dark:text-darkBorder">|</span>
                  <select
                    value={bulkRecurringId}
                    onChange={(e) => setBulkRecurringId(e.target.value)}
                    className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-1 text-gray-700 dark:text-gray-200"
                  >
                    <option value="">Link to recurring…</option>
                    <option value="__none__">— None (unlink) —</option>
                    {recurrings.filter((r) => r.active !== false).map((r) => (
                      <option key={r.id} value={r.id}>{r.description}</option>
                    ))}
                  </select>
                  <button
                    disabled={!bulkRecurringId || savingCats}
                    onClick={async () => { await saveRecurring([...selected], bulkRecurringId === "__none__" ? null : bulkRecurringId); setBulkRecurringId(""); setSelected(new Set()); }}
                    className="rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
                    style={{ backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR }}
                  >
                    {savingCats ? "Applying…" : "Link"}
                  </button>
                </>
              )}

              <span className="text-gray-300 dark:text-darkBorder">|</span>
              <button
                onClick={deleteSelected}
                disabled={deletingBulk}
                className="rounded px-3 py-1 text-xs font-medium border border-red-500/40 text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                title="Delete selected transactions. Account balances will NOT be recomputed."
              >
                {deletingBulk ? "Deleting…" : `Delete ${selected.size}`}
              </button>

              <button onClick={() => setSelected(new Set())} className="text-xs text-gray-400 hover:underline">Clear</button>
            </div>
          )}

          {/* Table */}
          {loading ? (
            <PageLoading />
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
            // Key by tx id so selecting a different row remounts the panel and
            // re-seeds its form state — the internal useState initializers only
            // run on mount, so without this the panel keeps showing the first
            // transaction's values when you click another row.
            key={editingTx.id}
            mode="edit"
            editingTx={editingTx}
            accounts={accounts}
            lots={lots}
            recurrings={recurrings}
            transactions={transactions}
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
