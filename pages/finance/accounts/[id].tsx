import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/router";
import NextLink from "next/link";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import FinanceLayout from "@/layouts/finance";
import { PageTitle, Badge } from "@/components/common/ui";
import {
  client,
  AccountRecord, TransactionRecord, HoldingLotRecord, HoldingRecord, TickerQuoteRecord,
  GoalRecord, GoalFundingSourceRecord, RecurringRecord, SpendGroupRecord,
  ACCOUNT_TYPES, ASSET_TYPES, ASSET_TYPE_LABELS, FINANCE_COLOR,
  ACCOUNT_TYPE_LABELS,
  RETIREMENT_TYPES, RETIREMENT_TYPE_LABELS, isInvestedAccount,
  fmtCurrency, fmtDate, amountColor,
  accountTotalValue, buildQuoteMap, tickerAggregate, isLotVested, isQuoteStale, isQuoteManual,
  inputCls, labelCls,
  SaveButton, DeleteButton, EmptyState, AccountBadge, StatusBadge,
  listAll, refreshAllQuotes,
} from "@/components/finance/_shared";
import { NEGATIVE, WARNING, withAlpha } from "@/lib/colors";
import {
  ColDef, DataTable, SearchInput, TableControls, useTableControls, SortIcon,
} from "@/components/common/table";
import { AttachmentsSection, deleteAttachmentsFor } from "@/components/common/AttachmentsSection";
import { mutate, reportError } from "@/components/common/mutate";
import { TransactionPanel } from "@/components/finance/TransactionPanel";
import { ImportPanel } from "@/components/finance/ImportPanel";
import type { TxType } from "@/components/finance/_shared";
import { isTradeType, realizedGain } from "@/components/finance/_shared";

/** Compact relative time — "just now" / "5m ago" / "3h ago" / "2d ago" /
 *  falls back to YYYY-MM-DD for anything older than a week. */
function fmtTimeAgo(iso?: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "never";
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return iso.slice(0, 10);
}

/** Format lastSimplefinSyncDetails (JSON string) as a tooltip line summarizing
 *  the last run: window + tx counts + whether balance was written. */
function parseSyncDetailsHint(raw?: string | null): string {
  if (!raw) return "No sync details recorded.";
  try {
    const d = JSON.parse(raw);
    const bits = [];
    if (d.fromIso && d.toIso) bits.push(`window ${d.fromIso} → ${d.toIso}`);
    if (d.txTotal != null) bits.push(`${d.txTotal} tx from SF (${d.txNew ?? 0} new, ${d.duplicates ?? 0} dup)`);
    if (d.balanceUpdated) bits.push("balance updated");
    else if (d.balanceSkipped) bits.push("balance skipped (investment)");
    return bits.join(" · ") || "Last sync details empty.";
  } catch {
    return "Last sync details unparseable.";
  }
}

type PanelState =
  | { kind: "new-lot" }
  | { kind: "edit-lot";    lot: HoldingLotRecord }
  | { kind: "edit-acc" }
  | { kind: "new-tx";      defaultType?: TxType }
  | { kind: "edit-tx";     tx: TransactionRecord }
  | { kind: "import" }
  | null;

