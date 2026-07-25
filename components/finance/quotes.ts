/**
 * components/finance/quotes.ts
 *
 * Ticker-quote refresh orchestration (network + client writes) for the
 * Finance section. Split out of `_shared.tsx` (which re-exports everything
 * here).
 */

import { client, listAll } from "./data";
import type { TickerQuoteRecord } from "./data";
import { uniqueTickers } from "./finance-core";

/** Whether a quote is stale (older than N hours; default 24). */
export function isQuoteStale(q: TickerQuoteRecord | null | undefined, hours = 24): boolean {
  if (!q?.fetchedAt) return true;
  const ageMs = Date.now() - new Date(q.fetchedAt).getTime();
  return ageMs > hours * 3600 * 1000;
}

/** Whether a quote is a manual override (source === "manual"). Refresh should skip these. */
export function isQuoteManual(q: TickerQuoteRecord | null | undefined): boolean {
  return q?.source === "manual";
}

/**
 * Result summary of a bulk price refresh.
 * Used by the UI on both the account detail page and the prices page.
 */
export type RefreshPricesResult = {
  attempted:      number;
  created:        number;
  updated:        number;
  skippedManual:  number;
  skippedNoPrice: number;
  failed:         number;
  /** Human-readable summary, e.g. "Updated 12 · 2 manual · 1 not on Yahoo". Empty if nothing happened. */
  message:        string;
  /** Error string if the whole batch failed before any writes. Null on success (even with per-ticker failures). */
  fatal:          string | null;
};

/**
 * Refresh all tickers currently held in any lot, via /api/quotes (Yahoo proxy).
 * - Skips tickers with a manual override (source="manual"): their price is user-managed.
 * - Skips tickers where Yahoo returns null (e.g. 401(k) trust funds not listed): preserves existing quote.
 * - Creates quote rows for brand-new tickers, updates existing rows in place.
 *
 * Shared by the account detail page "Refresh prices" button and the dedicated
 * Refresh all on the Prices page. Both pages show the same summary message.
 *
 * Caller is responsible for refetching the quotes list afterward and updating UI state.
 */
export async function refreshAllQuotes(): Promise<RefreshPricesResult> {
  const empty: RefreshPricesResult = {
    attempted: 0, created: 0, updated: 0, skippedManual: 0, skippedNoPrice: 0, failed: 0,
    message: "", fatal: null,
  };

  // 1. Gather every ticker held across all brokerage/retirement accounts —
  //    current positions (financeHolding) plus any unvested-RSU / not-yet-backfilled
  //    tickers that only exist as lots.
  const [allHoldings, allLots] = await Promise.all([
    listAll(client.models.financeHolding),
    listAll(client.models.financeHoldingLot),
  ]);
  const allTickers = uniqueTickers(allHoldings, allLots);
  if (allTickers.length === 0) {
    return { ...empty, message: "No tickers to refresh" };
  }

  // 2. Ask /api/quotes for live prices (one batch request)
  let quoteResults: Record<string, { price: number | null; currency?: string; error?: string }> = {};
  try {
    const res = await fetch("/api/quotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tickers: allTickers }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ...empty, attempted: allTickers.length, fatal: `/api/quotes failed: ${res.status} ${text}` };
    }
    const body = await res.json();
    quoteResults = body.quotes ?? {};
  } catch (err: any) {
    return { ...empty, attempted: allTickers.length, fatal: err?.message ?? String(err) };
  }

  // 3. Load existing quotes to distinguish create vs update, and to spot manual overrides
  const existingQuotes = await listAll(client.models.financeTickerQuote);
  const existingMap = new Map(
    existingQuotes.map((q) => [(q.ticker ?? "").toUpperCase(), q]),
  );

  const now = new Date().toISOString();
  let created = 0, updated = 0, skippedManual = 0, skippedNoPrice = 0, failed = 0;

  for (const ticker of allTickers) {
    const existing = existingMap.get(ticker);

    // Manual overrides are user-managed — never touch them
    if (isQuoteManual(existing)) { skippedManual++; continue; }

    const q = quoteResults[ticker];
    if (!q)              { failed++;         continue; }
    // Yahoo returned null price (e.g. trust funds, delisted tickers). Preserve existing record.
    if (q.price == null) { skippedNoPrice++;  continue; }

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
      console.error(`[refreshAllQuotes] failed to upsert ${ticker}:`, err?.message ?? err);
      failed++;
    }
  }

  // 4. Build status message
  const parts: string[] = [];
  if (created + updated > 0) parts.push(`Updated ${created + updated}`);
  if (skippedManual > 0)     parts.push(`${skippedManual} manual`);
  if (skippedNoPrice > 0)    parts.push(`${skippedNoPrice} not on Yahoo`);
  if (failed > 0)            parts.push(`${failed} failed`);

  return {
    attempted: allTickers.length,
    created,
    updated,
    skippedManual,
    skippedNoPrice,
    failed,
    message: parts.join(" · ") || "Nothing to update",
    fatal: null,
  };
}

// Module-level flag so two simultaneous callers in the same tab can't stomp on each
// other. Cross-tab coordination happens via the fetchedAt timestamp check below.
let _refreshInFlight = false;

export type MaybeRefreshResult =
  | { skipped: true;  reason: "fresh" | "in-flight" | "error"; result?: undefined }
  | { skipped: false; reason?: undefined;                      result: RefreshPricesResult };

/**
 * Auto-refresh wrapper. Short-circuits if another tab/device already refreshed
 * recently (newest non-manual quote within `freshnessMinutes`), or if a refresh
 * is already running in this tab. Errors are swallowed — callers are expected to
 * be background tickers that shouldn't break the UI on transient failures.
 */
export async function maybeRefreshAllQuotes(
  freshnessMinutes = 14,
): Promise<MaybeRefreshResult> {
  if (_refreshInFlight) return { skipped: true, reason: "in-flight" };
  _refreshInFlight = true;
  try {
    const existing = await listAll(client.models.financeTickerQuote);
    let newestMs = 0;
    for (const q of existing) {
      if (isQuoteManual(q)) continue;
      if (!q.fetchedAt) continue;
      const t = new Date(q.fetchedAt).getTime();
      if (t > newestMs) newestMs = t;
    }
    if (newestMs > 0 && (Date.now() - newestMs) / 60_000 < freshnessMinutes) {
      return { skipped: true, reason: "fresh" };
    }
    const result = await refreshAllQuotes();
    return { skipped: false, result };
  } catch (err: any) {
    console.warn("[maybeRefreshAllQuotes] skipped:", err?.message ?? err);
    return { skipped: true, reason: "error" };
  } finally {
    _refreshInFlight = false;
  }
}
