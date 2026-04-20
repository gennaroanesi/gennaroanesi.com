import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import NextLink from "next/link";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  HoldingLotRecord, TickerQuoteRecord,
  FINANCE_COLOR,
  fmtCurrency, fmtDate,
  uniqueTickers, isQuoteStale, isQuoteManual,
  inputCls, labelCls,
  SaveButton,
  listAll, refreshAllQuotes,
} from "@/components/finance/_shared";
import {
  ColDef, DataTable, SearchInput, TableControls, useTableControls,
} from "@/components/common/table";

type EditState = { ticker: string; price: number | ""; currency: string } | null;

// Row type for the prices table: we denormalize ticker+quote+lot-count into one object
// so columns can have clean sortValue/searchValue functions that don't need closures.
type PriceRow = {
  id:        string;   // === ticker (uppercase); DataTable requires an id
  ticker:    string;
  quote:     TickerQuoteRecord | undefined;
  lotCount:  number;
  /** Sort rank for the default "smart" ordering. 0=manual, 1=stale, 2=fresh, 3=unpriced. */
  smartRank: number;
};

export default function PricesPage() {
  const { authState } = useRequireAuth();

  const [lots,       setLots]       = useState<HoldingLotRecord[]>([]);
  const [quotes,     setQuotes]     = useState<TickerQuoteRecord[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [edit,       setEdit]       = useState<EditState>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [lotRecs, quoteRecs] = await Promise.all([
        listAll(client.models.financeHoldingLot),
        listAll(client.models.financeTickerQuote),
      ]);
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

  // ── Derived ────────────────────────────────────────────────────────────────

  const quoteByTicker = useMemo(() => {
    const m = new Map<string, TickerQuoteRecord>();
    for (const q of quotes) m.set((q.ticker ?? "").toUpperCase(), q);
    return m;
  }, [quotes]);

  const lotCountByTicker = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lots) {
      const t = (l.ticker ?? "").toUpperCase();
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }, [lots]);

  // Union of tickers used in lots + orphan quotes
  const allTickers = useMemo(() => {
    const fromLots   = uniqueTickers(lots);
    const fromQuotes = quotes.map((q) => (q.ticker ?? "").toUpperCase()).filter(Boolean);
    return Array.from(new Set([...fromLots, ...fromQuotes])).sort();
  }, [lots, quotes]);

  // Build denormalized rows for the table
  const rows: PriceRow[] = useMemo(() => allTickers.map((ticker) => {
    const quote = quoteByTicker.get(ticker);
    const manual = isQuoteManual(quote);
    const stale  = quote ? isQuoteStale(quote) : true;
    const smartRank = !quote ? 3 : manual ? 0 : stale ? 1 : 2;
    return {
      id: ticker,
      ticker,
      quote,
      lotCount: lotCountByTicker.get(ticker) ?? 0,
      smartRank,
    };
  }), [allTickers, quoteByTicker, lotCountByTicker]);

  // ── Actions ────────────────────────────────────────────────────────────────

  function openEdit(ticker: string) {
    const q = quoteByTicker.get(ticker);
    setEdit({
      ticker,
      price:    q?.price ?? "",
      currency: q?.currency ?? "USD",
    });
  }

  async function saveOverride() {
    if (!edit) return;
    const price = Number(edit.price);
    if (!isFinite(price) || price <= 0) return;
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const payload = {
        ticker:    edit.ticker,
        price,
        currency:  edit.currency.toUpperCase() || "USD",
        fetchedAt: now,
        source:    "manual",
      };
      const existing = quoteByTicker.get(edit.ticker);
      if (existing) {
        await client.models.financeTickerQuote.update(payload);
      } else {
        await client.models.financeTickerQuote.create(payload);
      }
      setQuotes((prev) => {
        const without = prev.filter((q) => (q.ticker ?? "").toUpperCase() !== edit.ticker);
        return [...without, { ...payload } as TickerQuoteRecord];
      });
      setEdit(null);
    } finally {
      setSaving(false);
    }
  }

  async function clearOverride(ticker: string) {
    if (!confirm(`Stop managing ${ticker} manually? Next refresh will attempt Yahoo again.`)) return;
    const existing = quoteByTicker.get(ticker);
    if (!existing) return;
    setSaving(true);
    try {
      // Flip source back to yahoo. Price is left in place as a starting value; next refresh will overwrite.
      await client.models.financeTickerQuote.update({
        ticker,
        price:     existing.price ?? 0,
        currency:  existing.currency ?? "USD",
        fetchedAt: existing.fetchedAt ?? new Date().toISOString(),
        source:    "yahoo",
      });
      setQuotes((prev) =>
        prev.map((q) =>
          (q.ticker ?? "").toUpperCase() === ticker
            ? { ...q, source: "yahoo" } as TickerQuoteRecord
            : q,
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  // Bulk refresh every non-manual ticker. Delegates to the shared helper so this page
  // stays in sync with the account-detail "Refresh prices" button.
  async function handleRefreshAll() {
    setRefreshMsg(null);
    setRefreshing(true);
    try {
      const result = await refreshAllQuotes();
      if (result.fatal) {
        setRefreshMsg(`Error: ${result.fatal}`);
        return;
      }
      const fresh = await listAll(client.models.financeTickerQuote);
      setQuotes(fresh);
      setRefreshMsg(result.message);
      if (result.failed === 0 && result.skippedNoPrice === 0) {
        setTimeout(() => setRefreshMsg(null), 3000);
      }
    } catch (err: any) {
      console.error("[prices:refresh] unhandled error:", err);
      setRefreshMsg(`Error: ${err?.message ?? String(err)}`);
    } finally {
      setRefreshing(false);
    }
  }

  // ── Columns ────────────────────────────────────────────────────────────────

  const columns: ColDef<PriceRow>[] = useMemo(() => [
    {
      key: "ticker",
      label: "Ticker",
      sortValue: (r) => r.ticker,
      searchValue: (r) => r.ticker,
      render: (r) => <p className="font-semibold text-gray-800 dark:text-gray-100">{r.ticker}</p>,
    },
    {
      key: "price",
      label: "Price",
      sortValue: (r) => r.quote?.price ?? null,
      align: "right",
      render: (r) => {
        const cur = r.quote?.currency ?? "USD";
        return r.quote?.price != null
          ? <span className="tabular-nums font-semibold text-gray-800 dark:text-gray-100">{fmtCurrency(r.quote.price, cur)}</span>
          : <span className="text-gray-400">—</span>;
      },
    },
    {
      key: "source",
      label: "Source",
      // Sort by smart rank so clicking Source gives you "manual → yahoo → no-quote"
      sortValue: (r) => r.smartRank,
      searchValue: (r) => !r.quote ? "no quote" : isQuoteManual(r.quote) ? "manual" : "yahoo",
      align: "center",
      mobileHidden: true,
      render: (r) => {
        if (!r.quote) return <span className="text-[10px] text-gray-400">no quote</span>;
        if (isQuoteManual(r.quote)) return (
          <span
            className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide"
            style={{ backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR }}
          >Manual</span>
        );
        return (
          <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
            Yahoo
          </span>
        );
      },
    },
    {
      key: "fetchedAt",
      label: "Last update",
      sortValue: (r) => r.quote?.fetchedAt ?? null,
      mobileHidden: true,
      render: (r) => {
        if (!r.quote?.fetchedAt) return <span className="text-gray-400">—</span>;
        const manual = isQuoteManual(r.quote);
        const stale  = isQuoteStale(r.quote);
        return (
          <span className={stale && !manual ? "text-amber-500 text-xs" : "text-gray-500 dark:text-gray-400 text-xs"}>
            {fmtDate(r.quote.fetchedAt.slice(0, 10))}
            {stale && !manual && <span className="ml-1">· stale</span>}
          </span>
        );
      },
    },
    {
      key: "lots",
      label: "Lots",
      sortValue: (r) => r.lotCount,
      align: "right",
      mobileHidden: true,
      render: (r) => <span className="tabular-nums text-xs text-gray-500 dark:text-gray-400">{r.lotCount}</span>,
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (r) => {
        const manual = isQuoteManual(r.quote);
        return (
          <div className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => openEdit(r.ticker)}
              className="text-[11px] font-semibold px-2 py-0.5 rounded border transition-colors"
              style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR }}
            >
              {manual ? "Edit" : "Override"}
            </button>
            {manual && (
              <button
                onClick={() => clearOverride(r.ticker)}
                disabled={saving}
                className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
              >
                Clear
              </button>
            )}
          </div>
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [saving]);

  // Virtual "smart" sort column: not rendered but used as default ordering.
  // When the user hasn't clicked any header, we sort by smartRank then ticker.
  const ctl = useTableControls(rows, {
    defaultSortKey: "__smart",
    defaultSortDir: "asc",
    getSortValue: (row, key) => {
      if (key === "__smart") return row.smartRank * 1000 + row.ticker.charCodeAt(0); // tie-break alphabetically
      return columns.find((c) => c.key === key)?.sortValue?.(row);
    },
    getSearchText: (row) =>
      columns.map((c) => c.searchValue?.(row) ?? "").filter(Boolean).join(" "),
    initialPageSize: 100,
  });

  if (authState !== "authenticated") return null;

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

          <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
            <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
          </div>

          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <div className="flex items-baseline gap-3">
              <h1 className="text-2xl font-bold text-purple dark:text-rose">Prices</h1>
              {allTickers.length > 0 && (
                <span className="text-sm text-gray-400 tabular-nums">
                  {allTickers.length} ticker{allTickers.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {refreshMsg && (
                <span className="text-[11px] text-gray-500 dark:text-gray-400">{refreshMsg}</span>
              )}
              <button
                onClick={handleRefreshAll}
                disabled={refreshing || allTickers.length === 0}
                className="px-3 py-1.5 rounded text-xs font-semibold border transition-colors disabled:opacity-50"
                style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR, backgroundColor: FINANCE_COLOR + "18" }}
              >
                {refreshing ? "Refreshing…" : "Refresh all"}
              </button>
              <SearchInput value={ctl.search} onChange={ctl.setSearch} placeholder="Search ticker, source…" />
            </div>
          </div>

          <p className="text-xs text-gray-400 mb-5 max-w-3xl">
            Live quotes fetched from Yahoo Finance via the Refresh Prices button on brokerage/retirement accounts.
            Override any ticker here to manage its price yourself — useful for 401(k) trust funds or other instruments
            Yahoo doesn't track. Manual overrides are never touched by refresh.
          </p>

          {loading ? (
            <p className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</p>
          ) : allTickers.length === 0 ? (
            <div className="rounded-xl border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface p-8 text-center">
              <p className="text-sm text-gray-400">
                No tickers yet. Add a lot on a brokerage or retirement account to see it here.
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
                emptyMessage={ctl.search ? "No matches" : "No tickers"}
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

        {/* ── Edit panel ───────────────────────────────────────────────── */}
        {edit && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-96 border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
              <h2 className="text-base font-semibold dark:text-rose text-purple">
                Override {edit.ticker}
              </h2>
              <button onClick={() => setEdit(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <p className="text-[11px] text-gray-400">
                Setting a manual price means refreshes will skip this ticker. Useful for 401(k) trusts or anything
                Yahoo doesn't know about. Click "Clear" on the table later to resume Yahoo tracking.
              </p>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Price *</label>
                  <input
                    type="number"
                    step="0.0001"
                    min={0}
                    className={inputCls}
                    placeholder="0.00"
                    value={edit.price}
                    onChange={(e) => setEdit((s) => s && ({
                      ...s,
                      price: e.target.value === "" ? "" : parseFloat(e.target.value),
                    }))}
                    autoFocus
                  />
                </div>
                <div>
                  <label className={labelCls}>Currency</label>
                  <input
                    type="text"
                    maxLength={3}
                    className={inputCls}
                    value={edit.currency}
                    onChange={(e) => setEdit((s) => s && ({ ...s, currency: e.target.value.toUpperCase() }))}
                  />
                </div>
              </div>

              <SaveButton saving={saving} onSave={saveOverride} label="Save Override" />
            </div>
          </div>
        )}
      </div>
    </FinanceLayout>
  );
}