export default function AccountDetailPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();
  const accountId = typeof router.query.id === "string" ? router.query.id : "";

  const [account,      setAccount]      = useState<AccountRecord | null>(null);
  // The shared TransactionPanel mutates `accounts` (currentBalance updates)
  // via setAccounts. On this page we mirror that into setAccount so the
  // header balance updates instantly after a save.
  const [accounts,     setAccounts]     = useState<AccountRecord[]>([]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [lots,         setLots]         = useState<HoldingLotRecord[]>([]);
  const [holdings,     setHoldings]     = useState<HoldingRecord[]>([]);
  const [quotes,       setQuotes]       = useState<TickerQuoteRecord[]>([]);
  const [goals,        setGoals]        = useState<GoalRecord[]>([]);
  const [mappings,     setMappings]     = useState<GoalFundingSourceRecord[]>([]);
  const [recurrings,   setRecurrings]   = useState<RecurringRecord[]>([]);
  const [spendGroups,  setSpendGroups]  = useState<SpendGroupRecord[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [saving,       setSaving]       = useState(false);
  const [refreshing,   setRefreshing]   = useState(false);
  const [refreshMsg,   setRefreshMsg]   = useState<string | null>(null);
  const [panel,        setPanel]        = useState<PanelState>(null);
  const [lotDraft,     setLotDraft]     = useState<Partial<HoldingLotRecord>>({});
  const [accDraft,     setAccDraft]     = useState<Partial<AccountRecord>>({});
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);

  // Per-mapping busy flag so a slow network doesn't freeze the whole funding list
  const [mappingBusyId, setMappingBusyId] = useState<string | null>(null);

  // ── Data fetching ─────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      // Explicit type args: without them TS infers T from the (very deep)
      // Amplify model types and the 8-way Promise.all tuple trips TS2589
      // ("Type instantiation is excessively deep"). Same fix as
      // /finance/transactions — keeps the tuple shallow, typing intact.
      const [accRecs, txs, lotRecs, holdingRecs, quoteRecs, goalRecs, mappingRecs, recRecs, groupRecs] = await Promise.all([
        listAll<AccountRecord>(client.models.financeAccount),
        listAll<TransactionRecord>(client.models.financeTransaction),
        listAll<HoldingLotRecord>(client.models.financeHoldingLot),
        listAll<HoldingRecord>(client.models.financeHolding),
        listAll<TickerQuoteRecord>(client.models.financeTickerQuote),
        listAll<GoalRecord>(client.models.financeSavingsGoal),
        listAll<GoalFundingSourceRecord>(client.models.financeGoalFundingSource),
        listAll<RecurringRecord>(client.models.financeRecurring),
        listAll<SpendGroupRecord>(client.models.financeSpendGroup as any),
      ]);
      setAccounts(accRecs);
      // The shared panel can save TRANSFERs that change accountId or move
      // transactions across accounts, so keep the full lots/transactions
      // arrays in state (not just the ones for this account). Filtering
      // happens in the renderer.
      setAccount(accRecs.find((a) => a.id === accountId) ?? null);
      setTransactions(txs);
      setLots(lotRecs);
      setHoldings(holdingRecs);
      setQuotes(quoteRecs);
      setGoals(goalRecs);
      setMappings(mappingRecs);
      setRecurrings(recRecs);
      setSpendGroups(groupRecs as SpendGroupRecord[]);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  // Keep `account` in sync when the shared panel updates `accounts` (e.g.
  // adjusting the cash balance after a tx save).
  useEffect(() => {
    if (!accountId) return;
    const match = accounts.find((a) => a.id === accountId);
    if (match) setAccount(match);
  }, [accounts, accountId]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    if (!router.isReady) return;
    fetchAll();
  }, [authState, router.isReady, fetchAll]);

  // ── Derived data ──────────────────────────────────────────────────────────

  const quoteMap = useMemo(() => buildQuoteMap(quotes), [quotes]);

  // Filtered views — TransactionPanel/ImportPanel mutate the full arrays;
  // the on-page holdings + tx list only render this account's slice.
  const accountLots = useMemo(
    () => lots.filter((l) => l.accountId === accountId),
    [lots, accountId],
  );
  const accountHoldings = useMemo(
    () => holdings.filter((h) => h.accountId === accountId),
    [holdings, accountId],
  );
  const accountTransactions = useMemo(
    () => transactions.filter((t) => t.accountId === accountId),
    [transactions, accountId],
  );

  // Trade rows with a cash sibling — used by the Amount column to blank
  // the row so the dollar value doesn't appear to repeat across two
  // visible lines. See pages/finance/transactions.tsx for the same logic.
  const tradeRowsWithSibling = useMemo(() => {
    const s = new Set<string>();
    for (const t of accountTransactions) {
      const n = t.notes ?? "";
      if (n.startsWith("tradeTxId:")) s.add(n.slice("tradeTxId:".length));
    }
    return s;
  }, [accountTransactions]);

  // Rows are driven by current holdings (source of truth for vested positions)
  // plus any UNVESTED lots (RSUs, which have no holding row). A *vested* lot with
  // no holding is stale — e.g. a position sold via SimpleFIN whose old lot lingers
  // — and is intentionally not shown as a position, so a sold-out holding can't be
  // resurrected from a leftover lot. Each holding still carries its own lots below
  // as expandable tax detail.
  const tickers = useMemo(() => {
    const s = new Set<string>();
    for (const h of accountHoldings) if (h.ticker) s.add(h.ticker.toUpperCase());
    for (const l of accountLots) {
      if (!isLotVested(l) && l.ticker) s.add(l.ticker.toUpperCase());
    }
    return Array.from(s).sort();
  }, [accountHoldings, accountLots]);

  const holdingByTicker = useMemo(() => {
    const m = new Map<string, HoldingRecord>();
    for (const h of accountHoldings) {
      if (h.ticker) m.set(h.ticker.toUpperCase(), h);
    }
    return m;
  }, [accountHoldings]);

  const aggregates = useMemo(
    () => tickers.map((t) => tickerAggregate(t, holdingByTicker.get(t) ?? null, accountLots, quoteMap)),
    [tickers, holdingByTicker, accountLots, quoteMap],
  );

  const totalValue = account ? accountTotalValue(account, holdings, quoteMap) : 0;
  const holdingsValue = account && isInvestedAccount(account.type)
    ? aggregates.reduce((s, a) => s + (a.marketValue ?? 0), 0)
    : 0;

  // Currency code, safe to reference before account loads (used by column defs below).
  const cur = account?.currency ?? "USD";

  // Holdings table controls (search + sort). Kept next to aggregates because
  // the table still renders manually below (to support expandable sub-rows per ticker).
  const holdingsCtl = useTableControls(aggregates, {
    defaultSortKey: "value",
    defaultSortDir: "desc",
    getSortValue: (agg, key) => {
      switch (key) {
        case "ticker":     return agg.ticker;
        case "qty":        return agg.totalQty;
        case "price":      return agg.price ?? null;
        case "value":      return agg.marketValue ?? null;
        case "costBasis":  return agg.totalCost ?? null;
        case "gainLoss":   return agg.gainLoss ?? null;
        default:           return null;
      }
    },
    getSearchText: (agg) => `${agg.ticker} ${agg.assetType ?? ""} ${agg.lots.map((l) => l.notes ?? "").join(" ")}`,
    initialPageSize: 100,
  });

  // Transactions table controls (search + sort). Default: date desc.
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
      searchValue: (t) => `${t.description ?? ""} ${t.category ?? ""} ${t.notes ?? ""}`,
      render: (t) => {
        const trade = isTradeType(t.type as any);
        const gain  = realizedGain(t);
        const tradeBits: string[] = [];
        if (trade && t.quantity != null) tradeBits.push(`${t.quantity} sh`);
        if (trade && t.ticker)           tradeBits.push(t.ticker);
        if (trade && (t as any).price != null) tradeBits.push(`@ ${fmtCurrency((t as any).price, cur)}`);
        if (trade && (t as any).fees != null && (t as any).fees > 0) {
          tradeBits.push(`fees ${fmtCurrency((t as any).fees, cur)}`);
        }
        return (
          <div className="flex flex-col gap-0.5">
            <span className="text-gray-800 dark:text-gray-200 max-w-[240px] truncate inline-flex items-center gap-1.5">
              {trade && (
                <Badge color={t.type === "BUY" ? FINANCE_COLOR : WARNING} size="xs">
                  {t.type}
                </Badge>
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
                Realized {fmtCurrency(gain, cur, true)}
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
        // Trade row with a cash sibling → blank so the dollar value doesn't
        // visually double-up across the trade + sibling rows.
        if (isTradeType(t.type as any) && tradeRowsWithSibling.has(t.id)) {
          return <span className="text-gray-400 text-xs">—</span>;
        }
        return (
          <span className="tabular-nums font-semibold whitespace-nowrap" style={{ color: amountColor(t.amount ?? 0) }}>
            {fmtCurrency(t.amount, cur, true)}
          </span>
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [cur, tradeRowsWithSibling]);

  const txCtl = useTableControls(accountTransactions, {
    defaultSortKey: "date",
    defaultSortDir: "desc",
    getSortValue: (row, key) => txColumns.find((c) => c.key === key)?.sortValue?.(row),
    getSearchText: (row) => txColumns.map((c) => c.searchValue?.(row) ?? "").filter(Boolean).join(" "),
    initialPageSize: 50,
  });

  // ── Lot CRUD ──────────────────────────────────────────────────────────────

  function openNewLot() {
    setLotDraft({ assetType: "STOCK" as any });
    setPanel({ kind: "new-lot" });
  }

  function openEditLot(lot: HoldingLotRecord) {
    setLotDraft({ ...lot });
    setPanel({ kind: "edit-lot", lot });
  }

  async function handleSaveLot() {
    if (!accountId) return;
    if (!lotDraft.ticker?.trim() || lotDraft.quantity == null) return;
    const ticker = lotDraft.ticker.trim().toUpperCase();
    setSaving(true);
    try {
      if (panel?.kind === "new-lot") {
        const newLot = await mutate(client.models.financeHoldingLot.create({
          accountId,
          ticker,
          assetType:    (lotDraft.assetType ?? "STOCK") as any,
          quantity:     lotDraft.quantity!,
          costBasis:    lotDraft.costBasis ?? null,
          purchaseDate: lotDraft.purchaseDate ?? null,
          notes:        lotDraft.notes ?? null,
          isVested:     lotDraft.isVested ?? true,
          vestDate:     lotDraft.vestDate ?? null,
        }));
        if (newLot) setLots((p) => [...p, newLot]);
      } else if (panel?.kind === "edit-lot") {
        await mutate(client.models.financeHoldingLot.update({
          id:           panel.lot.id,
          ticker,
          assetType:    (lotDraft.assetType ?? "STOCK") as any,
          quantity:     lotDraft.quantity!,
          costBasis:    lotDraft.costBasis ?? null,
          purchaseDate: lotDraft.purchaseDate ?? null,
          notes:        lotDraft.notes ?? null,
          isVested:     lotDraft.isVested ?? true,
          vestDate:     lotDraft.vestDate ?? null,
        }));
        setLots((p) => p.map((l) => l.id === panel.lot.id ? { ...l, ...lotDraft, ticker } as HoldingLotRecord : l));
      }
      setPanel(null);
    } catch (e) {
      reportError(e, "Save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteLot(lot: HoldingLotRecord) {
    if (!confirm(`Delete this lot of ${lot.ticker}?`)) return;
    setSaving(true);
    try {
      await mutate(client.models.financeHoldingLot.delete({ id: lot.id }));
      setLots((p) => p.filter((l) => l.id !== lot.id));
      setPanel(null);
    } catch (e) {
      reportError(e, "Delete");
    } finally {
      setSaving(false);
    }
  }

  // ── Account CRUD ─────────────────────────────────────────

  function openEditAcc() {
    if (!account) return;
    setAccDraft({ ...account });
    setPanel({ kind: "edit-acc" });
  }

  async function handleSaveAcc() {
    if (!account) return;
    if (!accDraft.name?.trim()) return;
    setSaving(true);
    try {
      const isCredit  = accDraft.type === "CREDIT";
      const isSavings = accDraft.type === "SAVINGS";
      const nextBalance = accDraft.currentBalance ?? 0;
      // Stamp balanceUpdatedAt only when the balance actually changes so
      // routine metadata edits (e.g. renaming the account) don't reset it.
      const balanceChanged = Math.abs(nextBalance - (account.currentBalance ?? 0)) > 0.005;
      const nowIso = new Date().toISOString();
      const payload = {
        id:                  account.id,
        name:                accDraft.name!,
        type:                (accDraft.type ?? "CHECKING") as any,
        retirementType:      (accDraft.type === "RETIREMENT" ? accDraft.retirementType ?? null : null) as any,
        currentBalance:      nextBalance,
        currency:            accDraft.currency ?? "USD",
        notes:               accDraft.notes ?? null,
        active:              accDraft.active ?? true,
        favorite:            accDraft.favorite ?? false,
        creditLimit:         accDraft.creditLimit ?? null,
        statementClosingDay: isCredit  ? accDraft.statementClosingDay ?? null : null,
        statementDueDay:     isCredit  ? accDraft.statementDueDay ?? null : null,
        apr:                 isCredit  ? accDraft.apr                 ?? null : null,
        apy:                 isSavings ? accDraft.apy                 ?? null : null,
        simplefinAccountId:  accDraft.simplefinAccountId ?? null,
        ...(balanceChanged ? { balanceUpdatedAt: nowIso } : {}),
      };
      await mutate(client.models.financeAccount.update(payload));
      setAccount((a) => a ? {
        ...a,
        ...accDraft,
        ...(balanceChanged ? { balanceUpdatedAt: nowIso } : {}),
      } as AccountRecord : a);
      setPanel(null);
    } catch (e) {
      reportError(e, "Save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteAcc() {
    if (!account) return;
    if (!confirm(`Delete account "${account.name}"? This does not delete its transactions.`)) return;
    setSaving(true);
    try {
      await deleteAttachmentsFor("ACCOUNT", account.id);
      await mutate(client.models.financeAccount.delete({ id: account.id }));
      // Leaving the detail page; send user back to accounts index
      router.push("/finance/accounts");
    } catch (e) {
      reportError(e, "Delete");
    } finally {
      setSaving(false);
    }
  }

  // ── Funding-source mapping CRUD ───────────────────────────────
  // Same pattern as the old implementation on /finance/transactions: write immediately
  // on each user action rather than batching with the account Save button.

  async function handleAddMapping(goalId: string) {
    if (!account) return;
    setMappingBusyId(goalId);
    try {
      const existing = mappings.filter((m) => m.accountId === account.id);
      const maxPriority = existing.reduce((max, m) => Math.max(max, m.priority ?? 100), 0);
      const newPriority = existing.length === 0 ? 100 : maxPriority + 10;
      const created = await mutate(client.models.financeGoalFundingSource.create({
        accountId: account.id, goalId, priority: newPriority,
      }));
      if (created) setMappings((p) => [...p, created]);
    } catch (err: any) {
      reportError(err, "Add funding source");
    } finally {
      setMappingBusyId(null);
    }
  }

  async function handleRemoveMapping(mappingId: string) {
    setMappingBusyId(mappingId);
    try {
      await mutate(client.models.financeGoalFundingSource.delete({ id: mappingId }));
      setMappings((p) => p.filter((m) => m.id !== mappingId));
    } catch (err: any) {
      reportError(err, "Remove funding source");
    } finally {
      setMappingBusyId(null);
    }
  }

  async function handleReorderMapping(mappingId: string, direction: "up" | "down") {
    if (!account) return;
    const accMappings = mappings
      .filter((m) => m.accountId === account.id)
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    const idx = accMappings.findIndex((m) => m.id === mappingId);
    if (idx < 0) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= accMappings.length) return;

    const a = accMappings[idx];
    const b = accMappings[swapIdx];
    const priorityA = a.priority ?? 100;
    const priorityB = b.priority ?? 100;

    setMappingBusyId(mappingId);
    try {
      setMappings((p) => p.map((m) => {
        if (m.id === a.id) return { ...m, priority: priorityB } as GoalFundingSourceRecord;
        if (m.id === b.id) return { ...m, priority: priorityA } as GoalFundingSourceRecord;
        return m;
      }));
      await Promise.all([
        mutate(client.models.financeGoalFundingSource.update({ id: a.id, priority: priorityB })),
        mutate(client.models.financeGoalFundingSource.update({ id: b.id, priority: priorityA })),
      ]);
    } catch (err: any) {
      reportError(err, "Reorder funding source");
      const fresh = await listAll(client.models.financeGoalFundingSource);
      setMappings(fresh);
    } finally {
      setMappingBusyId(null);
    }
  }

  // ── Refresh prices (delegates to shared helper) ───────────────────

  async function handleRefreshPrices() {
    setRefreshMsg(null);
    setRefreshing(true);
    try {
      const result = await refreshAllQuotes();
      if (result.fatal) {
        setRefreshMsg(`Error: ${result.fatal}`);
        return;
      }
      // Refetch quotes to update the UI
      const fresh = await listAll(client.models.financeTickerQuote);
      setQuotes(fresh);
      setRefreshMsg(result.message);
      // Auto-dismiss success messages (nothing surprising happened)
      if (result.failed === 0 && result.skippedNoPrice === 0) {
        setTimeout(() => setRefreshMsg(null), 3000);
      }
    } catch (err: any) {
      console.error("[refresh] unhandled error:", err);
      setRefreshMsg(`Error: ${err?.message ?? String(err)}`);
    } finally {
      setRefreshing(false);
    }
  }

  if (authState !== "authenticated") return null;

  if (!router.isReady || loading) {
    return (
      <FinanceLayout>
        <div className="px-4 py-5 md:px-8 md:py-6">
          <p className="text-sm text-gray-400 animate-pulse">Loading…</p>
        </div>
      </FinanceLayout>
    );
  }

  if (!account) {
    return (
      <FinanceLayout>
        <div className="px-4 py-5 md:px-8 md:py-6">
          <p className="text-sm text-gray-400">
            Account not found.{" "}
            <NextLink href="/finance" className="underline" style={{ color: FINANCE_COLOR }}>
              Back to dashboard
            </NextLink>
          </p>
        </div>
      </FinanceLayout>
    );
  }

  const isBrokerage = isInvestedAccount(account.type);
  const anyStale = aggregates.some((a) => isQuoteStale({ fetchedAt: a.fetchedAt } as any));
  const retirementLabel = account.type === "RETIREMENT" && account.retirementType
    ? RETIREMENT_TYPE_LABELS[account.retirementType as keyof typeof RETIREMENT_TYPE_LABELS]
    : null;

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

          {/* ── Header ───────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2 mb-5">
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
              <span>›</span>
              <NextLink href="/finance/accounts" className="hover:underline" style={{ color: FINANCE_COLOR }}>Accounts</NextLink>
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-3">
                <PageTitle>{account.name}</PageTitle>
                <AccountBadge type={account.type} />
                {retirementLabel && (
                  <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                    {retirementLabel}
                  </span>
                )}
                {account.favorite && (
                  <span className="text-base" style={{ color: WARNING }} title="Pinned to dashboard">★</span>
                )}
                {account.active === false && (
                  <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-gray-200 dark:bg-gray-600 text-gray-500">
                    Inactive
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={openEditAcc}
                  className="px-3 py-1.5 rounded text-xs font-semibold border transition-colors"
                  style={{ borderColor: withAlpha(FINANCE_COLOR, 0x88), color: FINANCE_COLOR, backgroundColor: withAlpha(FINANCE_COLOR, 0x18) }}
                >
                  Edit account
                </button>
                {isBrokerage && (
                  <>
                    {refreshMsg && (
                      <span className="text-[11px] text-gray-500 dark:text-gray-400">{refreshMsg}</span>
                    )}
                    <button
                      onClick={handleRefreshPrices}
                      disabled={refreshing || tickers.length === 0}
                      className="px-3 py-1.5 rounded text-xs font-semibold border transition-colors disabled:opacity-50"
                      style={{ borderColor: withAlpha(FINANCE_COLOR, 0x88), color: FINANCE_COLOR, backgroundColor: withAlpha(FINANCE_COLOR, 0x18) }}
                    >
                      {refreshing ? "Refreshing…" : "Refresh prices"}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Balance breakdown */}
            <div className="flex items-baseline gap-6 flex-wrap mt-1">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">
                  {isBrokerage ? "Total value" : "Balance"}
                </p>
                <p className="text-2xl font-bold tabular-nums" style={{ color: amountColor(totalValue) }}>
                  {fmtCurrency(totalValue, cur)}
                </p>
              </div>
              {isBrokerage && (
                <>
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Cash</p>
                    <p className="text-base font-semibold tabular-nums text-gray-700 dark:text-gray-200">
                      {fmtCurrency(account.currentBalance, cur)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Positions</p>
                    <p className="text-base font-semibold tabular-nums text-gray-700 dark:text-gray-200">
                      {fmtCurrency(holdingsValue, cur)}
                    </p>
                  </div>
                  {anyStale && tickers.length > 0 && (
                    <p className="text-[11px] text-amber-500">Prices may be stale — refresh to update</p>
                  )}
                </>
              )}
            </div>
            {/* Freshness caption: when the balance we're staring at was last
                written, and when we last hit SimpleFIN for this account. */}
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-400">
              <span>Balance updated {fmtTimeAgo(account.balanceUpdatedAt)}</span>
              {account.simplefinAccountId && (
                <span title={parseSyncDetailsHint(account.lastSimplefinSyncDetails)}>
                  SF sync {fmtTimeAgo(account.lastSimplefinSyncAt)}
                </span>
              )}
            </div>
          </div>

          {/* ── Holdings (brokerage only) ────────────────────────────── */}
          {isBrokerage && (
            <section className="mb-6">
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium">
                  Holdings · {tickers.length} ticker{tickers.length === 1 ? "" : "s"}
                </h2>
                <div className="flex items-center gap-2">
                  {aggregates.length > 0 && (
                    <SearchInput value={holdingsCtl.search} onChange={holdingsCtl.setSearch} placeholder="Search ticker…" />
                  )}
                  <button
                    onClick={() => setPanel({ kind: "new-tx", defaultType: "BUY" })}
                    className="text-xs font-semibold px-3 py-1 rounded border transition-colors hover:opacity-80"
                    style={{ borderColor: withAlpha(FINANCE_COLOR, 0x88), color: FINANCE_COLOR }}
                    title="Record a purchase: creates a transaction + a new lot"
                  >
                    + Buy
                  </button>
                  <button
                    onClick={() => setPanel({ kind: "new-tx", defaultType: "SELL" })}
                    className="text-xs font-semibold px-3 py-1 rounded border transition-colors hover:opacity-80"
                    style={{ borderColor: withAlpha(WARNING, 0x88), color: WARNING }}
                    title="Record a sale: creates a transaction + consumes lots"
                  >
                    + Sell
                  </button>
                  <button
                    onClick={openNewLot}
                    className="text-xs font-semibold px-3 py-1 rounded border transition-colors"
                    style={{ borderColor: withAlpha(FINANCE_COLOR, 0x88), color: FINANCE_COLOR }}
                    title="Add a lot directly without creating a transaction (RSU vesting, manual fix-ups)"
                  >
                    + Add lot
                  </button>
                </div>
              </div>

              {aggregates.length === 0 ? (
                <EmptyState label="holdings" onAdd={openNewLot} />
              ) : (
                <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-darkElevated border-b border-gray-200 dark:border-darkBorder">
                      <tr>
                        {([
                          { key: "ticker",    label: "Ticker",     align: "left"  },
                          { key: "qty",       label: "Qty",        align: "right" },
                          { key: "price",     label: "Price",      align: "right", hide: "sm" },
                          { key: "value",     label: "Value",      align: "right" },
                          { key: "costBasis", label: "Cost basis", align: "right", hide: "md" },
                          { key: "gainLoss",  label: "Gain/Loss",  align: "right" },
                        ] as const).map((col) => {
                          const alignCls = col.align === "right" ? "text-right" : "text-left";
                          const hideCls  = (col as any).hide === "sm" ? "hidden sm:table-cell" : (col as any).hide === "md" ? "hidden md:table-cell" : "";
                          const dir = holdingsCtl.sortKey === col.key ? holdingsCtl.sortDir : null;
                          return (
                            <th
                              key={col.key}
                              onClick={() => holdingsCtl.handleSort(col.key)}
                              className={`px-4 py-2 ${alignCls} ${hideCls} text-[10px] uppercase tracking-widest text-gray-400 font-medium cursor-pointer select-none hover:text-gray-600 dark:hover:text-gray-300 transition-colors`}
                            >
                              {col.label}
                              <SortIcon dir={dir} />
                            </th>
                          );
                        })}
                        <th className="px-4 py-2 w-8" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {holdingsCtl.paged.map((agg) => {
                        const expanded = expandedTicker === agg.ticker;
                        const hasMultipleLots = agg.lots.length > 1;
                        const isManual = isQuoteManual(quoteMap.get(agg.ticker));
                        return (
                          <React.Fragment key={agg.ticker}>
                            <tr
                              className={hasMultipleLots ? "hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer transition-colors" : ""}
                              onClick={() => hasMultipleLots && setExpandedTicker(expanded ? null : agg.ticker)}
                            >
                              <td className="px-4 py-2">
                                <div className="flex items-center gap-2">
                                  {hasMultipleLots && (
                                    <span className="text-gray-400 text-xs w-3">{expanded ? "▼" : "▶"}</span>
                                  )}
                                  <div>
                                    <div className="flex items-center gap-2">
                                      <p className="font-semibold text-gray-800 dark:text-gray-100">{agg.ticker}</p>
                                      {isManual && (
                                        <span
                                          className="inline-block px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wide"
                                          style={{ backgroundColor: withAlpha(FINANCE_COLOR, 0x22), color: FINANCE_COLOR }}
                                          title="Manually overridden price — refreshes skip this ticker"
                                        >
                                          Manual
                                        </span>
                                      )}
                                    </div>
                                    <p className="text-[10px] text-gray-400">
                                      {agg.assetType ? ASSET_TYPE_LABELS[agg.assetType] : ""}
                                      {agg.lots.length > 1 && ` · ${agg.lots.length} lots`}
                                      {agg.unvestedLotsCount > 0 && (
                                        <span
                                          className="ml-1.5 inline-block px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wide bg-amber-400/15 text-amber-600 dark:text-amber-400"
                                          title={`${agg.unvestedQty.toLocaleString("en-US", { maximumFractionDigits: 4 })} shares unvested${agg.unvestedValue != null ? ` · ${fmtCurrency(agg.unvestedValue, cur)}` : ""}`}
                                        >
                                          +{agg.unvestedLotsCount} unvested
                                        </span>
                                      )}
                                    </p>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-2 text-right tabular-nums text-gray-700 dark:text-gray-200">
                                {agg.totalQty.toLocaleString("en-US", { maximumFractionDigits: 4 })}
                              </td>
                              <td className="px-4 py-2 text-right tabular-nums text-gray-500 dark:text-gray-400 hidden sm:table-cell">
                                {agg.price != null ? fmtCurrency(agg.price, cur) : "—"}
                              </td>
                              <td className="px-4 py-2 text-right tabular-nums font-semibold text-gray-800 dark:text-gray-100">
                                {agg.marketValue != null ? fmtCurrency(agg.marketValue, cur) : "—"}
                              </td>
                              <td className="px-4 py-2 text-right tabular-nums text-gray-500 dark:text-gray-400 hidden md:table-cell">
                                {agg.totalCost != null ? fmtCurrency(agg.totalCost, cur) : "—"}
                              </td>
                              <td className="px-4 py-2 text-right tabular-nums font-semibold whitespace-nowrap"
                                style={{ color: agg.gainLoss != null ? amountColor(agg.gainLoss) : undefined }}>
                                {agg.gainLoss != null ? (
                                  <>
                                    {fmtCurrency(agg.gainLoss, cur, true)}
                                    {agg.gainLossPct != null && (
                                      <span className="ml-1 text-xs">({(agg.gainLossPct * 100).toFixed(1)}%)</span>
                                    )}
                                  </>
                                ) : "—"}
                              </td>
                              <td className="px-4 py-2 text-right">
                                {!hasMultipleLots && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); openEditLot(agg.lots[0]); }}
                                    className="text-[10px] px-2 py-0.5 rounded border border-gray-200 dark:border-darkBorder text-gray-400 hover:text-gray-600 transition-colors"
                                  >
                                    Edit
                                  </button>
                                )}
                              </td>
                            </tr>
                            {expanded && hasMultipleLots && agg.lots.map((lot) => {
                              const lotValue = agg.price != null ? (lot.quantity ?? 0) * agg.price : null;
                              const lotGain  = lot.costBasis != null && lotValue != null ? lotValue - lot.costBasis : null;
                              const lotPct   = lotGain != null && lot.costBasis ? lotGain / lot.costBasis : null;
                              const lotUnvested = lot.isVested === false;
                              return (
                                <tr
                                  key={lot.id}
                                  className={`bg-gray-50/50 dark:bg-white/[0.02] hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer transition-colors ${lotUnvested ? "opacity-70" : ""}`}
                                  onClick={() => openEditLot(lot)}
                                >
                                  <td className="px-4 py-1.5 pl-12">
                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                      Lot · {lot.purchaseDate ? fmtDate(lot.purchaseDate) : "no date"}
                                      {lotUnvested && (
                                        <span className="ml-1.5 text-amber-600 dark:text-amber-400">
                                          · unvested{lot.vestDate ? ` · vests ${fmtDate(lot.vestDate)}` : ""}
                                        </span>
                                      )}
                                    </p>
                                  </td>
                                  <td className="px-4 py-1.5 text-right tabular-nums text-xs text-gray-500 dark:text-gray-400">
                                    {(lot.quantity ?? 0).toLocaleString("en-US", { maximumFractionDigits: 4 })}
                                  </td>
                                  <td className="px-4 py-1.5 hidden sm:table-cell" />
                                  <td className="px-4 py-1.5 text-right tabular-nums text-xs text-gray-500 dark:text-gray-400">
                                    {lotValue != null ? fmtCurrency(lotValue, cur) : "—"}
                                  </td>
                                  <td className="px-4 py-1.5 text-right tabular-nums text-xs text-gray-500 dark:text-gray-400 hidden md:table-cell">
                                    {lot.costBasis != null ? fmtCurrency(lot.costBasis, cur) : "—"}
                                  </td>
                                  <td className="px-4 py-1.5 text-right tabular-nums text-xs font-medium whitespace-nowrap"
                                    style={{ color: lotGain != null ? amountColor(lotGain) : undefined }}>
                                    {lotGain != null ? (
                                      <>
                                        {fmtCurrency(lotGain, cur, true)}
                                        {lotPct != null && <span className="ml-1">({(lotPct * 100).toFixed(1)}%)</span>}
                                      </>
                                    ) : "—"}
                                  </td>
                                  <td className="px-4 py-1.5" />
                                </tr>
                              );
                            })}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                  <TableControls
                    page={holdingsCtl.page}
                    totalPages={holdingsCtl.totalPages}
                    totalItems={holdingsCtl.totalItems}
                    totalUnfiltered={holdingsCtl.totalUnfiltered}
                    pageSize={holdingsCtl.pageSize}
                    setPage={holdingsCtl.setPage}
                    setPageSize={holdingsCtl.setPageSize}
                  />
                </div>
              )}
            </section>
          )}

          {/* ── Transactions ─────────────────────────────────────────── */}
          <section>
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium">
                Transactions · {accountTransactions.length}
              </h2>
              <div className="flex items-center gap-2 flex-wrap">
                {accountTransactions.length > 0 && (
                  <SearchInput value={txCtl.search} onChange={txCtl.setSearch} placeholder="Search description, category…" />
                )}
                <button
                  onClick={() => setPanel({ kind: "import" })}
                  className="px-2 py-1 rounded text-xs font-semibold border transition-colors"
                  style={{ borderColor: withAlpha(FINANCE_COLOR, 0x88), color: FINANCE_COLOR, backgroundColor: withAlpha(FINANCE_COLOR, 0x18) }}
                  title="Import a bank CSV into this account"
                >
                  Import CSV
                </button>
                <button
                  onClick={() => setPanel({ kind: "new-tx" })}
                  className="px-2 py-1 rounded text-xs font-semibold border transition-colors"
                  style={{ borderColor: withAlpha(FINANCE_COLOR, 0x88), color: FINANCE_COLOR, backgroundColor: withAlpha(FINANCE_COLOR, 0x18) }}
                >
                  + Transaction
                </button>
                <NextLink
                  href={`/finance/transactions?account=${accountId}`}
                  className="text-xs font-semibold"
                  style={{ color: FINANCE_COLOR }}
                >
                  View all →
                </NextLink>
              </div>
            </div>

            {accountTransactions.length === 0 ? (
              <p className="text-sm text-gray-400 py-6 text-center">No transactions on this account yet.</p>
            ) : (
              <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
                <DataTable
                  rows={txCtl.paged}
                  columns={txColumns}
                  sortKey={txCtl.sortKey}
                  sortDir={txCtl.sortDir}
                  onSort={txCtl.handleSort}
                  onRowClick={(tx) => setPanel({ kind: "edit-tx", tx })}
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
          </section>

        </div>

        {/* ── Side panels ────────────────────────────────────────────── */}
        {/* Transaction / import panels render their own chrome. */}
        {panel?.kind === "new-tx" && (
          <TransactionPanel
            // Key by the seed type: the panel's form state is built in useState
            // initializers, which only run on mount. Without this, switching
            // between the Buy / Sell / Add-transaction buttons while the panel
            // is open would leave it showing the previously seeded type.
            key={`new-${panel.defaultType ?? "EXPENSE"}`}
            mode="create"
            defaultType={panel.defaultType ?? "EXPENSE"}
            defaultAccountId={accountId}
            lockAccount
            accounts={accounts}
            lots={lots}
            recurrings={recurrings}
            transactions={transactions}
            spendGroups={spendGroups}
            onClose={() => setPanel(null)}
            onSetTransactions={setTransactions}
            onSetAccounts={setAccounts}
            onSetLots={setLots}
          />
        )}
        {panel?.kind === "edit-tx" && (
          <TransactionPanel
            // Same fix as /finance/transactions: key by tx id so clicking a
            // different row remounts the panel and re-seeds its form state
            // instead of keeping the first transaction's values.
            key={panel.tx.id}
            mode="edit"
            editingTx={panel.tx}
            accounts={accounts}
            lots={lots}
            recurrings={recurrings}
            transactions={transactions}
            spendGroups={spendGroups}
            onClose={() => setPanel(null)}
            onSetTransactions={setTransactions}
            onSetAccounts={setAccounts}
            onSetLots={setLots}
          />
        )}
        {panel?.kind === "import" && (
          <ImportPanel
            accounts={accounts}
            transactions={transactions}
            recurrings={recurrings}
            lots={lots}
            defaultAccountId={accountId}
            lockAccount
            onClose={() => setPanel(null)}
            onSetTransactions={setTransactions}
            onSetAccounts={setAccounts}
            onSetLots={setLots}
          />
        )}

        {/* Lot / account-edit panels (legacy inline) */}
        {(panel?.kind === "new-lot" || panel?.kind === "edit-lot" || panel?.kind === "edit-acc") && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-96 border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">

            {/* Lot panel */}
            {(panel.kind === "new-lot" || panel.kind === "edit-lot") && (
              <>
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
                  <h2 className="text-base font-semibold dark:text-rose text-purple">
                    {panel.kind === "new-lot" ? "New Lot" : `Edit ${panel.lot.ticker}`}
                  </h2>
                  <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
                </div>
                <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>Ticker *</label>
                      <input type="text" className={inputCls} placeholder="SWPPX"
                        value={lotDraft.ticker ?? ""}
                        onChange={(e) => setLotDraft((d) => ({ ...d, ticker: e.target.value.toUpperCase() }))} />
                    </div>
                    <div>
                      <label className={labelCls}>Asset Type</label>
                      <select className={inputCls}
                        value={lotDraft.assetType ?? "STOCK"}
                        onChange={(e) => setLotDraft((d) => ({ ...d, assetType: e.target.value as any }))}>
                        {ASSET_TYPES.map((t) => (
                          <option key={t} value={t}>{ASSET_TYPE_LABELS[t]}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>Quantity *</label>
                      <input type="number" step="0.0001" className={inputCls} placeholder="0"
                        value={lotDraft.quantity ?? ""}
                        onChange={(e) => setLotDraft((d) => ({ ...d, quantity: parseFloat(e.target.value) || 0 }))} />
                    </div>
                    <div>
                      <label className={labelCls}>Cost Basis</label>
                      <input type="number" step="0.01" className={inputCls} placeholder="optional"
                        value={lotDraft.costBasis ?? ""}
                        onChange={(e) => setLotDraft((d) => ({ ...d, costBasis: e.target.value === "" ? null : parseFloat(e.target.value) }))} />
                      <p className="text-[10px] text-gray-400 mt-0.5">Total $ paid for this lot</p>
                    </div>
                  </div>
                  <div>
                    <label className={labelCls}>Purchase Date</label>
                    <input type="date" className={inputCls}
                      value={lotDraft.purchaseDate ?? ""}
                      onChange={(e) => setLotDraft((d) => ({ ...d, purchaseDate: e.target.value || (null as any) }))} />
                    <p className="text-[10px] text-gray-400 mt-0.5">Optional — helps distinguish lots</p>
                  </div>
                  {/* Vesting — leave Vested checked for ordinary purchases. Uncheck
                      to record an unvested RSU tranche that's excluded from current
                      value but counts toward EOY net-worth projection if vestDate
                      ≤ year-end. Flip Vested back on at each vest date. */}
                  <div className="rounded border border-gray-200 dark:border-darkBorder p-3 flex flex-col gap-2 bg-gray-50/50 dark:bg-white/[0.02]">
                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 select-none">
                      <input
                        type="checkbox"
                        checked={lotDraft.isVested !== false}
                        onChange={(e) => setLotDraft((d) => ({ ...d, isVested: e.target.checked }))}
                        className="h-4 w-4"
                      />
                      <span>Vested</span>
                    </label>
                    <div>
                      <label className={labelCls}>Vest Date</label>
                      <input type="date" className={inputCls}
                        value={lotDraft.vestDate ?? ""}
                        onChange={(e) => setLotDraft((d) => ({ ...d, vestDate: e.target.value || (null as any) }))} />
                      <p className="text-[10px] text-gray-400 mt-0.5">
                        Used by EOY projection when not yet vested. Flip Vested on at the actual vest date.
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className={labelCls}>Notes</label>
                    <input type="text" className={inputCls} placeholder="optional"
                      value={lotDraft.notes ?? ""}
                      onChange={(e) => setLotDraft((d) => ({ ...d, notes: e.target.value }))} />
                  </div>
                  <SaveButton saving={saving} onSave={handleSaveLot}
                    disabled={!lotDraft.ticker?.trim() || lotDraft.quantity == null}
                    label={panel.kind === "new-lot" ? "Add Lot" : "Save"} />
                  {panel.kind === "edit-lot" && (
                    <DeleteButton saving={saving} onDelete={() => handleDeleteLot(panel.lot)} />
                  )}
                </div>
              </>
            )}

            {/* Account panel */}
            {panel.kind === "edit-acc" && account && (() => {
              const accMappings = mappings
                .filter((m) => m.accountId === account.id)
                .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
              const mappedGoalIds = new Set(accMappings.map((m) => m.goalId));
              const unmappedGoals = goals.filter((g) => !mappedGoalIds.has(g.id));
              const canFundGoals = (accDraft.type ?? "CHECKING") !== "CREDIT" && (accDraft.type ?? "CHECKING") !== "LOAN";

              return (
                <>
                  <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
                    <h2 className="text-base font-semibold dark:text-rose text-purple">Edit Account</h2>
                    <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
                  </div>
                  <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
                    <div>
                      <label className={labelCls}>Name *</label>
                      <input type="text" className={inputCls}
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
                          ? "Uninvested cash only. Positions are tracked as lots on this page."
                          : "Direct override — use sparingly"}
                      </p>
                    </div>
                    {(accDraft.type ?? "CHECKING") === "CREDIT" && (
                      <>
                        <div>
                          <label className={labelCls}>Credit Limit</label>
                          <input type="number" step="0.01" min={0} className={inputCls} placeholder="5000.00"
                            value={accDraft.creditLimit ?? ""}
                            onChange={(e) => setAccDraft((d) => ({ ...d, creditLimit: parseFloat(e.target.value) || null as any }))} />
                          {(accDraft.creditLimit ?? 0) > 0 && (accDraft.currentBalance ?? 0) < 0 && (() => {
                            const owed = -(accDraft.currentBalance ?? 0);
                            const util = Math.min(1, owed / (accDraft.creditLimit ?? 1));
                            const color = util > 0.7 ? NEGATIVE : util > 0.3 ? WARNING : FINANCE_COLOR;
                            return (
                              <p className="text-[10px] mt-1" style={{ color }}>
                                {Math.round(util * 100)}% utilization · {fmtCurrency((accDraft.creditLimit ?? 0) - owed)} available
                              </p>
                            );
                          })()}
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
                            <label className={labelCls}>Statement Due Day</label>
                            <input type="number" min={1} max={31} step={1} className={inputCls} placeholder="5"
                              value={accDraft.statementDueDay ?? ""}
                              onChange={(e) => {
                                const n = parseInt(e.target.value, 10);
                                setAccDraft((d) => ({ ...d, statementDueDay: Number.isFinite(n) ? Math.min(31, Math.max(1, n)) : null as any }));
                              }} />
                            <p className="text-[10px] text-gray-400 mt-0.5">Payment due day (1–31)</p>
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
                    <div>
                      <label className={labelCls}>SimpleFIN account id</label>
                      <input type="text" className={inputCls} placeholder="ACT-… (leave blank to skip auto-pull)"
                        value={accDraft.simplefinAccountId ?? ""}
                        onChange={(e) => setAccDraft((d) => ({ ...d, simplefinAccountId: e.target.value.trim() || null as any }))} />
                      <p className="text-[10px] text-gray-400 mt-1">
                        Set from <code>npm run sf:probe</code> output. Only accounts with a value here get pulled.
                      </p>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                      <input type="checkbox" checked={accDraft.active ?? true}
                        onChange={(e) => setAccDraft((d) => ({ ...d, active: e.target.checked }))} />
                      Active
                    </label>
                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                      <input type="checkbox" checked={accDraft.favorite ?? false}
                        onChange={(e) => setAccDraft((d) => ({ ...d, favorite: e.target.checked }))} />
                      <span className="mr-1" style={{ color: WARNING }}>★</span> Favorite
                      <span className="text-[10px] text-gray-400">(pin to dashboard)</span>
                    </label>

                    {/* Funds these goals. Mutations write immediately — separate from the account Save button. */}
                    {canFundGoals && (
                      <div className="border-t border-gray-200 dark:border-darkBorder pt-4">
                        <div className="flex items-baseline justify-between mb-2">
                          <label className={labelCls}>Funds these goals</label>
                          {accMappings.length > 0 && (
                            <span className="text-[10px] text-gray-400">Top = funded first</span>
                          )}
                        </div>

                        {accMappings.length === 0 ? (
                          <p className="text-[11px] text-gray-400 mb-2">
                            No goals funded by this account yet. Add one below.
                          </p>
                        ) : (
                          <div className="flex flex-col gap-1 mb-2">
                            {accMappings.map((m, idx) => {
                              const goal = goals.find((g) => g.id === m.goalId);
                              const busy = mappingBusyId === m.id;
                              return (
                                <div
                                  key={m.id}
                                  className="flex items-center gap-2 px-2 py-1.5 rounded border border-gray-200 dark:border-darkBorder bg-gray-50 dark:bg-darkElevated"
                                  style={busy ? { opacity: 0.5 } : undefined}
                                >
                                  <span className="text-xs tabular-nums text-gray-400 w-5">{idx + 1}.</span>
                                  <span className="flex-1 text-xs text-gray-700 dark:text-gray-200 truncate">
                                    {goal?.name ?? <span className="italic text-gray-400">deleted goal</span>}
                                    {goal && (
                                      <span className="ml-1 text-gray-400">
                                        • {fmtCurrency(goal.targetAmount)}
                                      </span>
                                    )}
                                  </span>
                                  <button
                                    onClick={() => handleReorderMapping(m.id, "up")}
                                    disabled={busy || idx === 0}
                                    title="Move up"
                                    className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-30 w-5"
                                  >▲</button>
                                  <button
                                    onClick={() => handleReorderMapping(m.id, "down")}
                                    disabled={busy || idx === accMappings.length - 1}
                                    title="Move down"
                                    className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-30 w-5"
                                  >▼</button>
                                  <button
                                    onClick={() => handleRemoveMapping(m.id)}
                                    disabled={busy}
                                    title="Remove"
                                    className="text-xs text-gray-400 hover:text-red-500 disabled:opacity-30 w-5"
                                  >×</button>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {unmappedGoals.length > 0 ? (
                          <select
                            className={inputCls}
                            value=""
                            disabled={mappingBusyId !== null}
                            onChange={(e) => {
                              if (e.target.value) handleAddMapping(e.target.value);
                              e.target.value = "";
                            }}
                          >
                            <option value="">+ Add a goal…</option>
                            {unmappedGoals.map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.name} — target {fmtCurrency(g.targetAmount)}
                              </option>
                            ))}
                          </select>
                        ) : goals.length > 0 ? (
                          <p className="text-[11px] text-gray-400 italic">All goals already mapped to this account.</p>
                        ) : (
                          <p className="text-[11px] text-gray-400 italic">
                            No goals exist yet. Create one on the Goals page first.
                          </p>
                        )}
                      </div>
                    )}

                    <div className="border-t border-gray-200 dark:border-darkBorder pt-4">
                      <AttachmentsSection
                        parentType="ACCOUNT"
                        parentId={account.id}
                      />
                    </div>
                    <SaveButton saving={saving} onSave={handleSaveAcc} disabled={!accDraft.name?.trim()} label="Save" />
                    <DeleteButton saving={saving} onDelete={handleDeleteAcc} />
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </div>
    </FinanceLayout>
  );
}
