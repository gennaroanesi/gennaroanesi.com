/**
 * components/finance/_shared.tsx
 *
 * Shared types, helpers, and UI primitives for the Finance section.
 * Mirrors the pattern established in components/inventory/_shared.tsx.
 */

import React from "react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";

export const client = generateClient<Schema>();

// ── Pagination helper ────────────────────────────────────────────────────

/**
 * Page through an Amplify `list()` call until all records are retrieved.
 *
 * Amplify's `list()` returns a `nextToken` when more records exist beyond the
 * requested `limit` (default 100 server-side per page). A single call with
 * `limit: 5000` does NOT return the newest 5000 — DynamoDB returns records in
 * internal storage order (hash-distributed), so you'd get an arbitrary subset
 * and any records past that page would silently disappear from the UI.
 *
 * This helper paginates through every page and returns the full list. Client-
 * side sort + filter then operates on the complete set.
 *
 * Safety cap: stops at 50 pages (~5000 records @ 100/page) to prevent runaway
 * loops if something goes wrong server-side. For personal-finance scale this is
 * multiple years of runway; if you ever hit it, time to migrate to a GSI-backed
 * query.
 *
 * Usage:
 *   const txs = await listAll(client.models.financeTransaction);
 *   const accs = await listAll(client.models.financeAccount);
 */
export async function listAll<T>(
  model: {
    list: (args: { limit?: number; nextToken?: string | null; filter?: any }) => Promise<{
      data: T[] | null;
      nextToken?: string | null;
      errors?: any[];
    }>;
  },
  optsOrFilter: { pageSize?: number; maxPages?: number; filter?: any } | any = {},
): Promise<T[]> {
  // Positional-arg quality-of-life: `listAll(model, { date: { ge: "2026-01-01" } })`
  // is accepted as a filter shorthand, alongside the original
  // `listAll(model, { pageSize: 500 })` options shape. We detect by looking
  // for the pagination-control keys.
  const looksLikeOpts =
    optsOrFilter &&
    typeof optsOrFilter === "object" &&
    ("pageSize" in optsOrFilter || "maxPages" in optsOrFilter || "filter" in optsOrFilter);
  const opts: { pageSize?: number; maxPages?: number; filter?: any } =
    looksLikeOpts ? optsOrFilter : { filter: optsOrFilter };

  const pageSize = opts.pageSize ?? 1000;
  const maxPages = opts.maxPages ?? 50;
  const filter   = opts.filter;

  const out: T[] = [];
  let nextToken: string | null | undefined = null;
  let pages = 0;

  do {
    const args: any = { limit: pageSize, nextToken };
    if (filter) args.filter = filter;
    const res: any = await model.list(args);
    if (res?.errors?.length) {
      console.error("[listAll] errors:", res.errors);
      throw new Error(res.errors[0]?.message ?? "list failed");
    }
    if (res?.data?.length) out.push(...res.data);
    nextToken = res?.nextToken ?? null;
    pages++;
    if (pages >= maxPages) {
      console.warn(`[listAll] hit safety cap of ${maxPages} pages — result may be truncated`);
      break;
    }
  } while (nextToken);

  return out;
}

// ── Record types ──────────────────────────────────────────────────────────────

export type AccountRecord     = Schema["financeAccount"]["type"];
export type TransactionRecord = Schema["financeTransaction"]["type"];
export type RecurringRecord   = Schema["financeRecurring"]["type"];
export type GoalRecord        = Schema["financeSavingsGoal"]["type"];
export type GoalFundingSourceRecord = Schema["financeGoalFundingSource"]["type"];
export type HoldingLotRecord  = Schema["financeHoldingLot"]["type"];
export type TickerQuoteRecord = Schema["financeTickerQuote"]["type"];
export type AssetRecord       = Schema["financeAsset"]["type"];
export type MilestoneRecord   = Schema["financeGoalMilestone"]["type"];
export type LoanRecord        = Schema["financeLoan"]["type"];
export type LoanPaymentRecord = Schema["financeLoanPayment"]["type"];
export type AccountSnapshotRecord = Schema["financeAccountSnapshot"]["type"];

export type MilestoneStatus = "HIT" | "MISSED" | "PENDING";

// ── Enums / constants ─────────────────────────────────────────────────────────

export const ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "BROKERAGE", "RETIREMENT", "CREDIT", "LOAN", "CASH", "OTHER"] as const;
export type  AccountType   = (typeof ACCOUNT_TYPES)[number];

export const RETIREMENT_TYPES = ["_401K", "TRAD_IRA", "ROTH_IRA", "HSA", "SEP_IRA", "OTHER"] as const;
export type  RetirementType   = (typeof RETIREMENT_TYPES)[number];

export const RETIREMENT_TYPE_LABELS: Record<RetirementType, string> = {
  _401K:    "401(k)",
  TRAD_IRA: "Traditional IRA",
  ROTH_IRA: "Roth IRA",
  HSA:      "HSA",
  SEP_IRA:  "SEP-IRA",
  OTHER:    "Other",
};

/** Account types that hold positions (cash + holdings lots). Both brokerage and retirement */
export const INVESTED_ACCOUNT_TYPES: AccountType[] = ["BROKERAGE", "RETIREMENT"];

/** Does this account type hold holdings lots? (brokerage + retirement) */
export function isInvestedAccount(type: string | null | undefined): boolean {
  return type === "BROKERAGE" || type === "RETIREMENT";
}

export const TX_TYPES    = ["INCOME", "EXPENSE", "TRANSFER"] as const;
export type  TxType      = (typeof TX_TYPES)[number];

export const TX_STATUSES = ["POSTED", "PENDING"] as const;
export type  TxStatus    = (typeof TX_STATUSES)[number];

export const CADENCES    = ["WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "SEMIANNUALLY", "ANNUALLY"] as const;
export type  Cadence     = (typeof CADENCES)[number];

export const ASSET_TYPES = ["STOCK", "ETF", "MUTUAL_FUND", "CRYPTO", "BOND", "OTHER"] as const;
export type  AssetType   = (typeof ASSET_TYPES)[number];

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  STOCK:       "Stock",
  ETF:         "ETF",
  MUTUAL_FUND: "Mutual Fund",
  CRYPTO:      "Crypto",
  BOND:        "Bond",
  OTHER:       "Other",
};

// ── Physical assets (house, car, etc. — NOT holdings lots) ──────────────────────────

export const PHYSICAL_ASSET_TYPES = ["REAL_ESTATE", "VEHICLE", "COLLECTIBLE", "OTHER"] as const;
export type  PhysicalAssetType    = (typeof PHYSICAL_ASSET_TYPES)[number];

export const PHYSICAL_ASSET_TYPE_LABELS: Record<PhysicalAssetType, string> = {
  REAL_ESTATE: "Real Estate",
  VEHICLE:     "Vehicle",
  COLLECTIBLE: "Collectible",
  OTHER:       "Other",
};

