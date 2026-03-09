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

// ── Enums / constants ─────────────────────────────────────────────────────────

export const ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "BROKERAGE", "CREDIT", "CASH", "OTHER"] as const;
export type  AccountType   = (typeof ACCOUNT_TYPES)[number];

export const TX_TYPES    = ["INCOME", "EXPENSE", "TRANSFER"] as const;
export type  TxType      = (typeof TX_TYPES)[number];

export const TX_STATUSES = ["POSTED", "PENDING"] as const;
export type  TxStatus    = (typeof TX_STATUSES)[number];

export const CADENCES    = ["WEEKLY", "BIWEEKLY", "MONTHLY", "ANNUALLY"] as const;
export type  Cadence     = (typeof CADENCES)[number];

export const FINANCE_COLOR = "#10b981";

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  CHECKING:  "Checking",
  SAVINGS:   "Savings",
  BROKERAGE: "Brokerage",
  CREDIT:    "Credit Card",
  CASH:      "Cash",
  OTHER:     "Other",
};

export const CADENCE_LABELS: Record<Cadence, string> = {
  WEEKLY:   "Weekly",
  BIWEEKLY: "Bi-weekly",
  MONTHLY:  "Monthly",
  ANNUALLY: "Annually",
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

/** Advance a date by N months, returning YYYY-MM-DD */
export function addMonths(isoDate: string, n: number): string {
  const d = new Date(isoDate + "T12:00:00");
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

function addDays(isoDate: string, n: number): string {
  const d = new Date(isoDate + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Next occurrence >= today given a cadence and current nextDate */
export function nextOccurrence(nextDate: string, cadence: Cadence): string {
  const today = todayIso();
  let cur = nextDate;
  while (cur < today) {
    switch (cadence) {
      case "WEEKLY":   cur = addDays(cur, 7);    break;
      case "BIWEEKLY": cur = addDays(cur, 14);   break;
      case "MONTHLY":  cur = addMonths(cur, 1);  break;
      case "ANNUALLY": cur = addMonths(cur, 12); break;
    }
  }
  return cur;
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
      const raw         = parseAmt(row["Amount"] ?? "0");
      const amount      = -raw; // Chase: negative = expense
      const description = row["Description"]?.trim() ?? "";
      return { date, description, amount, category: row["Category"]?.trim() ?? "", hash: importHash(date, raw, description) };
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
      const raw         = parseAmt(row["Amount"] ?? "0");
      const amount      = -raw; // Amex: positive = charge
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
