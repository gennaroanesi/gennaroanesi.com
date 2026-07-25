/**
 * components/finance/constants.ts
 *
 * Enum/label constant tables (and their types) for the Finance section.
 * Split out of `_shared.tsx` (which re-exports everything here).
 * Pure module: no React, no Amplify client.
 */

import { FINANCE_ACCENT } from "@/lib/colors";
import type { TransactionRecord } from "./finance-core";

export const PAYCHECK_PERSONS = ["ME", "SPOUSE"] as const;
export type  PaycheckPerson    = (typeof PAYCHECK_PERSONS)[number];

// Person labels are the displayed names. The enum values (ME/SPOUSE) stay
// neutral so the schema and any downstream tools don't bake in personal
// names. If the labels need to change again, edit only this map.
export const PAYCHECK_PERSON_LABELS: Record<PaycheckPerson, string> = {
  ME:     "Gennaro",
  SPOUSE: "Cristine",
};

export type PaycheckLineItem = {
  name:   string;
  amount: number;
  ytd?:   number | null;
  type:   "PRETAX" | "POSTTAX" | "IMPUTED" | "EMPLOYER_PAID" | "EARNING" | "OTHER";
};

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
// isInvestedAccount lives in finance-core (re-exported at the top of this file).

// Accounts that hold a positive balance you own (vs. CREDIT/LOAN liabilities,
// which are legitimately negative). Their projected balance is floored at 0 —
// you run out of money, you don't overdraw into the red.
export const ASSET_ACCOUNT_TYPES = new Set<string>(["CHECKING", "SAVINGS", "BROKERAGE", "RETIREMENT", "CASH"]);

export const TX_TYPES    = ["INCOME", "EXPENSE", "TRANSFER", "BUY", "SELL"] as const;
export type  TxType      = (typeof TX_TYPES)[number];

/** BUY/SELL are brokerage trade events that mutate a financeHoldingLot. */
export function isTradeType(type: TxType | string | null | undefined): boolean {
  return type === "BUY" || type === "SELL";
}

/**
 * Realized gain on a SELL transaction. proceeds − consumedCostBasis.
 * Returns null for non-SELL rows or when consumedCostBasis is missing.
 */
export function realizedGain(tx: TransactionRecord): number | null {
  if (tx.type !== "SELL") return null;
  if (tx.consumedCostBasis == null) return null;
  return (tx.amount ?? 0) - tx.consumedCostBasis;
}

/** Snapshot of one lot's contribution to a multi-lot SELL. */
export type LotConsumption = { lotId: string; qty: number; costBasis: number };

/** Parse the lotConsumptions JSON snapshot on a SELL transaction. Returns [] when absent or malformed. */
export function parseLotConsumptions(tx: TransactionRecord): LotConsumption[] {
  const raw = (tx as any).lotConsumptions as string | null | undefined;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

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

// Finance section accent. Single source of truth lives in lib/colors; kept as
// FINANCE_COLOR here for the many existing call sites.
export const FINANCE_COLOR = FINANCE_ACCENT;

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