// ── Loans ─────────────────────────────────────────────────────────────────────

export const LOAN_TYPES = ["MORTGAGE", "AUTO", "STUDENT", "PERSONAL", "HELOC", "OTHER"] as const;
export type  LoanType   = (typeof LOAN_TYPES)[number];

export const LOAN_TYPE_LABELS: Record<LoanType, string> = {
  MORTGAGE: "Mortgage",
  AUTO:     "Auto",
  STUDENT:  "Student",
  PERSONAL: "Personal",
  HELOC:    "HELOC",
  OTHER:    "Other",
};

export const LOAN_PAYMENT_STRATEGIES = ["PRICE_FIXED_PAYMENT", "PRICE_FIXED_TERM"] as const;
export type  LoanPaymentStrategy    = (typeof LOAN_PAYMENT_STRATEGIES)[number];

export const LOAN_PAYMENT_STRATEGY_LABELS: Record<LoanPaymentStrategy, string> = {
  PRICE_FIXED_PAYMENT: "Fixed payment (shorter term when prepaying)",
  PRICE_FIXED_TERM:    "Fixed term (lower payment when prepaying)",
};

export const LOAN_PAYMENT_STATUSES = ["SCHEDULED", "POSTED"] as const;
export type  LoanPaymentStatus    = (typeof LOAN_PAYMENT_STATUSES)[number];

export const FINANCE_COLOR = "#10b981";

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  CHECKING:   "Checking",
  SAVINGS:    "Savings",
  BROKERAGE:  "Brokerage",
  RETIREMENT: "Retirement",
  CREDIT:     "Credit Card",
  LOAN:       "Loan",
  CASH:       "Cash",
  OTHER:      "Other",
};

export const CADENCE_LABELS: Record<Cadence, string> = {
  WEEKLY:       "Weekly",
  BIWEEKLY:     "Bi-weekly",
  MONTHLY:      "Monthly",
  QUARTERLY:    "Quarterly",
  SEMIANNUALLY: "Semi-annually",
  ANNUALLY:     "Annually",
};

// ── Formatters ────────────────────────────────────────────────────────────────

