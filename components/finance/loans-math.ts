/**
 * components/finance/loans-math.ts
 *
 * Loan amortization + recalculation engine for the Finance section.
 * Split out of `_shared.tsx` (which re-exports everything here).
 * Pure module: no React, no Amplify client (record types are type-only imports).
 */

import { monthsUntil, round2, todayIso } from "./format";
import type { LoanPaymentRecord, LoanRecord } from "./data";

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
  // Months from today to the loan's contractual payoff date. Rounded up —
  // a "partial month remaining" isn't a meaningful user-facing figure and
  // the amortization formula needs an integer anyway.
  const firstPay   = loan.firstPaymentDate ?? loan.startDate ?? todayIso();
  const totalTerm  = loan.termMonths ?? 0;
  const payoffOrig = addMonthsIso(firstPay, Math.max(0, totalTerm - 1));
  const monthsLeftOrig = Math.max(1, Math.ceil(monthsUntil(payoffOrig)));
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
