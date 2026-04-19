import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useRouter } from "next/router";
import NextLink from "next/link";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  AccountRecord, HoldingLotRecord, TickerQuoteRecord,
  ACCOUNT_TYPE_LABELS, RETIREMENT_TYPE_LABELS, FINANCE_COLOR,
  fmtCurrency, amountColor,
  accountTotalValue, buildQuoteMap, isInvestedAccount,
  AccountBadge,
  listAll,
  type AccountType,
} from "@/components/finance/_shared";
import {
  ColDef, DataTable, SearchInput, TableControls, useTableControls,
} from "@/components/common/table";

/**
 * Dedicated Accounts page. The dashboard only shows favorited accounts; this is
 * the full list with search, sort, and favorite toggling.
 *
 * Clicking a row navigates to /finance/accounts/[id] — the detail page (with
 * holdings, transactions, refresh prices, etc).
 *
 * Row type is denormalized to keep column sort/search helpers clean: we
 * precompute totalValue (cash + holdings) and creditUtilization once per row.
 */
type AccountRow = {
  id:           string;
  account:      AccountRecord;
  totalValue:   number;
  utilization:  number | null;   // 0..1 for CREDIT accounts with a limit; null otherwise
};

export default function AccountsPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [lots,     setLots]     = useState<HoldingLotRecord[]>([]);
  const [quotes,   setQuotes]   = useState<TickerQuoteRecord[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [busyId,   setBusyId]   = useState<string | null>(null);   // id of the account whose star is mid-toggle

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [accs, lotRecs, quoteRecs] = await Promise.all([
        listAll(client.models.financeAccount),
        listAll(client.models.financeHoldingLot),
        listAll(client.models.financeTickerQuote),
      ]);
      setAccounts(accs);
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

  // ── Derived ──────────────────────────────────────────────────────────

  const quoteMap = useMemo(() => buildQuoteMap(quotes), [quotes]);

  const rows: AccountRow[] = useMemo(() => accounts.map((acc) => {
    const totalValue = accountTotalValue(acc, lots, quoteMap);
    // Credit utilization: owed balance (positive of negative currentBalance) / limit.
    // Only meaningful for CREDIT accounts with a limit > 0.
    let utilization: number | null = null;
    if (acc.type === "CREDIT" && (acc.creditLimit ?? 0) > 0) {
      const owed = Math.max(0, -(acc.currentBalance ?? 0));
      utilization = Math.min(1, owed / (acc.creditLimit ?? 1));
    }
    return { id: acc.id, account: acc, totalValue, utilization };
  }), [accounts, lots, quoteMap]);

  // ── Toggle favorite ──────────────────────────────────────────────────

  async function toggleFavorite(acc: AccountRecord) {
    setBusyId(acc.id);
    try {
      const next = !(acc.favorite ?? false);
      await client.models.financeAccount.update({ id: acc.id, favorite: next });
      setAccounts((prev) => prev.map((a) => a.id === acc.id ? { ...a, favorite: next } : a));
    } catch (err: any) {
      console.error("[accounts] toggle favorite failed:", err);
      alert(`Failed to update favorite: ${err?.message ?? String(err)}`);
    } finally {
      setBusyId(null);
    }
  }

  // ── Columns ──────────────────────────────────────────────────────────

  const columns: ColDef<AccountRow>[] = useMemo(() => [
    {
      key: "favorite",
      label: "",
      className: "w-8",
      sortValue: (r) => r.account.favorite ? 0 : 1,  // favorites first when sorting by this column
      render: (r) => {
        const fav = r.account.favorite ?? false;
        const busy = busyId === r.id;
        return (
          <button
            onClick={(e) => { e.stopPropagation(); toggleFavorite(r.account); }}
            disabled={busy}
            title={fav ? "Unstar — remove from dashboard" : "Star — pin to dashboard"}
            className="text-lg leading-none transition-opacity disabled:opacity-30"
            style={{ color: fav ? "#f59e0b" : "#9ca3af" }}
          >
            {fav ? "★" : "☆"}
          </button>
        );
      },
    },
    {
      key: "name",
      label: "Name",
      sortValue: (r) => (r.account.name ?? "").toLowerCase(),
      searchValue: (r) => `${r.account.name ?? ""} ${r.account.notes ?? ""}`,
      render: (r) => (
        <div>
          <p className="font-semibold text-gray-800 dark:text-gray-100">{r.account.name}</p>
          {r.account.notes && <p className="text-[11px] text-gray-400 truncate max-w-[240px]">{r.account.notes}</p>}
        </div>
      ),
    },
    {
      key: "type",
      label: "Type",
      sortValue: (r) => r.account.type ?? "",
      searchValue: (r) => `${ACCOUNT_TYPE_LABELS[r.account.type as AccountType] ?? ""} ${r.account.retirementType ?? ""}`,
      render: (r) => {
        const retirementLabel = r.account.type === "RETIREMENT" && r.account.retirementType
          ? RETIREMENT_TYPE_LABELS[r.account.retirementType as keyof typeof RETIREMENT_TYPE_LABELS]
          : null;
        return (
          <div className="flex items-center gap-2">
            <AccountBadge type={r.account.type} />
            {retirementLabel && (
              <span className="text-[10px] text-gray-500 dark:text-gray-400">{retirementLabel}</span>
            )}
          </div>
        );
      },
    },
    {
      key: "balance",
      label: "Balance",
      sortValue: (r) => r.totalValue,
      align: "right",
      render: (r) => {
        const cur = r.account.currency ?? "USD";
        const invested = isInvestedAccount(r.account.type);
        return (
          <div className="text-right">
            <span
              className="tabular-nums font-semibold whitespace-nowrap"
              style={{ color: amountColor(r.totalValue) }}
            >
              {fmtCurrency(r.totalValue, cur)}
            </span>
            {invested && (
              <p className="text-[10px] text-gray-400 tabular-nums">
                Cash {fmtCurrency(r.account.currentBalance, cur)}
              </p>
            )}
          </div>
        );
      },
    },
    {
      key: "utilization",
      label: "Utilization",
      sortValue: (r) => r.utilization ?? -1,   // non-credit accounts sort to bottom ascending
      align: "right",
      mobileHidden: true,
      render: (r) => {
        if (r.utilization == null) return <span className="text-gray-400">—</span>;
        const color = r.utilization > 0.7 ? "#ef4444" : r.utilization > 0.3 ? "#f59e0b" : FINANCE_COLOR;
        return (
          <div className="flex items-center justify-end gap-2">
            <div className="h-1 w-16 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${r.utilization * 100}%`, backgroundColor: color }} />
            </div>
            <span className="text-xs tabular-nums" style={{ color }}>{Math.round(r.utilization * 100)}%</span>
          </div>
        );
      },
    },
    {
      key: "active",
      label: "Status",
      sortValue: (r) => r.account.active === false ? 1 : 0,
      align: "center",
      mobileHidden: true,
      render: (r) => (
        r.account.active === false ? (
          <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
            Inactive
          </span>
        ) : (
          <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
            Active
          </span>
        )
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [busyId]);

  const ctl = useTableControls(rows, {
    // Default sort: favorites first, then by balance desc within each group.
    // Implemented as a synthetic __smart key (same trick as prices.tsx).
    defaultSortKey: "__smart",
    defaultSortDir: "asc",
    getSortValue: (row, key) => {
      if (key === "__smart") {
        // Favorites first (lower sort value), then larger balances first within each group.
        // Negate balance so desc-within-group works under asc sort.
        const favBucket = row.account.favorite ? 0 : 1;
        return favBucket * 1e15 - row.totalValue;
      }
      return columns.find((c) => c.key === key)?.sortValue?.(row);
    },
    getSearchText: (row) => columns.map((c) => c.searchValue?.(row) ?? "").filter(Boolean).join(" "),
    initialPageSize: 50,
  });

  if (authState !== "authenticated") return null;

  // Summary stat: combined total across all active accounts (respects holdings valuation)
  const totalNetValue = accounts
    .filter((a) => a.active !== false)
    .reduce((s, a) => s + accountTotalValue(a, lots, quoteMap), 0);

  return (
    <FinanceLayout>
      <div className="px-4 py-5 md:px-6 overflow-auto h-full">

        <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-bold text-purple dark:text-rose">Accounts</h1>
            {accounts.length > 0 && (
              <span className="text-sm text-gray-400 tabular-nums">
                {accounts.length} · Total{" "}
                <span style={{ color: amountColor(totalNetValue) }} className="font-semibold">
                  {fmtCurrency(totalNetValue)}
                </span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <SearchInput value={ctl.search} onChange={ctl.setSearch} placeholder="Search name, type, notes…" />
            <NextLink
              href="/finance/transactions?new-acc=1"
              className="px-3 py-1.5 rounded text-xs font-semibold border transition-colors"
              style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR, backgroundColor: FINANCE_COLOR + "18" }}
            >
              + New Account
            </NextLink>
          </div>
        </div>

        <p className="text-xs text-gray-400 mb-4 max-w-3xl">
          Star accounts you want pinned to the dashboard. Unstarred accounts remain accessible here,
          keeping the dashboard focused on the handful you check most.
        </p>

        {loading ? (
          <p className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</p>
        ) : accounts.length === 0 ? (
          <div className="rounded-xl border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface p-8 text-center">
            <p className="text-sm text-gray-400">
              No accounts yet. Create one on the{" "}
              <NextLink href="/finance/transactions?new-acc=1" className="underline" style={{ color: FINANCE_COLOR }}>
                Transactions page
              </NextLink>.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
            <DataTable
              rows={ctl.paged}
              columns={columns}
              sortKey={ctl.sortKey}
              sortDir={ctl.sortDir}
              onSort={ctl.handleSort}
              onRowClick={(r) => router.push(`/finance/accounts/${r.account.id}`)}
              emptyMessage={ctl.search ? "No matches" : "No accounts"}
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
        )}

      </div>
    </FinanceLayout>
  );
}