export function fmtCurrency(
  amount: number | null | undefined,
  currency = "USD",
  showSign = false,
): string {
  if (amount == null) return "—";
  const fmt = new Intl.NumberFormat("en-US", {
    style:    "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(amount));
  if (showSign && amount > 0) return `+${fmt}`;
  if (amount < 0) return `-${fmt}`;
  return fmt;
}

export function fmtDate(date: string | null | undefined): string {
  if (!date) return "—";
  const [y, m, d] = date.split("-");
  return `${m}/${d}/${y}`;
}

/** Today as YYYY-MM-DD local */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Last day of the month for a given year/month (month is 0-indexed). */
function lastDayOfMonth(year: number, month: number): number {
  // Day 0 of next month = last day of this month
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Advance a date by N months, returning YYYY-MM-DD.
 * Naive: uses JS setMonth semantics (overflows at month end — e.g. Jan 30 + 1mo = Mar 2).
 * Prefer {@link addMonthsAnchored} when you care about preserving a day-of-month anchor.
 */
export function addMonths(isoDate: string, n: number): string {
  const d = new Date(isoDate + "T12:00:00");
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Advance a date by N months while preserving an anchor day-of-month.
 * Clamps to the last day of the target month when the anchor doesn't exist
 * (e.g. anchor=31, Feb → Feb 28/29).
 *
 * Example: anchor=30, Jan 30 + 1mo → Feb 28/29; Feb 28 + 1mo → Mar 30.
 */
export function addMonthsAnchored(isoDate: string, n: number, anchorDay: number): string {
  const d = new Date(isoDate + "T12:00:00");
  const targetYear  = d.getFullYear();
  const targetMonth = d.getMonth() + n;
  // Let JS normalize year/month overflow by setting day=1 first
  const normalized = new Date(targetYear, targetMonth, 1, 12, 0, 0);
  const y = normalized.getFullYear();
  const m = normalized.getMonth();
  const day = Math.min(anchorDay, lastDayOfMonth(y, m));
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(isoDate: string, n: number): string {
  const d = new Date(isoDate + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Months to advance for each cadence (null = not month-based). */
export const CADENCE_MONTH_STEP: Record<Cadence, number | null> = {
  WEEKLY:       null,
  BIWEEKLY:     null,
  MONTHLY:      1,
  QUARTERLY:    3,
  SEMIANNUALLY: 6,
  ANNUALLY:     12,
};

/** Approximate monthly-equivalent factor for aggregating recurring amounts. */
export const CADENCE_MONTHLY_FACTOR: Record<Cadence, number> = {
  WEEKLY:       4.33,
  BIWEEKLY:     2.17,
  MONTHLY:      1,
  QUARTERLY:    1 / 3,
  SEMIANNUALLY: 1 / 6,
  ANNUALLY:     1 / 12,
};

/**
 * Next occurrence >= today given a cadence and current nextDate.
 * For month-based cadences, pass the anchor date (usually the recurrence's
 * startDate) so day-of-month is preserved across months with fewer days.
 */
export function nextOccurrence(nextDate: string, cadence: Cadence, anchorDate?: string): string {
  const today = todayIso();
  let cur = nextDate;
  const monthStep = CADENCE_MONTH_STEP[cadence];
  const anchorDay = anchorDate
    ? parseInt(anchorDate.split("-")[2], 10)
    : parseInt(nextDate.split("-")[2], 10);

  while (cur < today) {
    if (monthStep != null) {
      cur = addMonthsAnchored(cur, monthStep, anchorDay);
    } else {
      switch (cadence) {
        case "WEEKLY":   cur = addDays(cur, 7);  break;
        case "BIWEEKLY": cur = addDays(cur, 14); break;
      }
    }
  }
  return cur;
}

/**
 * Advance a date by exactly one occurrence of the given cadence,
 * preserving the anchor day for month-based cadences.
 */
export function advanceByCadence(isoDate: string, cadence: Cadence, anchorDate?: string): string {
  const monthStep = CADENCE_MONTH_STEP[cadence];
  if (monthStep != null) {
    const anchorDay = anchorDate
      ? parseInt(anchorDate.split("-")[2], 10)
      : parseInt(isoDate.split("-")[2], 10);
    return addMonthsAnchored(isoDate, monthStep, anchorDay);
  }
  switch (cadence) {
    case "WEEKLY":   return addDays(isoDate, 7);
    case "BIWEEKLY": return addDays(isoDate, 14);
    default:         return isoDate;
  }
}

/**
 * Whether a recurrence is live for cashflow/projection purposes.
 * Treats a recurrence as ended if endDate is set and already past today.
 * Inactive flag (user-toggled) takes precedence.
 */
export function isRecurrenceLive(rec: RecurringRecord): boolean {
  if (rec.active === false) return false;
  if (rec.endDate && rec.endDate < todayIso()) return false;
  return true;
}

// ── Holdings ───────────────────────────────────────────────────────────────────────────────

/** Quote lookup by (UPPERCASE) ticker. */
export type QuoteMap = Map<string, TickerQuoteRecord>;

export function buildQuoteMap(quotes: TickerQuoteRecord[]): QuoteMap {
  const m: QuoteMap = new Map();
  for (const q of quotes) {
    if (q.ticker) m.set(q.ticker.toUpperCase(), q);
  }
  return m;
}

/**
 * Aggregated view of one ticker across all its lots in an account.
 * - totalQty:     summed across lots
 * - totalCost:    summed if all lots have a cost basis; null if any lot missing
 * - marketValue:  quote.price * totalQty (null if no quote)
 * - gainLoss / gainLossPct: null unless both totalCost and marketValue are known
 */
export type TickerAggregate = {
  ticker:       string;
  assetType:    AssetType | null;
  lots:         HoldingLotRecord[];
  totalQty:     number;
  totalCost:    number | null;
  price:        number | null;
  fetchedAt:    string | null;
  marketValue:  number | null;
  gainLoss:     number | null;
  gainLossPct:  number | null;
};

/** Aggregate a set of lots for one ticker, joined with a quote map. */
export function tickerAggregate(
  ticker: string,
  lots: HoldingLotRecord[],
  quotes: QuoteMap,
): TickerAggregate {
  const tickerUpper = ticker.toUpperCase();
  const myLots = lots.filter((l) => (l.ticker ?? "").toUpperCase() === tickerUpper);
  const totalQty = myLots.reduce((s, l) => s + (l.quantity ?? 0), 0);
  const anyMissingCost = myLots.some((l) => l.costBasis == null);
  const totalCost = anyMissingCost
    ? null
    : myLots.reduce((s, l) => s + (l.costBasis ?? 0), 0);
  const quote = quotes.get(tickerUpper) ?? null;
  const price = quote?.price ?? null;
  const fetchedAt = quote?.fetchedAt ?? null;
  const marketValue = price != null ? price * totalQty : null;
  const gainLoss = marketValue != null && totalCost != null ? marketValue - totalCost : null;
  const gainLossPct = gainLoss != null && totalCost != null && totalCost !== 0
    ? gainLoss / totalCost
    : null;
  // assetType: take the first lot's value; if lots disagree, first wins (user error)
  const assetType = (myLots.find((l) => l.assetType)?.assetType ?? null) as AssetType | null;

  return {
    ticker: tickerUpper,
    assetType,
    lots: myLots,
    totalQty,
    totalCost,
    price,
    fetchedAt,
    marketValue,
    gainLoss,
    gainLossPct,
  };
}

/** Distinct tickers across a set of lots (uppercase). */
export function uniqueTickers(lots: HoldingLotRecord[]): string[] {
  const s = new Set<string>();
  for (const l of lots) {
    if (l.ticker) s.add(l.ticker.toUpperCase());
  }
  return Array.from(s).sort();
}

/**
 * Total value of an account including holdings.
 * For non-invested accounts this is just `currentBalance`.
 * For brokerage/retirement accounts it's `currentBalance` (cash) + Σ(lot qty * quote price).
 * Lots with no quote contribute 0 — UI should surface unpriced tickers.
 */
export function accountTotalValue(
  acc: AccountRecord,
  lots: HoldingLotRecord[] = [],
  quotes: QuoteMap = new Map(),
): number {
  const cash = acc.currentBalance ?? 0;
  if (!isInvestedAccount(acc.type)) return cash;
  const myLots = lots.filter((l) => l.accountId === acc.id);
  const holdingsValue = myLots.reduce((s, l) => {
    const q = quotes.get((l.ticker ?? "").toUpperCase());
    if (!q?.price) return s;
    return s + (l.quantity ?? 0) * q.price;
  }, 0);
  return cash + holdingsValue;
}

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

  // 1. Gather every ticker held across all brokerage/retirement accounts
  const allLots = await listAll(client.models.financeHoldingLot);
  const allTickers = uniqueTickers(allLots);
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

// ── Physical assets ─────────────────────────────────────────────────────────────────

/** Total value of active assets. Inactive (sold) assets contribute 0. */
export function totalAssetValue(assets: AssetRecord[]): number {
  return assets
    .filter((a) => a.active !== false)
    .reduce((s, a) => s + (a.currentValue ?? 0), 0);
}

/**
 * Gain/loss $ for an asset (currentValue − purchaseValue).
 * Null if purchase value unknown (gracefully hidden in UI).
 */
export function assetGainLoss(asset: AssetRecord): number | null {
  if (asset.purchaseValue == null) return null;
  return (asset.currentValue ?? 0) - asset.purchaseValue;
}

/** Gain/loss % for an asset. Null if purchase value missing or zero. */
export function assetGainLossPct(asset: AssetRecord): number | null {
  if (!asset.purchaseValue) return null;
  return ((asset.currentValue ?? 0) - asset.purchaseValue) / asset.purchaseValue;
}

// ── Goal milestones ────────────────────────────────────────────────────────────────

/** Sort milestones chronologically by targetDate ascending. */
export function sortMilestones(ms: MilestoneRecord[]): MilestoneRecord[] {
  return [...ms].sort((a, b) => (a.targetDate ?? "").localeCompare(b.targetDate ?? ""));
}

/**
 * Status of a milestone for a given goal's currentAmount, as of today.
 * - HIT     — currentAmount already meets or exceeds the milestone target
 * - MISSED  — past the milestone's targetDate without hitting it
 * - PENDING — not yet hit, not yet past the target date
 */
export function milestoneStatus(
  m: MilestoneRecord,
  goalCurrentAmount: number,
  asOfIso?: string,
): MilestoneStatus {
  const asOf = asOfIso ?? new Date().toISOString().slice(0, 10);
  if (goalCurrentAmount >= (m.targetAmount ?? 0)) return "HIT";
  if ((m.targetDate ?? "") && asOf > (m.targetDate ?? "")) return "MISSED";
  return "PENDING";
}

// ── Goal funding allocation ──────────────────────────────────────

/**
 * Result of running the allocation algorithm across all accounts + mappings.
 *
 * - allocatedByGoal: goalId → total $ allocated from all source accounts (capped at target)
 * - surplusByAccount: accountId → leftover $ on the account not absorbed by any mapped goal
 * - allocatedByMapping: mappingId → $ from this specific mapping. Lets the UI show
 *   "HYSA contributed $3,200 to Honeymoon and $1,800 to Emergency" without re-running math
 */
export type GoalAllocationResult = {
  allocatedByGoal:     Map<string, number>;
  surplusByAccount:    Map<string, number>;
  allocatedByMapping:  Map<string, number>;
};

/**
 * Allocate account balances to savings goals given a mapping table.
 *
 * Pure function — no side effects, no I/O. Safe to call on every render; the
 * dashboard already holds all inputs in state. Sub-millisecond for realistic sizes.
 *
 * Algorithm (per account, independent):
 *   remaining = account total value (cash + positions for brokerage/retirement)
 *   for each mapping sorted by priority asc (tiebreak: mapping.id for stable order):
 *     need = max(0, goal.targetAmount - goal.allocatedSoFar)
 *     take = min(remaining, need)
 *     goal.allocatedSoFar += take
 *     remaining -= take
 *   surplus = remaining
 *
 * Design decisions:
 * - **Credit accounts excluded**: negative balances would subtract from goals. Users
 *   shouldn't be able to map a CREDIT account in the UI, but we guard here too.
 * - **LOAN accounts excluded**: debt, not an asset.
 * - **Inactive accounts excluded**: their mappings stay in the DB for reactivation,
 *   but they contribute 0 to allocations while inactive.
 * - **Negative-balance non-credit accounts excluded**: unusual but possible (overdrawn
 *   checking). Treat as zero — a negative balance can't fund anything.
 * - **Goals cap at target**: any excess on the account becomes surplus. Surplus is a
 *   signal to the user ("move this somewhere useful") not a silent absorption.
 * - **Multi-account goals**: the goal's allocated amount accumulates across all
 *   accounts that map to it. Cap still applies globally.
 * - **Holdings ARE included**: for BROKERAGE/RETIREMENT accounts we use
 *   accountTotalValue (cash + Σ lot × quote). Positions are market-volatile so the
 *   allocation will fluctuate with the market — the user opts into this by mapping
 *   a brokerage/retirement account to long-term goals and should manage stability
 *   themselves (e.g. don't map a volatile brokerage to a near-term emergency fund).
 *   If lots/quotes are empty or undefined, this degrades gracefully to cash-only.
 */
export function computeGoalAllocations(
  accounts: AccountRecord[],
  goals:    GoalRecord[],
  mappings: GoalFundingSourceRecord[],
  lots:     HoldingLotRecord[] = [],
  quotes:   TickerQuoteRecord[] = [],
): GoalAllocationResult {
  const allocatedByGoal    = new Map<string, number>();
  const surplusByAccount   = new Map<string, number>();
  const allocatedByMapping = new Map<string, number>();

  // Build fast lookups
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const goalById    = new Map(goals.map((g) => [g.id, g]));
  const quoteMap    = buildQuoteMap(quotes);

  // Group mappings by account so each account's fill order is independent
  const mappingsByAccount = new Map<string, GoalFundingSourceRecord[]>();
  for (const m of mappings) {
    if (!m.accountId) continue;
    const bucket = mappingsByAccount.get(m.accountId) ?? [];
    bucket.push(m);
    mappingsByAccount.set(m.accountId, bucket);
  }

  for (const [accountId, accMappings] of [...mappingsByAccount.entries()]
    // Process accounts with fewer mapped goals first: a dedicated account (1 mapping)
    // should fill its goal before a general pool (many mappings) absorbs everything.
    // Tiebreak by account name for stable render order.
    .sort((a, b) => {
      const countDiff = a[1].length - b[1].length;
      if (countDiff !== 0) return countDiff;
      const accA = accountById.get(a[0]);
      const accB = accountById.get(b[0]);
      return (accA?.name ?? "").localeCompare(accB?.name ?? "");
    })
  ) {
    const acc = accountById.get(accountId);
    if (!acc) continue;

    // Skip accounts that can't legitimately fund a goal
    if (acc.active === false) continue;
    if (acc.type === "CREDIT") continue;      // debt account; negative balance
    if (acc.type === "LOAN") continue;        // debt account

    // For brokerage/retirement accounts this includes positions at current market
    // price. For cash-only accounts it's just currentBalance. Clamp to 0 — a
    // negative total (overdrawn) can't fund anything.
    let remaining = Math.max(0, accountTotalValue(acc, lots, quoteMap));

    // Sort by priority asc, stable tiebreak by mapping id so re-renders are deterministic
    const sorted = [...accMappings].sort((a, b) => {
      const pa = a.priority ?? 100;
      const pb = b.priority ?? 100;
      if (pa !== pb) return pa - pb;
      return (a.id ?? "").localeCompare(b.id ?? "");
    });

    for (const m of sorted) {
      const goal = goalById.get(m.goalId ?? "");
      if (!goal) continue;

      const alreadyAllocated = allocatedByGoal.get(goal.id) ?? 0;
      const need = Math.max(0, (goal.targetAmount ?? 0) - alreadyAllocated);
      const take = Math.min(remaining, need);

      if (take > 0) {
        allocatedByGoal.set(goal.id, alreadyAllocated + take);
        allocatedByMapping.set(m.id, take);
        remaining -= take;
      } else {
        // Record zero allocations so the UI can still show the mapping exists
        allocatedByMapping.set(m.id, 0);
      }
    }

    surplusByAccount.set(accountId, remaining);
  }

  return { allocatedByGoal, surplusByAccount, allocatedByMapping };
}

/**
 * Effective current amount for a goal, preferring computed allocation when the goal
 * has at least one mapping; falling back to the stored (manual) currentAmount otherwise.
 *
 * This is the read path the UI should use everywhere that currently reads goal.currentAmount.
 * Over time, as every goal gets mapped, the stored field becomes vestigial — at which
 * point we can drop it. Until then, this bridge keeps unmapped goals showing sane values.
 */
export function effectiveGoalAmount(
  goal: GoalRecord,
  allocations: GoalAllocationResult,
  mappings: GoalFundingSourceRecord[],
): number {
  const hasMapping = mappings.some((m) => m.goalId === goal.id);
  if (hasMapping) {
    return allocations.allocatedByGoal.get(goal.id) ?? 0;
  }
  return goal.currentAmount ?? 0;
}

/** True if any mapping on this goal points at a brokerage or retirement account.
 *  UI uses this to show a "market-volatile funding" hint on the goal card, since
 *  the allocated amount will fluctuate with quotes. */
export function goalHasVolatileFunding(
  goal: GoalRecord,
  mappings: GoalFundingSourceRecord[],
  accounts: AccountRecord[],
): boolean {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  return mappings.some((m) => {
    if (m.goalId !== goal.id) return false;
    const acc = accountById.get(m.accountId ?? "");
    return acc ? isInvestedAccount(acc.type) : false;
  });
}

/** True if the goal has at least one funding-source mapping — used to decide between
 *  computed allocation and manual currentAmount in the UI. */
export function goalHasFundingSource(
  goal: GoalRecord,
  mappings: GoalFundingSourceRecord[],
): boolean {
  return mappings.some((m) => m.goalId === goal.id);
}

// ── Goal projection (growth + contribution) ─────────────────────────

/** Default assumed annual growth rate when the goal doesn't specify one. Conservative
 *  — below historical S&P average (~10% nominal, ~7% real) to account for drag from
 *  non-equity holdings, fees, and bad luck. Overridable per goal. */
export const DEFAULT_EXPECTED_GROWTH = 0.05;

/** Resolve a goal's assumed annual growth rate (decimal). Null/undefined field falls
 *  back to the default. Callers should never reach for goal.expectedAnnualGrowth directly. */
export function resolvedGrowthRate(goal: GoalRecord): number {
  const raw = goal.expectedAnnualGrowth;
  if (raw == null) return DEFAULT_EXPECTED_GROWTH;
  return raw;
}

/**
 * Project whether a goal is reachable given current amount, time remaining, and
 * assumed annual growth. Assumes monthly compounding. Returns:
 *
 * - `projectedEndValue`: what `currentAmount` grows to over `months` at `annualRate`
 *   with zero contributions. Useful for "you're already on track" messaging.
 * - `requiredMonthlyContribution`: if `projectedEndValue < targetAmount`, what you'd
 *   need to contribute per month to close the gap. Null if already on track or if
 *   months <= 0 (degenerate).
 *
 * Math: future value of a lump sum + future value of an ordinary annuity.
 *   FV = PV * (1 + r/12)^n  +  PMT * ((1 + r/12)^n - 1) / (r/12)
 * Solve for PMT:
 *   PMT = (FV_target - PV * (1+r/12)^n) / (((1+r/12)^n - 1) / (r/12))
 *
 * Edge case: if annualRate = 0, the annuity factor degenerates to `n` and the formula
 * collapses to the naive `(FV - PV) / n`. Handled explicitly to avoid division by zero.
 */
export function projectGoal(
  currentAmount: number,
  targetAmount: number,
  months: number,
  annualRate: number,
): { projectedEndValue: number; requiredMonthlyContribution: number | null } {
  const pv = Math.max(0, currentAmount);
  const fv = Math.max(0, targetAmount);

  if (months <= 0) {
    return { projectedEndValue: pv, requiredMonthlyContribution: null };
  }

  // Zero-growth branch: straight linear math.
  if (annualRate === 0) {
    const gap = fv - pv;
    return {
      projectedEndValue: pv,
      requiredMonthlyContribution: gap > 0 ? gap / months : null,
    };
  }

  const monthlyRate  = annualRate / 12;
  const growthFactor = Math.pow(1 + monthlyRate, months);   // (1 + r/12)^n
  const projectedEndValue = pv * growthFactor;

  if (projectedEndValue >= fv) {
    // Growth alone gets there; no contribution needed.
    return { projectedEndValue, requiredMonthlyContribution: null };
  }

  const annuityFactor = (growthFactor - 1) / monthlyRate;    // Σ_{k=0..n-1} (1+r/12)^k
  const requiredMonthlyContribution = (fv - projectedEndValue) / annuityFactor;

  return { projectedEndValue, requiredMonthlyContribution };
}

// ── Loan amortization + balance ───────────────────────────────────────────────────

/**
 * One row of a Price-style (French/Italian fixed-rate) amortization schedule.
 * Each month has a fixed total payment; principal grows and interest shrinks
 * as the balance draws down.
 */
export type AmortizationRow = {
  sequenceNumber: number;   // 1-indexed
  date: string;             // ISO (YYYY-MM-DD)
  totalAmount: number;
  principal: number;
  interest: number;
  balanceAfter: number;     // remaining balance after this payment
};

/**
 * Price-style monthly payment formula.
 * P * r / (1 - (1 + r)^-n), where r = monthly rate, n = months remaining.
 * If rate is 0, returns simple principal/n.
 */
export function priceMonthlyPayment(
  principal: number,
  annualRate: number,
  months: number,
): number {
  if (months <= 0) return 0;
  const r = annualRate / 12;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
}

/** Add N months to an ISO date string, preserving day-of-month when possible. */
export function addMonthsIso(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, (m - 1) + n, d));
  // Handle overflow (e.g. Jan 31 + 1mo → should be Feb 28/29, not Mar 3)
  if (date.getUTCDate() !== d) {
    date.setUTCDate(0); // roll back to last day of previous month
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Generate a full Price-style amortization schedule.
 * @param principal       starting balance
 * @param annualRate      APR as decimal (0.045 for 4.5%)
 * @param months          remaining term in months
 * @param firstPaymentDate ISO date of the first payment (seq 1)
 * @param startingSeq     sequence number of the first row (defaults to 1; use when
 *                        generating mid-loan schedules after a prepayment)
 * @returns array of amortization rows, one per month
 */
export function amortize(
  principal: number,
  annualRate: number,
  months: number,
  firstPaymentDate: string,
  startingSeq = 1,
): AmortizationRow[] {
  const rows: AmortizationRow[] = [];
  if (principal <= 0 || months <= 0) return rows;

  const monthly = priceMonthlyPayment(principal, annualRate, months);
  const r = annualRate / 12;
  let balance = principal;

  for (let i = 0; i < months; i++) {
    const interest = balance * r;
    // Last row squares the balance to 0 regardless of rounding drift
    let principalPortion = monthly - interest;
    if (i === months - 1) principalPortion = balance;
    const total = principalPortion + interest;
    const newBalance = Math.max(0, balance - principalPortion);

    rows.push({
      sequenceNumber: startingSeq + i,
      date:           addMonthsIso(firstPaymentDate, i),
      totalAmount:    round2(total),
      principal:      round2(principalPortion),
      interest:       round2(interest),
      balanceAfter:   round2(newBalance),
    });

    balance = newBalance;
  }
  return rows;
}

/** Round to 2 decimal places (avoid 0.1 + 0.2 = 0.30000000000000004). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Cached loan balance from posted payments:
 *   originalPrincipal − Σ(POSTED payment.principal)
 * Used by "Recalculate from transactions" audit + correction banner logic.
 */
export function computeLoanBalanceFromPayments(
  originalPrincipal: number,
  payments: LoanPaymentRecord[],
): number {
  const posted = payments.filter((p) => p.status === "POSTED");
  const principalPaid = posted.reduce((s, p) => s + (p.principal ?? 0), 0);
  return round2(originalPrincipal - principalPaid);
}

/**
 * Remaining scheduled payments (status === SCHEDULED, sorted by sequenceNumber/date).
 * Used for "months remaining" displays and for the recalculate-schedule flow.
 */
export function remainingScheduled(payments: LoanPaymentRecord[]): LoanPaymentRecord[] {
  return payments
    .filter((p) => p.status === "SCHEDULED")
    .sort((a, b) => {
      const sa = a.sequenceNumber ?? 0;
      const sb = b.sequenceNumber ?? 0;
      if (sa !== sb) return sa - sb;
      return (a.date ?? "").localeCompare(b.date ?? "");
    });
}

/** Count of posted payments (for "payment N of M" display). */
export function postedCount(payments: LoanPaymentRecord[]): number {
  return payments.filter((p) => p.status === "POSTED").length;
}

/** Percentage of original principal paid off (0..1). */
export function loanProgressPct(loan: LoanRecord): number {
  const orig = loan.originalPrincipal ?? 0;
  if (orig <= 0) return 0;
  const paid = orig - (loan.currentBalance ?? 0);
  return Math.min(1, Math.max(0, paid / orig));
}

/** Total interest paid across all posted payments. Useful for summary displays. */
export function totalInterestPaid(payments: LoanPaymentRecord[]): number {
  return payments
    .filter((p) => p.status === "POSTED")
    .reduce((s, p) => s + (p.interest ?? 0), 0);
}

// ── Loan recalculation ─────────────────────────────────────────────────────

/**
 * Forward-only scenario for a loan's remaining balance given a target monthly
 * principal contribution. Walks month-by-month applying rate-based interest;
 * principal = max(0, monthlyPayment − interest). Stops on balance ≤ 0 or on
 * the guard when the contribution can't even cover the interest.
 *
 * Cap at 100 years to avoid runaway loops on degenerate inputs.
 */
function simulatePayoff(
  balance: number,
  annualRate: number,
  monthlyPayment: number,
): { months: number; totalInterest: number; stalls: boolean } {
  if (balance <= 0) return { months: 0, totalInterest: 0, stalls: false };
  const r = annualRate / 12;
  const firstInterest = balance * r;
  // Degenerate case: contribution can't cover the first month's interest.
  if (monthlyPayment <= firstInterest) {
    return { months: Infinity, totalInterest: 0, stalls: true };
  }
  let remaining = balance;
  let months = 0;
  let interestAccum = 0;
  const CAP = 100 * 12;
  while (remaining > 0 && months < CAP) {
    const interest = remaining * r;
    interestAccum += interest;
    const principal = Math.min(remaining, monthlyPayment - interest);
    remaining -= principal;
    months++;
  }
  return {
    months,
    totalInterest: round2(interestAccum),
    stalls: remaining > 0,     // hit cap without clearing — treated as "never"
  };
}

export type RecalculateLoanResult = {
  /** Loan state as of now */
  remainingBalance:    number;
  interestPaidToDate:  number;
  postedPaymentCount:  number;

  /** Trailing averages from the last N months of POSTED payments (up to 6) */
  avgPaymentLast6Mo:   number;   // average total payment
  avgPrincipalLast6Mo: number;   // average principal reduction

  /** Projection scenarios — each assumes fixed monthly contribution going forward */
  scenarios: {
    /** What happens if the user keeps paying at recent-average pace */
    currentPace: {
      monthlyPayment: number;    // = avgPaymentLast6Mo
      months:         number;    // months to zero balance
      payoffDate:     string;    // YYYY-MM-DD
      totalInterest:  number;    // remaining interest paid from today
      underPaying:    boolean;   // true when avg can't cover monthly interest
    };
    /** Payment needed to finish on the loan's original contractual payoff date */
    originalTerm: {
      monthlyPayment: number;
      monthsLeft:     number;    // calendar months from today to original payoff
      payoffDate:     string;
    };
    /** Payment needed to clear in exactly N months (for the canonical 12/24/60 tiles) */
    payoffInMonths: Record<12 | 24 | 36 | 60, { monthlyPayment: number; payoffDate: string }>;
  };
};

/**
 * Deterministic recalc of a loan's forward trajectory given its current state
 * and posted payment history. Pure function — all side effects happen at
 * call sites that render the result.
 */
export function recalculateLoan(
  loan: LoanRecord,
  payments: LoanPaymentRecord[],
): RecalculateLoanResult {
  const balance          = loan.currentBalance ?? 0;
  const annualRate       = loan.interestRate ?? 0;
  const interestPaid     = totalInterestPaid(payments);
  const posted           = payments
    .filter((p) => p.status === "POSTED")
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const recent           = posted.slice(0, 6);
  const avgPayment       = recent.length
    ? recent.reduce((s, p) => s + (p.totalAmount ?? 0), 0) / recent.length
    : 0;
  const avgPrincipal     = recent.length
    ? recent.reduce((s, p) => s + (p.principal ?? 0), 0) / recent.length
    : 0;

  // ── currentPace ────────────────────────────────────────────────────────
  const paceSim = simulatePayoff(balance, annualRate, avgPayment);
  const paceDate = paceSim.stalls
    ? ""
    : addMonthsIso(todayIso(), paceSim.months);

  // ── originalTerm ────────────────────────────────────────────────────────
  // Months from today to the loan's contractual payoff date.
  const firstPay   = loan.firstPaymentDate ?? loan.startDate ?? todayIso();
  const totalTerm  = loan.termMonths ?? 0;
  const payoffOrig = addMonthsIso(firstPay, Math.max(0, totalTerm - 1));
  const monthsLeftOrig = Math.max(1, monthsUntil(payoffOrig));
  const origPmt    = priceMonthlyPayment(balance, annualRate, monthsLeftOrig);

  // ── payoffIn{12,24,36,60} ───────────────────────────────────────────────
  const targets: Array<12 | 24 | 36 | 60> = [12, 24, 36, 60];
  const payoffInMonths = targets.reduce((acc, m) => {
    acc[m] = {
      monthlyPayment: priceMonthlyPayment(balance, annualRate, m),
      payoffDate:     addMonthsIso(todayIso(), m),
    };
    return acc;
  }, {} as RecalculateLoanResult["scenarios"]["payoffInMonths"]);

  return {
    remainingBalance:    round2(balance),
    interestPaidToDate:  round2(interestPaid),
    postedPaymentCount:  posted.length,
    avgPaymentLast6Mo:   round2(avgPayment),
    avgPrincipalLast6Mo: round2(avgPrincipal),
    scenarios: {
      currentPace: {
        monthlyPayment: round2(avgPayment),
        months:         paceSim.stalls ? Infinity : paceSim.months,
        payoffDate:     paceDate,
        totalInterest:  paceSim.totalInterest,
        underPaying:    paceSim.stalls,
      },
      originalTerm: {
        monthlyPayment: round2(origPmt),
        monthsLeft:     monthsLeftOrig,
        payoffDate:     payoffOrig,
      },
      payoffInMonths,
    },
  };
}

/**
 * Monthly payment required to clear an arbitrary target month count. Thin
 * wrapper that exists so the UI can drive a "custom months" slider without
 * duplicating the formula.
 */
export function paymentForTargetMonths(
  loan: LoanRecord,
  targetMonths: number,
): number {
  return round2(
    priceMonthlyPayment(loan.currentBalance ?? 0, loan.interestRate ?? 0, Math.max(1, targetMonths)),
  );
}

// ── Projections ────────────────────────────────────────────────────────────

/**
 * Project an account's balance `horizonDays` into the future.
 *
 * Two components are combined:
 * 1. **Deterministic**: sum of recurring-rule amounts whose occurrences fall
 *    within [today, today+horizonDays] given the rule's cadence and end date.
 * 2. **Stochastic**: average *non-recurring* daily drift from the account's
 *    trailing snapshots, scaled to the horizon. Excluding recurring-occurrence
 *    days prevents double-counting the deterministic inflows/outflows.
 *
 * The band (low/high) is the stochastic component's sample standard deviation
 * scaled by √horizon (random-walk variance), ± around the point projection.
 *
 * Returns `method: "recurring-only"` when there aren't enough snapshots
 * (<7 days) for the stochastic term; `"blended"` when both components
 * contributed.
 */
export type BalanceProjection = {
  current:        number;
  projected:      number;
  low:            number;
  high:           number;
  method:         "recurring-only" | "blended";
  horizonDays:    number;
  deterministic:  number;
  stochastic:     number;
};

export function projectBalance(
  account:     AccountRecord,
  snapshots:   AccountSnapshotRecord[],
  recurrings:  RecurringRecord[],
  horizonDays: number,
): BalanceProjection {
  const current = account.currentBalance ?? 0;
  const todayStr = todayIso();
  const horizonEnd = addDays(todayStr, horizonDays);

  // ── Deterministic: enumerate recurring occurrences in the window ──────
  const myRules = recurrings.filter((r) =>
    r.accountId === account.id && isRecurrenceLive(r),
  );
  const recurringDates = new Set<string>();
  let deterministic = 0;

  for (const rule of myRules) {
    const cadence = rule.cadence as Cadence;
    const seed = rule.nextDate ?? rule.startDate ?? todayStr;
    const anchor = rule.startDate ?? seed;
    const amount = rule.amount ?? 0;

    // Roll to first occurrence ≥ today
    let occ = nextOccurrence(seed, cadence, anchor);
    // Safety cap — cadence-based advance is always finite but defend anyway
    let guard = 0;
    while (occ <= horizonEnd && guard++ < 1000) {
      if (rule.endDate && occ > rule.endDate) break;
      deterministic += amount;
      recurringDates.add(occ);
      const next = advanceByCadence(occ, cadence, anchor);
      if (next <= occ) break;   // guard against stalls
      occ = next;
    }
  }

  // ── Stochastic: trailing non-recurring daily drift ────────────────────
  const mine = snapshots
    .filter((s) => s.accountId === account.id && s.date)
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

  // Build per-day net changes excluding days that had a recurring occurrence
  // (approximation: we only know recurring rule dates going forward; past
  // occurrences land on their `date`-matched days. If a rule's nextDate is
  // today, any past occurrences already fell on cadence-anchored days which
  // we don't enumerate backwards. For the trailing-30d drift the
  // overwhelming contribution is from ad-hoc transactions anyway; accept
  // the minor double-count risk on rule-anchored days.)
  const drifts: number[] = [];
  for (let i = 1; i < mine.length; i++) {
    const prev = mine[i - 1];
    const cur  = mine[i];
    if (!prev || !cur) continue;
    const d = (cur.balance ?? 0) - (prev.balance ?? 0);
    // Skip days whose tx activity looks like a recurring hit: use inflow/outflow
    // heuristic on the current row — if its flows exactly match an active
    // recurring amount, treat as recurring and skip.
    const flowToday = (cur.inflow ?? 0) - (cur.outflow ?? 0);
    const looksRecurring = myRules.some((r) =>
      Math.abs((r.amount ?? 0) - flowToday) < 0.01,
    );
    if (looksRecurring) continue;
    drifts.push(d);
  }

  let method: BalanceProjection["method"] = "recurring-only";
  let stochastic = 0;
  let stochasticStdev = 0;

  if (drifts.length >= 7) {
    method = "blended";
    const mean = drifts.reduce((s, v) => s + v, 0) / drifts.length;
    const variance = drifts.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, drifts.length - 1);
    stochasticStdev = Math.sqrt(variance);
    stochastic = mean * horizonDays;
  }

  const projected = current + deterministic + stochastic;
  const band = stochasticStdev * Math.sqrt(horizonDays);

  return {
    current:       round2(current),
    projected:     round2(projected),
    low:           round2(projected - band),
    high:          round2(projected + band),
    method,
    horizonDays,
    deterministic: round2(deterministic),
    stochastic:    round2(stochastic),
  };
}

/**
 * Whether we should surface a balance projection for this account type.
 * Brokerage / retirement projections are dominated by market noise — skip.
 */
export function isProjectableAccount(type: AccountRecord["type"]): boolean {
  if (type === "BROKERAGE") return false;
  if (type === "RETIREMENT") return false;
  return true;
}

/** Days from today to the last day of the current calendar year. */
export function daysToEOY(): number {
  const now = new Date();
  const eoy = new Date(now.getFullYear(), 11, 31);
  return Math.max(0, Math.ceil((eoy.getTime() - now.getTime()) / (24 * 3600 * 1000)));
}

/**
 * Rough months-until-zero for a credit card (or any drawing-down account).
 * Uses the 30-day projection to estimate monthly direction; returns null when
 * the account isn't trending toward zero (flat or diverging). Loans have a
 * dedicated `recalculateLoan` scenario and shouldn't use this.
 */
export function estimateTimeToZero(
  account:    AccountRecord,
  snapshots:  AccountSnapshotRecord[],
  recurrings: RecurringRecord[],
): { months: number; method: BalanceProjection["method"] } | null {
  const current = account.currentBalance ?? 0;
  if (Math.abs(current) < 0.01) return null;
  const proj = projectBalance(account, snapshots, recurrings, 30);
  const monthlyChange = proj.projected - current;
  // Trending toward zero required: negative current → positive change; positive current → negative change.
  if (current < 0 && monthlyChange <= 0.01) return null;
  if (current > 0 && monthlyChange >= -0.01) return null;
  const months = Math.ceil(Math.abs(current) / Math.abs(monthlyChange));
  // Clamp to a reasonable range so we don't display "in 412 years" for
  // microscopic pay-downs.
  if (!Number.isFinite(months) || months > 600) return null;
  return { months, method: proj.method };
}

/** Months remaining from today to a target date */
export function monthsUntil(isoDate: string): number {
  const today = new Date();
  const target = new Date(isoDate + "T12:00:00");
  return (
    (target.getFullYear() - today.getFullYear()) * 12 +
    (target.getMonth() - today.getMonth()) +
    (target.getDate() - today.getDate()) / 30
  );
}

/** Simple fingerprint for CSV dedup: base64(date|amount|description) */
export function importHash(date: string, amount: number, description: string): string {
  return btoa([date, amount.toFixed(2), description.trim().toLowerCase()].join("|"))
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 32);
}

// ── Colors ────────────────────────────────────────────────────────────────────

export function amountColor(amount: number): string {
  return amount >= 0 ? "#22c55e" : "#ef4444";
}

export function goalPctColor(pct: number): string {
  if (pct >= 1)    return "#22c55e";
  if (pct >= 0.6)  return FINANCE_COLOR;
  if (pct >= 0.3)  return "#f59e0b";
  return "#ef4444";
}

// ── Shared CSS ────────────────────────────────────────────────────────────────

export const inputCls =
  "w-full rounded-lg border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated px-3 py-1.5 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-400/50 transition";

export const labelCls =
  "block text-[11px] uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-1 font-medium";

// ── SaveButton ────────────────────────────────────────────────────────────────

export function SaveButton({
  saving, onSave, label = "Save",
}: { saving: boolean; onSave: () => void; label?: string }) {
  return (
    <button
      onClick={onSave}
      disabled={saving}
      className="w-full py-2 rounded-lg text-sm font-semibold disabled:opacity-50 transition-opacity hover:opacity-90"
      style={{ backgroundColor: FINANCE_COLOR, color: "#fff" }}
    >
      {saving ? "Saving…" : label}
    </button>
  );
}

// ── DeleteButton ──────────────────────────────────────────────────────────────

export function DeleteButton({
  saving, onDelete, label = "Delete",
}: { saving: boolean; onDelete: () => void; label?: string }) {
  return (
    <button
      onClick={onDelete}
      disabled={saving}
      className="w-full py-2 rounded-lg text-sm font-semibold border border-red-300 dark:border-red-800 text-red-500 dark:text-red-400 disabled:opacity-50 transition-colors hover:bg-red-50 dark:hover:bg-red-900/20"
    >
      {saving ? "Deleting…" : label}
    </button>
  );
}

// ── EmptyState ────────────────────────────────────────────────────────────────

export function EmptyState({ label, onAdd }: { label: string; onAdd?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3 text-gray-400">
      <p className="text-sm">No {label} yet</p>
      {onAdd && (
        <button
          onClick={onAdd}
          className="text-xs font-medium px-4 py-2 rounded-lg border border-gray-200 dark:border-darkBorder hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
          style={{ color: FINANCE_COLOR }}
        >
          + Add {label}
        </button>
      )}
    </div>
  );
}

// ── AccountBadge ──────────────────────────────────────────────────────────────

export function AccountBadge({ type }: { type: string | null | undefined }) {
  const label = type ? (ACCOUNT_TYPE_LABELS[type as AccountType] ?? type) : "Unknown";
  return (
    <span
      className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide"
      style={{ backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR }}
    >
      {label}
    </span>
  );
}

// ── StatusBadge ───────────────────────────────────────────────────────────────

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const isPosted = status === "POSTED";
  return (
    <span
      className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide"
      style={{
        backgroundColor: isPosted ? "#22c55e22" : "#f59e0b22",
        color:           isPosted ? "#22c55e"   : "#f59e0b",
      }}
    >
      {isPosted ? "Posted" : "Pending"}
    </span>
  );
}

// ── CSV import ────────────────────────────────────────────────────────────────

export type ParsedTransaction = {
  date:        string;   // YYYY-MM-DD
  description: string;
  amount:      number;   // positive = credit/income, negative = debit/expense
  category:    string;
  hash:        string;
};

type BankFormat = {
  name:   string;
  detect: (headers: string[]) => boolean;
  parse:  (row: Record<string, string>) => ParsedTransaction | null;
};

function toIso(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parts = raw.split("/");
  if (parts.length === 3) {
    const [m, d, y] = parts;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return raw;
}

function parseAmt(raw: string): number {
  return parseFloat(raw.replace(/[$,\s]/g, "")) || 0;
}

const BANK_FORMATS: BankFormat[] = [
  {
    name:   "Chase",
    detect: (h) => h.includes("Transaction Date") && h.includes("Post Date"),
    parse:  (row) => {
      const date = toIso(row["Transaction Date"] ?? "");
      if (!date) return null;
      // Chase CSV uses the same convention for checking and credit cards:
      // negative = money leaving you (debit/purchase), positive = money coming in (deposit/payment).
      // Matches our app convention, no flip needed.
      const amount      = parseAmt(row["Amount"] ?? "0");
      const description = row["Description"]?.trim() ?? "";
      return { date, description, amount, category: row["Category"]?.trim() ?? "", hash: importHash(date, amount, description) };
    },
  },
  {
    name:   "Bank of America",
    detect: (h) => h.includes("Posted Date") && h.includes("Reference Number"),
    parse:  (row) => {
      const date = toIso(row["Posted Date"] ?? "");
      if (!date) return null;
      const amount      = parseAmt(row["Amount"] ?? "0");
      const description = row["Payee"]?.trim() ?? "";
      return { date, description, amount, category: "", hash: importHash(date, amount, description) };
    },
  },
  {
    name:   "American Express",
    detect: (h) => h.includes("Date") && h.includes("Description") && h.includes("Amount") && !h.includes("Transaction Date"),
    parse:  (row) => {
      const date = toIso(row["Date"] ?? "");
      if (!date) return null;
      // NOTE: Amex historically exports charges as positive (opposite of Chase).
      // Flipping to match our convention (negative = money leaving). If import
      // produces opposite-signed results, remove the minus here — see TODO.
      const raw         = parseAmt(row["Amount"] ?? "0");
      const amount      = -raw;
      const description = row["Description"]?.trim() ?? "";
      return { date, description, amount, category: row["Category"]?.trim() ?? "", hash: importHash(date, raw, description) };
    },
  },
  {
    // Generic fallback
    name:   "Generic CSV",
    detect: (h) => h.some((c) => /date/i.test(c)) && h.some((c) => /amount/i.test(c)),
    parse:  (row) => {
      const dateKey = Object.keys(row).find((k) => /date/i.test(k)) ?? "";
      const amtKey  = Object.keys(row).find((k) => /amount/i.test(k)) ?? "";
      const descKey = Object.keys(row).find((k) => /desc|payee|memo|name/i.test(k)) ?? "";
      const date    = toIso(row[dateKey] ?? "");
      if (!date) return null;
      const amount      = parseAmt(row[amtKey] ?? "0");
      const description = row[descKey]?.trim() ?? "";
      return { date, description, amount, category: "", hash: importHash(date, amount, description) };
    },
  },
];

function splitCsvRow(row: string): string[] {
  const fields: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '"') { if (inQ && row[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (c === "," && !inQ) { fields.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  fields.push(cur.trim());
  return fields;
}

export function parseBankCsv(csvText: string): { format: string; rows: ParsedTransaction[] } {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { format: "Unknown", rows: [] };

  const headers = splitCsvRow(lines[0]).map((h) => h.replace(/^"|"$/g, "").trim());
  const fmt     = BANK_FORMATS.find((f) => f.detect(headers)) ?? BANK_FORMATS[BANK_FORMATS.length - 1];

  const rows: ParsedTransaction[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitCsvRow(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] ?? ""; });
    const parsed = fmt.parse(row);
    if (parsed) rows.push(parsed);
  }

  return { format: fmt.name, rows };
}
