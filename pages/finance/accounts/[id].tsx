import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/router";
import NextLink from "next/link";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  AccountRecord, TransactionRecord, HoldingLotRecord, TickerQuoteRecord,
  ASSET_TYPES, ASSET_TYPE_LABELS, FINANCE_COLOR,
  RETIREMENT_TYPE_LABELS, isInvestedAccount,
  fmtCurrency, fmtDate, amountColor,
  accountTotalValue, buildQuoteMap, tickerAggregate, uniqueTickers, isQuoteStale, isQuoteManual,
  inputCls, labelCls,
  SaveButton, DeleteButton, EmptyState, AccountBadge, StatusBadge,
} from "@/components/finance/_shared";

type PanelState =
  | { kind: "new-lot" }
  | { kind: "edit-lot"; lot: HoldingLotRecord }
  | null;

export default function AccountDetailPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();
  const accountId = typeof router.query.id === "string" ? router.query.id : "";

  const [account,      setAccount]      = useState<AccountRecord | null>(null);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [lots,         setLots]         = useState<HoldingLotRecord[]>([]);
  const [quotes,       setQuotes]       = useState<TickerQuoteRecord[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [saving,       setSaving]       = useState(false);
  const [refreshing,   setRefreshing]   = useState(false);
  const [refreshMsg,   setRefreshMsg]   = useState<string | null>(null);
  const [panel,        setPanel]        = useState<PanelState>(null);
  const [lotDraft,     setLotDraft]     = useState<Partial<HoldingLotRecord>>({});
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);

  // ── Data fetching ─────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const [{ data: acc }, { data: txs }, { data: lotRecs }, { data: quoteRecs }] =
        await Promise.all([
          client.models.financeAccount.get({ id: accountId }),
          client.models.financeTransaction.list({ limit: 1000 }),
          client.models.financeHoldingLot.list({ limit: 500 }),
          client.models.financeTickerQuote.list({ limit: 500 }),
        ]);
      setAccount(acc ?? null);
      setTransactions((txs ?? []).filter((t) => t.accountId === accountId));
      setLots((lotRecs ?? []).filter((l) => l.accountId === accountId));
      setQuotes(quoteRecs ?? []);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    if (!router.isReady) return;
    fetchAll();
  }, [authState, router.isReady, fetchAll]);

  // ── Derived data ──────────────────────────────────────────────────────────

  const quoteMap = useMemo(() => buildQuoteMap(quotes), [quotes]);

  const tickers = useMemo(() => uniqueTickers(lots), [lots]);

  const aggregates = useMemo(
    () => tickers.map((t) => tickerAggregate(t, lots, quoteMap)),
    [tickers, lots, quoteMap],
  );

  const totalValue = account ? accountTotalValue(account, lots, quoteMap) : 0;
  const holdingsValue = account && isInvestedAccount(account.type)
    ? aggregates.reduce((s, a) => s + (a.marketValue ?? 0), 0)
    : 0;

  const sortedTxs = useMemo(
    () => [...transactions].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")),
    [transactions],
  );

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
        const { data: newLot } = await client.models.financeHoldingLot.create({
          accountId,
          ticker,
          assetType:    (lotDraft.assetType ?? "STOCK") as any,
          quantity:     lotDraft.quantity!,
          costBasis:    lotDraft.costBasis ?? null,
          purchaseDate: lotDraft.purchaseDate ?? null,
          notes:        lotDraft.notes ?? null,
        });
        if (newLot) setLots((p) => [...p, newLot]);
      } else if (panel?.kind === "edit-lot") {
        await client.models.financeHoldingLot.update({
          id:           panel.lot.id,
          ticker,
          assetType:    (lotDraft.assetType ?? "STOCK") as any,
          quantity:     lotDraft.quantity!,
          costBasis:    lotDraft.costBasis ?? null,
          purchaseDate: lotDraft.purchaseDate ?? null,
          notes:        lotDraft.notes ?? null,
        });
        setLots((p) => p.map((l) => l.id === panel.lot.id ? { ...l, ...lotDraft, ticker } as HoldingLotRecord : l));
      }
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteLot(lot: HoldingLotRecord) {
    if (!confirm(`Delete this lot of ${lot.ticker}?`)) return;
    setSaving(true);
    try {
      await client.models.financeHoldingLot.delete({ id: lot.id });
      setLots((p) => p.filter((l) => l.id !== lot.id));
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  // ── Refresh prices (global: all tickers across all brokerage accounts) ────

  async function handleRefreshPrices() {
    console.log("[refresh] start");
    setRefreshMsg(null);
    setRefreshing(true);
    try {
      // Pull all tickers (not just this account's), so a single refresh updates every brokerage
      const { data: allLots, errors: lotErrors } = await client.models.financeHoldingLot.list({ limit: 500 });
      if (lotErrors?.length) {
        console.error("[refresh] error listing lots:", lotErrors);
        setRefreshMsg(`Error listing lots: ${lotErrors[0].message}`);
        return;
      }
      const allTickers = uniqueTickers(allLots ?? []);
      console.log(`[refresh] found ${allTickers.length} tickers:`, allTickers);
      if (allTickers.length === 0) {
        setRefreshMsg("No tickers to refresh");
        return;
      }

      console.log(`[refresh] calling /api/quotes with`, allTickers);
      const res = await fetch("/api/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: allTickers }),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error("[refresh] /api/quotes failed:", res.status, text);
        setRefreshMsg(`/api/quotes failed: ${res.status}`);
        return;
      }
      const body = await res.json();
      const quoteResults = body.quotes ?? {};
      console.log("[refresh] got quotes:", quoteResults);
      const now = new Date().toISOString();

      // Load existing quotes so we know which to create vs update, and which are manual overrides
      const { data: existingQuotes } = await client.models.financeTickerQuote.list({ limit: 500 });
      const existingMap = new Map(
        (existingQuotes ?? []).map((q) => [(q.ticker ?? "").toUpperCase(), q]),
      );
      console.log(`[refresh] ${existingMap.size} existing quotes in db`);

      let created = 0, updated = 0, skippedManual = 0, skippedNoPrice = 0, failed = 0;
      for (const ticker of allTickers) {
        const existing = existingMap.get(ticker);

        // Skip tickers the user has manually overridden — their value wins always
        if (isQuoteManual(existing)) {
          console.log(`[refresh] skipping ${ticker} (manual override)`);
          skippedManual++;
          continue;
        }

        const q = quoteResults[ticker];
        if (!q) {
          console.warn(`[refresh] no quote returned for ${ticker}`);
          failed++;
          continue;
        }
        if (q.price == null) {
          // Yahoo returned null price (e.g. trust fund not on Yahoo). Leave existing record alone.
          console.warn(`[refresh] null price for ${ticker}: ${q.error ?? "(no error)"} — preserving existing quote`);
          skippedNoPrice++;
          continue;
        }
        const payload = {
          ticker,
          price:     q.price,
          currency:  q.currency ?? "USD",
          fetchedAt: now,
          source:    "yahoo",
        };
        try {
          if (existing) {
            const { errors } = await client.models.financeTickerQuote.update(payload);
            if (errors?.length) throw new Error(errors[0].message);
            updated++;
          } else {
            const { errors } = await client.models.financeTickerQuote.create(payload);
            if (errors?.length) throw new Error(errors[0].message);
            created++;
          }
        } catch (err: any) {
          console.error(`[refresh] failed to upsert ${ticker}:`, err?.message ?? err);
          failed++;
        }
      }

      console.log(`[refresh] done: created=${created} updated=${updated} skippedManual=${skippedManual} skippedNoPrice=${skippedNoPrice} failed=${failed}`);

      // Refetch quotes to update the UI
      const { data: fresh } = await client.models.financeTickerQuote.list({ limit: 500 });
      setQuotes(fresh ?? []);

      const msgParts: string[] = [];
      if (created + updated > 0)  msgParts.push(`Updated ${created + updated}`);
      if (skippedManual > 0)      msgParts.push(`${skippedManual} manual`);
      if (skippedNoPrice > 0)     msgParts.push(`${skippedNoPrice} not on Yahoo`);
      if (failed > 0)             msgParts.push(`${failed} failed`);
      setRefreshMsg(msgParts.join(" · ") || "Nothing to update");
      if (failed === 0 && skippedNoPrice === 0) setTimeout(() => setRefreshMsg(null), 3000);
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
  const cur = account.currency ?? "USD";
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
              <NextLink href="/finance" className="hover:underline">Finance</NextLink>
              <span>›</span>
              <span>Accounts</span>
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-purple dark:text-rose">{account.name}</h1>
                <AccountBadge type={account.type} />
                {retirementLabel && (
                  <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                    {retirementLabel}
                  </span>
                )}
              </div>
              {isBrokerage && (
                <div className="flex items-center gap-3">
                  {refreshMsg && (
                    <span className="text-[11px] text-gray-500 dark:text-gray-400">{refreshMsg}</span>
                  )}
                  <button
                    onClick={handleRefreshPrices}
                    disabled={refreshing || tickers.length === 0}
                    className="px-3 py-1.5 rounded text-xs font-semibold border transition-colors disabled:opacity-50"
                    style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR, backgroundColor: FINANCE_COLOR + "18" }}
                  >
                    {refreshing ? "Refreshing…" : "Refresh prices"}
                  </button>
                </div>
              )}
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
          </div>

          {/* ── Holdings (brokerage only) ────────────────────────────── */}
          {isBrokerage && (
            <section className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium">
                  Holdings · {tickers.length} ticker{tickers.length === 1 ? "" : "s"}
                </h2>
                <button
                  onClick={openNewLot}
                  className="text-xs font-semibold px-3 py-1 rounded border transition-colors"
                  style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR }}
                >
                  + Add lot
                </button>
              </div>

              {aggregates.length === 0 ? (
                <EmptyState label="holdings" onAdd={openNewLot} />
              ) : (
                <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-darkElevated border-b border-gray-200 dark:border-darkBorder">
                      <tr>
                        <th className="px-4 py-2 text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium">Ticker</th>
                        <th className="px-4 py-2 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium">Qty</th>
                        <th className="px-4 py-2 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium hidden sm:table-cell">Price</th>
                        <th className="px-4 py-2 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium">Value</th>
                        <th className="px-4 py-2 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium hidden md:table-cell">Cost basis</th>
                        <th className="px-4 py-2 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium">Gain/Loss</th>
                        <th className="px-4 py-2 w-8" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {aggregates.map((agg) => {
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
                                          style={{ backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR }}
                                          title="Manually overridden price — refreshes skip this ticker"
                                        >
                                          Manual
                                        </span>
                                      )}
                                    </div>
                                    <p className="text-[10px] text-gray-400">
                                      {agg.assetType ? ASSET_TYPE_LABELS[agg.assetType] : ""}
                                      {agg.lots.length > 1 && ` · ${agg.lots.length} lots`}
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
                              return (
                                <tr
                                  key={lot.id}
                                  className="bg-gray-50/50 dark:bg-white/[0.02] hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer transition-colors"
                                  onClick={() => openEditLot(lot)}
                                >
                                  <td className="px-4 py-1.5 pl-12">
                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                      Lot · {lot.purchaseDate ? fmtDate(lot.purchaseDate) : "no date"}
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
                </div>
              )}
            </section>
          )}

          {/* ── Transactions ─────────────────────────────────────────── */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium">
                Transactions · {sortedTxs.length}
              </h2>
              <NextLink
                href={`/finance/transactions?account=${accountId}`}
                className="text-xs font-semibold"
                style={{ color: FINANCE_COLOR }}
              >
                View all →
              </NextLink>
            </div>

            {sortedTxs.length === 0 ? (
              <p className="text-sm text-gray-400 py-6 text-center">No transactions on this account yet.</p>
            ) : (
              <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-darkElevated border-b border-gray-200 dark:border-darkBorder">
                    <tr>
                      <th className="px-4 py-2 text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium">Date</th>
                      <th className="px-4 py-2 text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium">Description</th>
                      <th className="px-4 py-2 text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium hidden sm:table-cell">Category</th>
                      <th className="px-4 py-2 text-center text-[10px] uppercase tracking-widest text-gray-400 font-medium hidden md:table-cell">Status</th>
                      <th className="px-4 py-2 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {sortedTxs.slice(0, 50).map((tx) => (
                      <tr key={tx.id} className="hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
                        <td className="px-4 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap text-xs">{fmtDate(tx.date)}</td>
                        <td className="px-4 py-2 text-gray-800 dark:text-gray-200 max-w-[200px] truncate">{tx.description || "—"}</td>
                        <td className="px-4 py-2 text-gray-400 text-xs hidden sm:table-cell">{tx.category || "—"}</td>
                        <td className="px-4 py-2 text-center hidden md:table-cell"><StatusBadge status={tx.status} /></td>
                        <td className="px-4 py-2 text-right tabular-nums font-semibold whitespace-nowrap"
                          style={{ color: amountColor(tx.amount ?? 0) }}>
                          {fmtCurrency(tx.amount, cur, true)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {sortedTxs.length > 50 && (
                  <div className="px-4 py-2 text-center text-xs text-gray-400 bg-gray-50 dark:bg-darkElevated">
                    Showing 50 of {sortedTxs.length} —{" "}
                    <NextLink href={`/finance/transactions?account=${accountId}`} className="underline" style={{ color: FINANCE_COLOR }}>
                      view all
                    </NextLink>
                  </div>
                )}
              </div>
            )}
          </section>

        </div>

        {/* ── Lot panel ────────────────────────────────────────────── */}
        {panel && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-96 border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
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
              <div>
                <label className={labelCls}>Notes</label>
                <input type="text" className={inputCls} placeholder="optional"
                  value={lotDraft.notes ?? ""}
                  onChange={(e) => setLotDraft((d) => ({ ...d, notes: e.target.value }))} />
              </div>
              <SaveButton saving={saving} onSave={handleSaveLot}
                label={panel.kind === "new-lot" ? "Add Lot" : "Save"} />
              {panel.kind === "edit-lot" && (
                <DeleteButton saving={saving} onDelete={() => handleDeleteLot(panel.lot)} />
              )}
            </div>
          </div>
        )}
      </div>
    </FinanceLayout>
  );
}
