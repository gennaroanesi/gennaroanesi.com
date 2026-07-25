/**
 * components/finance/format.ts
 *
 * Formatting, date/cadence, and display-color helpers for the Finance section.
 * Split out of `_shared.tsx` (which re-exports everything here).
 * Pure module: no React, no Amplify client (record types are type-only imports).
 */

import { POSITIVE, NEGATIVE, WARNING } from "@/lib/colors";
import { FINANCE_COLOR, type Cadence } from "./constants";
import type { RecurringRecord } from "./data";

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

export function addDays(isoDate: string, n: number): string {
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

// ── Amount-sign convention ──────────────────────────────────────────────────
// One canonical rule for how a signed `amount` relates to its transaction/rule
// type, so the finance forms can normalize on blur instead of trusting the user
// to remember the minus sign:
//   INCOME / SELL      → positive (money in)
//   EXPENSE / BUY      → negative (money out)
//   TRANSFER           → positive magnitude (direction comes from from→to)
// Anything else is left as typed.
export function normalizeAmountSign(amount: number, type: string | null | undefined): number {
  if (!Number.isFinite(amount)) return amount;
  const mag = Math.abs(amount);
  switch (type) {
    case "INCOME":
    case "SELL":
    case "TRANSFER":
      return mag;
    case "EXPENSE":
    case "BUY":
      return -mag;
    default:
      return amount;
  }
}

/** Round to 2 decimal places (avoid 0.1 + 0.2 = 0.30000000000000004). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Days from today to the last day of the current calendar year. */
export function daysToEOY(): number {
  const now = new Date();
  const eoy = new Date(now.getFullYear(), 11, 31);
  return Math.max(0, Math.ceil((eoy.getTime() - now.getTime()) / (24 * 3600 * 1000)));
}

/** YYYY-MM-DD for the last day of the current calendar year. */
export function eoyIso(): string {
  return `${new Date().getFullYear()}-12-31`;
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

// ── Colors ────────────────────────────────────────────────────────────────────

export function amountColor(amount: number): string {
  return amount >= 0 ? POSITIVE : NEGATIVE;
}

export function goalPctColor(pct: number): string {
  if (pct >= 1)    return POSITIVE;
  if (pct >= 0.6)  return FINANCE_COLOR;
  if (pct >= 0.3)  return WARNING;
  return NEGATIVE;
}
