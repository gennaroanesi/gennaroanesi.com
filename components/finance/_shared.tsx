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

// ── Record types ──────────────────────────────────────────────────────────────

export type AccountRecord     = Schema["financeAccount"]["type"];
export type TransactionRecord = Schema["financeTransaction"]["type"];
export type RecurringRecord   = Schema["financeRecurring"]["type"];
export type GoalRecord        = Schema["financeSavingsGoal"]["type"];
export type HoldingLotRecord  = Schema["financeHoldingLot"]["type"];
export type TickerQuoteRecord = Schema["financeTickerQuote"]["type"];
export type AssetRecord       = Schema["financeAsset"]["type"];
export type MilestoneRecord   = Schema["financeGoalMilestone"]["type"];

export type MilestoneStatus = "HIT" | "MISSED" | "PENDING";

// ── Enums / constants ─────────────────────────────────────────────────────────

export const ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "BROKERAGE", "RETIREMENT", "CREDIT", "CASH", "OTHER"] as const;
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

export const FINANCE_COLOR = "#10b981";

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  CHECKING:   "Checking",
  SAVINGS:    "Savings",
  BROKERAGE:  "Brokerage",
  RETIREMENT: "Retirement",
  CREDIT:     "Credit Card",
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
