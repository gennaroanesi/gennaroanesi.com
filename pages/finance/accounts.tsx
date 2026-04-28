import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useRouter } from "next/router";
import NextLink from "next/link";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  AccountRecord, HoldingLotRecord, TickerQuoteRecord,
  ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS,
  RETIREMENT_TYPES, RETIREMENT_TYPE_LABELS, FINANCE_COLOR,
  fmtCurrency, amountColor,
  accountTotalValue, buildQuoteMap, isInvestedAccount,
  AccountBadge,
  inputCls, labelCls,
  SaveButton,
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

  // Account side panel — handles both create and edit. Brokerage/retirement
  // accounts still have their own detail page (holdings + per-account tx);
  // for everything else, click navigates to the filtered transactions list and
  // edit happens via the per-row Edit button which opens this panel.
  type PanelMode = null | "new" | { kind: "edit"; id: string };
  const [panelMode, setPanelMode] = useState<PanelMode>(null);
  const [saving,    setSaving]    = useState(false);
  const [accDraft,  setAccDraft]  = useState<Partial<AccountRecord>>({});

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

  // ── Create / edit / delete account ───────────────────────────────────
  // The same side panel handles new + edit. Mode is encoded in panelMode.
  // Goal-funding-source mapping is still managed on the brokerage detail
  // page or the goals page — out of scope here.

  function openNewAcc() {
    setAccDraft({ currency: "USD", active: true, currentBalance: 0, type: "CHECKING" as any });
    setPanelMode("new");
  }

  function openEditAcc(acc: AccountRecord) {
    setAccDraft({ ...acc });
    setPanelMode({ kind: "edit", id: acc.id });
  }

  async function handleSaveAcc() {
    if (!accDraft.name?.trim()) return;
    setSaving(true);
    try {
      const isCredit  = accDraft.type === "CREDIT";
      const isSavings = accDraft.type === "SAVINGS";
      const payload = {
        name:                accDraft.name!,
        type:                (accDraft.type ?? "CHECKING") as any,
        retirementType:      (accDraft.type === "RETIREMENT" ? accDraft.retirementType ?? null : null) as any,
        currentBalance:      accDraft.currentBalance ?? 0,
        currency:            accDraft.currency ?? "USD",
        notes:               accDraft.notes ?? null,
        active:              accDraft.active ?? true,
        favorite:            accDraft.favorite ?? false,
        creditLimit:         accDraft.creditLimit ?? null,
        statementClosingDay: isCredit  ? accDraft.statementClosingDay ?? null : null,
        apr:                 isCredit  ? accDraft.apr                 ?? null : null,
        apy:                 isSavings ? accDraft.apy                 ?? null : null,
      };

      if (panelMode === "new") {
        const { data: newAcc } = await client.models.financeAccount.create(payload);
        if (newAcc) setAccounts((p) => [...p, newAcc]);
      } else if (panelMode && typeof panelMode === "object" && panelMode.kind === "edit") {
        const id = panelMode.id;
        await client.models.financeAccount.update({ id, ...payload });
        setAccounts((p) => p.map((a) => a.id === id ? { ...a, ...payload } as AccountRecord : a));
      }
      setPanelMode(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteAcc() {
    if (!panelMode || typeof panelMode !== "object" || panelMode.kind !== "edit") return;
    const id = panelMode.id;
    const target = accounts.find((a) => a.id === id);
    if (!confirm(`Delete account "${target?.name ?? id}"? Transactions on this account will not be deleted.`)) return;
    setSaving(true);
    try {
      await client.models.financeAccount.delete({ id });
      setAccounts((p) => p.filter((a) => a.id !== id));
      setPanelMode(null);
    } finally {
      setSaving(false);
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
    {
      key: "actions",
      label: "",
      align: "right",
      className: "w-16",
      render: (r) => (
        <button
          onClick={(e) => { e.stopPropagation(); openEditAcc(r.account); }}
          className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
          title="Edit account"
        >
          Edit
        </button>
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
      <div className="flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

        <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
          <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
        </div>

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
            <button
              onClick={openNewAcc}
              className="px-3 py-1.5 rounded text-xs font-semibold border transition-colors"
              style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR, backgroundColor: FINANCE_COLOR + "18" }}
            >
              + New Account
            </button>
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
            <p className="text-sm text-gray-400 mb-3">No accounts yet.</p>
            <button
              onClick={openNewAcc}
              className="px-4 py-1.5 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity"
            >
              + Create your first account
            </button>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
            <DataTable
              rows={ctl.paged}
              columns={columns}
              sortKey={ctl.sortKey}
              sortDir={ctl.sortDir}
              onSort={ctl.handleSort}
              onRowClick={(r) => {
                // Brokerage / retirement still go to the detail page — that's
                // where holdings, lots, and "Refresh prices" live. Everything
                // else goes straight to the filtered transactions list, which
                // is the place you'd actually do something with the account.
                const target = isInvestedAccount(r.account.type)
                  ? `/finance/accounts/${r.account.id}`
                  : `/finance/transactions?account=${r.account.id}`;
                router.push(target);
              }}
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

        {/* Account side panel — create or edit */}
        {panelMode && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-96 border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
              <h2 className="text-base font-semibold dark:text-rose text-purple">
                {panelMode === "new" ? "New Account" : "Edit Account"}
              </h2>
              <button onClick={() => setPanelMode(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
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
                  {isInvestedAccount(accDraft.type) ? "Cash Balance" : "Opening Balance"}
                </label>
                <input type="number" step="0.01" className={inputCls} placeholder="0.00"
                  value={accDraft.currentBalance ?? ""}
                  onChange={(e) => setAccDraft((d) => ({ ...d, currentBalance: parseFloat(e.target.value) || 0 }))} />
                <p className="text-[10px] text-gray-400 mt-0.5">
                  {isInvestedAccount(accDraft.type)
                    ? "Uninvested cash only. Add positions (lots) on the account page."
                    : "Starting balance for this account"}
                </p>
              </div>
              {(accDraft.type ?? "CHECKING") === "CREDIT" && (
                <>
                  <div>
                    <label className={labelCls}>Credit Limit</label>
                    <input type="number" step="0.01" min={0} className={inputCls} placeholder="5000.00"
                      value={accDraft.creditLimit ?? ""}
                      onChange={(e) => setAccDraft((d) => ({ ...d, creditLimit: parseFloat(e.target.value) || null as any }))} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>Statement Closing Day</label>
                      <input type="number" min={1} max={31} step={1} className={inputCls} placeholder="15"
                        value={accDraft.statementClosingDay ?? ""}
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          setAccDraft((d) => ({ ...d, statementClosingDay: Number.isFinite(n) ? Math.min(31, Math.max(1, n)) : null as any }));
                        }} />
                      <p className="text-[10px] text-gray-400 mt-0.5">Day of month (1–31)</p>
                    </div>
                    <div>
                      <label className={labelCls}>APR (%)</label>
                      <input type="number" step="0.01" min={0} className={inputCls} placeholder="24.99"
                        value={accDraft.apr != null ? (accDraft.apr * 100).toFixed(4).replace(/\.?0+$/, "") : ""}
                        onChange={(e) => {
                          const pct = parseFloat(e.target.value);
                          setAccDraft((d) => ({ ...d, apr: Number.isFinite(pct) ? pct / 100 : null as any }));
                        }} />
                    </div>
                  </div>
                </>
              )}
              {(accDraft.type ?? "CHECKING") === "SAVINGS" && (
                <div>
                  <label className={labelCls}>APY (%)</label>
                  <input type="number" step="0.001" min={0} className={inputCls} placeholder="4.00"
                    value={accDraft.apy != null ? (accDraft.apy * 100).toFixed(4).replace(/\.?0+$/, "") : ""}
                    onChange={(e) => {
                      const pct = parseFloat(e.target.value);
                      setAccDraft((d) => ({ ...d, apy: Number.isFinite(pct) ? pct / 100 : null as any }));
                    }} />
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

              {panelMode === "new" && (
                <p className="text-[11px] text-gray-400 italic border-t border-gray-200 dark:border-darkBorder pt-4">
                  Goal mapping for brokerage / retirement accounts is on the account detail page.
                </p>
              )}

              <SaveButton
                saving={saving}
                onSave={handleSaveAcc}
                label={panelMode === "new" ? "Create Account" : "Save"}
              />
              {panelMode && typeof panelMode === "object" && panelMode.kind === "edit" && (
                <button
                  type="button"
                  onClick={handleDeleteAcc}
                  disabled={saving}
                  className="text-[11px] text-gray-400 hover:text-red-500 transition-colors disabled:opacity-30 self-start"
                >
                  Delete account
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </FinanceLayout>
  );
}
