import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  HoldingLotRecord, TickerQuoteRecord,
  FINANCE_COLOR,
  fmtCurrency, fmtDate,
  uniqueTickers, isQuoteStale, isQuoteManual,
  inputCls, labelCls,
  SaveButton,
} from "@/components/finance/_shared";

type EditState = { ticker: string; price: number | ""; currency: string } | null;

export default function PricesPage() {
  const { authState } = useRequireAuth();

  const [lots,       setLots]       = useState<HoldingLotRecord[]>([]);
  const [quotes,     setQuotes]     = useState<TickerQuoteRecord[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [edit,       setEdit]       = useState<EditState>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: lotRecs }, { data: quoteRecs }] = await Promise.all([
        client.models.financeHoldingLot.list({ limit: 500 }),
        client.models.financeTickerQuote.list({ limit: 500 }),
      ]);
      setLots(lotRecs ?? []);
      setQuotes(quoteRecs ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchData();
  }, [authState, fetchData]);

  // ── Derived ────────────────────────────────────────────────────────────────

  // Union of tickers used in lots + tickers that have quotes (in case of orphan quotes)
  const allTickers = useMemo(() => {
    const fromLots   = uniqueTickers(lots);
    const fromQuotes = quotes.map((q) => (q.ticker ?? "").toUpperCase()).filter(Boolean);
    return Array.from(new Set([...fromLots, ...fromQuotes])).sort();
  }, [lots, quotes]);

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

  // Sort: manual overrides first, then stale yahoo, then fresh yahoo, then unpriced
  const sorted = useMemo(() => {
    const rankFor = (t: string): number => {
      const q = quoteByTicker.get(t);
      if (!q)                           return 3;  // no quote yet
      if (isQuoteManual(q))             return 0;  // manual override
      if (isQuoteStale(q))              return 1;  // stale yahoo
      return 2;                                    // fresh yahoo
    };
    return [...allTickers].sort((a, b) => {
      const ra = rankFor(a); const rb = rankFor(b);
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });
  }, [allTickers, quoteByTicker]);

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
      // Optimistic: reflect in local state without refetch
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
      // Flip source back to yahoo. Price is left in place as a reasonable starting value.
      // Next refresh will overwrite it with live data.
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

  if (authState !== "authenticated") return null;

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <div className="flex items-baseline gap-3">
              <h1 className="text-2xl font-bold text-purple dark:text-rose">Prices</h1>
              {allTickers.length > 0 && (
                <span className="text-sm text-gray-400 tabular-nums">
                  {allTickers.length} ticker{allTickers.length === 1 ? "" : "s"}
                </span>
              )}
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
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-darkElevated border-b border-gray-200 dark:border-darkBorder">
                  <tr>
                    <th className="px-4 py-2 text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium">Ticker</th>
                    <th className="px-4 py-2 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium">Price</th>
                    <th className="px-4 py-2 text-center text-[10px] uppercase tracking-widest text-gray-400 font-medium hidden sm:table-cell">Source</th>
                    <th className="px-4 py-2 text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium hidden md:table-cell">Last update</th>
                    <th className="px-4 py-2 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium hidden sm:table-cell">Lots</th>
                    <th className="px-4 py-2 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sorted.map((ticker) => {
                    const q        = quoteByTicker.get(ticker);
                    const manual   = isQuoteManual(q);
                    const stale    = q ? isQuoteStale(q) : true;
                    const lotCount = lotCountByTicker.get(ticker) ?? 0;
                    const cur      = q?.currency ?? "USD";
                    return (
                      <tr key={ticker} className="hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
                        <td className="px-4 py-2">
                          <p className="font-semibold text-gray-800 dark:text-gray-100">{ticker}</p>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums font-semibold text-gray-800 dark:text-gray-100">
                          {q?.price != null ? fmtCurrency(q.price, cur) : <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-4 py-2 text-center hidden sm:table-cell">
                          {!q ? (
                            <span className="text-[10px] text-gray-400">no quote</span>
                          ) : manual ? (
                            <span
                              className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide"
                              style={{ backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR }}
                            >
                              Manual
                            </span>
                          ) : (
                            <span
                              className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                            >
                              Yahoo
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-left text-xs hidden md:table-cell">
                          {q?.fetchedAt ? (
                            <span className={stale && !manual ? "text-amber-500" : "text-gray-500 dark:text-gray-400"}>
                              {fmtDate(q.fetchedAt.slice(0, 10))}
                              {stale && !manual && <span className="ml-1">· stale</span>}
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-xs text-gray-500 dark:text-gray-400 hidden sm:table-cell">
                          {lotCount}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => openEdit(ticker)}
                              className="text-[11px] font-semibold px-2 py-0.5 rounded border transition-colors"
                              style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR }}
                            >
                              {manual ? "Edit" : "Override"}
                            </button>
                            {manual && (
                              <button
                                onClick={() => clearOverride(ticker)}
                                disabled={saving}
                                className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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
