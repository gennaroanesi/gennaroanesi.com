/**
 * components/finance/_shared.tsx
 *
 * Shared UI primitives for the Finance section, plus the barrel that
 * re-exports the focused finance modules (data, constants, format,
 * loans-math, projection, csv-parsers, quotes, recurring-match) so the rest
 * of the app keeps importing everything from
 * "@/components/finance/_shared" as before.
 * Mirrors the pattern established in components/inventory/_shared.tsx.
 */

import React from "react";
import { INPUT_BASE, LABEL_CLASS, Badge } from "@/components/common/ui";
import { POSITIVE, WARNING } from "@/lib/colors";
import { ACCOUNT_TYPE_LABELS, FINANCE_COLOR, type AccountType } from "./constants";

// Pure finance math lives in finance-core (no React/client) so the
// financeSnapshots Lambda and the review page can import it too. Re-exported
// so the rest of the app keeps importing them from
// "@/components/finance/_shared" as before.
export {
  isInvestedAccount,
  isLotVested,
  buildQuoteMap,
  tickerAggregate,
  uniqueTickers,
  accountTotalValue,
  computeGoalAllocations,
  effectiveGoalAmount,
  goalHasFundingSource,
  goalHasVolatileFunding,
} from "./finance-core";
export type { QuoteMap, TickerAggregate, GoalAllocationResult } from "./finance-core";

// ── Split modules ─────────────────────────────────────────────────────────────
// Everything below used to live in this file; it now lives in focused modules.
// Re-export the full surface so no import site outside components/finance/
// needs to change.
export * from "./data";
export * from "./constants";
export * from "./format";
export * from "./loans-math";
export * from "./projection";
export * from "./csv-parsers";
export * from "./quotes";
export * from "./recurring-match";

// ── Shared CSS ────────────────────────────────────────────────────────────────

// Canonical field structure lives in components/common/ui; finance keeps its
// emerald focus-ring accent.
export const inputCls = `${INPUT_BASE} focus:ring-emerald-400/50`;
export const labelCls = LABEL_CLASS;

// ── SaveButton ────────────────────────────────────────────────────────────────

export function SaveButton({
  saving, onSave, label = "Save", disabled = false,
}: { saving: boolean; onSave: () => void; label?: string; disabled?: boolean }) {
  return (
    <button
      onClick={onSave}
      disabled={saving || disabled}
      className="w-full py-2 rounded-lg text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-opacity hover:opacity-90"
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
    <Badge color={isPosted ? POSITIVE : WARNING}>
      {isPosted ? "Posted" : "Pending"}
    </Badge>
  );
}
