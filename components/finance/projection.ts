/**
 * components/finance/projection.ts
 *
 * Balance / goal / net-worth projection math for the Finance section, plus the
 * asset and milestone helpers that feed those projections.
 * Split out of `_shared.tsx` (which re-exports everything here).
 * Pure module: no React, no Amplify client (record types are type-only imports).
 */

import { isInvestedAccount, isLotVested } from "./finance-core";
import type { QuoteMap } from "./finance-core";
import { ASSET_ACCOUNT_TYPES, type Cadence, type MilestoneStatus } from "./constants";
import {
  addDays,
  advanceByCadence,
  isRecurrenceLive,
  nextOccurrence,
  round2,
  todayIso,
} from "./format";
import type {
  AccountRecord,
  AccountSnapshotRecord,
  AssetRecord,
  GoalRecord,
  HoldingLotRecord,
  LoanPaymentRecord,
  LoanRecord,
  MilestoneRecord,
  RecurringRecord,
  TransactionRecord,
} from "./data";

// ── Holdings ───────────────────────────────────────────────────────────────────────────────
// QuoteMap, buildQuoteMap, TickerAggregate, isLotVested, tickerAggregate,
// uniqueTickers, and accountTotalValue live in finance-core (re-exported at the
// top of this file). unvestedValueByHorizon stays here as it's UI-only.

/**
 * Value of an account's unvested lots scheduled to vest by `horizonIso` (YYYY-MM-DD inclusive).
 * Used by net-worth projections so RSUs that vest before the horizon contribute to the
 * projected number even though they don't count today. Lots without a vestDate are
 * excluded — they're indeterminate and shouldn't silently inflate the projection.
 */
export function unvestedValueByHorizon(
  acc: AccountRecord,
  lots: HoldingLotRecord[] = [],
  quotes: QuoteMap = new Map(),
  horizonIso: string,
): number {
  if (!isInvestedAccount(acc.type)) return 0;
  const myLots = lots.filter(
    (l) => l.accountId === acc.id
      && !isLotVested(l)
      && !!l.vestDate
      && (l.vestDate as string) <= horizonIso,
  );
  return myLots.reduce((s, l) => {
    const q = quotes.get((l.ticker ?? "").toUpperCase());
    if (!q?.price) return s;
    return s + (l.quantity ?? 0) * q.price;
  }, 0);
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
// GoalAllocationResult, computeGoalAllocations, effectiveGoalAmount,
// goalHasVolatileFunding, and goalHasFundingSource live in finance-core
// (re-exported at the top of this file).

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
  /** Mean estimate: current + deterministic + mean×horizon. Honest central value. */
  projected:      number;
  /** Conservative floor — there's ~80% probability the realized EOY balance is ≥ this.
   *  Computed as projected − z_0.20 × σ × √horizon, where σ is the sample stddev of
   *  daily drift. Callers that want to "err on the conservative side" display this. */
  conservative:   number;
  /** Optimistic ceiling — ~80% probability realized is ≤ this. Symmetric counterpart. */
  optimistic:     number;
  /** ±1σ band (≈P16/P84). Useful as a secondary "typical range" hint. */
  low:            number;
  high:           number;
  method:         "recurring-only" | "blended" | "cohort" | "amortization";
  horizonDays:    number;
  deterministic:  number;
  stochastic:     number;
};

// Z-score for 80/20 confidence. ≈ 0.8416 on a standard normal, so subtracting
// 0.8416×σ from the mean gives the 20th percentile (P20).
const Z_P20 = 0.8416;

function daysBetweenIso(aIso: string, bIso: string): number {
  const a = new Date(aIso + "T12:00:00").getTime();
  const b = new Date(bIso + "T12:00:00").getTime();
  return Math.round((b - a) / (24 * 3600 * 1000));
}

/**
 * Credit-card projection using payment-bounded cohorts instead of trailing
 * daily drift. For revolving cards the natural unit isn't a calendar day —
 * it's a billing cycle: a stretch of purchases (negative tx) closed by a
 * payment (positive tx). Per cycle, delta = Σ(purchases) + payment, which
 * is the *carryover* — typically ~0 for autopay-in-full, negative when
 * carrying a balance. Average that across the last N cycles, multiply by
 * cycles-to-horizon, project. Ceiling clamped at 0 (a credit card can't
 * realistically run a positive balance).
 *
 * Falls back to caller (returns null) when there aren't ≥2 payments in
 * trailing data — no cohort can be formed.
 */
function projectCreditCohorts(
  account:      AccountRecord,
  transactions: TransactionRecord[],
  horizonDays:  number,
  maxCohorts:   number,
): BalanceProjection | null {
  const current = account.currentBalance ?? 0;

  // Sort POSTED tx for this account ascending. Payments = positive amount.
  const myTxs = transactions
    .filter((t) => t.accountId === account.id && t.status !== "PENDING" && t.date)
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const paymentIdx: number[] = [];
  myTxs.forEach((t, i) => { if ((t.amount ?? 0) > 0) paymentIdx.push(i); });
  if (paymentIdx.length < 2) return null;

  // Each cohort spans (prev payment, current payment] — trailing payment closes.
  const startCohort = Math.max(1, paymentIdx.length - maxCohorts);
  const cohorts: { delta: number; days: number }[] = [];
  for (let k = startCohort; k < paymentIdx.length; k++) {
    const fromIdx = paymentIdx[k - 1] + 1;
    const toIdx   = paymentIdx[k];
    let delta = 0;
    for (let j = fromIdx; j <= toIdx; j++) delta += myTxs[j].amount ?? 0;
    const days = daysBetweenIso(myTxs[paymentIdx[k - 1]].date!, myTxs[toIdx].date!);
    cohorts.push({ delta, days });
  }
  if (cohorts.length === 0) return null;

  const avgDelta = cohorts.reduce((s, c) => s + c.delta, 0) / cohorts.length;
  const avgDays  = cohorts.reduce((s, c) => s + c.days,  0) / cohorts.length;
  const cycles   = avgDays > 0 ? horizonDays / avgDays : 0;

  const variance = cohorts.length > 1
    ? cohorts.reduce((s, c) => s + (c.delta - avgDelta) ** 2, 0) / (cohorts.length - 1)
    : 0;
  const cohortStdev = Math.sqrt(variance);
  // Sum-over-N: scale by √cycles for the band on the projected total.
  const scaledStdev = cohortStdev * Math.sqrt(Math.max(0, cycles));
  const pad  = Z_P20 * scaledStdev;
  const band = scaledStdev;

  const stochastic = avgDelta * cycles;
  const projectedRaw = current + stochastic;
  // Ceiling: credit cards can't realistically carry a positive balance.
  // Clamp every output channel at ≤ 0 so the mean / band / extremes all
  // respect the ceiling. `conservative` (worst case = most debt) is already
  // ≤ projected so it almost never hits the cap, but the clamp is symmetric
  // to keep the invariant low ≤ projected ≤ high after capping.
  const cap = (n: number) => Math.min(0, n);

  return {
    current:       round2(current),
    projected:     round2(cap(projectedRaw)),
    conservative:  round2(cap(projectedRaw - pad)),
    optimistic:    round2(cap(projectedRaw + pad)),
    low:           round2(cap(projectedRaw - band)),
    high:          round2(cap(projectedRaw + band)),
    method:        "cohort",
    horizonDays,
    deterministic: 0,
    stochastic:    round2(stochastic),
  };
}

/**
 * Loan-account projection from amortization schedule. The financeLoanPayment
 * SCHEDULED rows are the deterministic forward path — no need for stochastic
 * drift on top. Sum principal portions whose `date` lands in (today, horizon]
 * and shift the (negative) account balance toward 0 by that amount.
 *
 * Returns null when no scheduled payments exist (caller falls back).
 */
function projectLoanAmortization(
  account:      AccountRecord,
  loans:        LoanRecord[],
  loanPayments: LoanPaymentRecord[],
  horizonDays:  number,
): BalanceProjection | null {
  const current = account.currentBalance ?? 0;
  const todayStr = todayIso();
  const horizonEnd = addDays(todayStr, horizonDays);

  const loan = loans.find((l) => l.accountId === account.id);
  if (!loan) return null;

  const upcoming = loanPayments.filter(
    (p) => p.loanId === loan.id
      && p.status === "SCHEDULED"
      && p.date
      && p.date > todayStr
      && p.date <= horizonEnd,
  );
  if (upcoming.length === 0) return null;

  const principalSum = upcoming.reduce((s, p) => s + (p.principal ?? 0), 0);
  // Loan account.currentBalance is negative (debt). Each principal payment
  // pushes it toward 0 (less negative). Ceiling at 0 (loan paid off).
  const projected = Math.min(0, current + principalSum);

  return {
    current:       round2(current),
    projected:     round2(projected),
    conservative:  round2(projected),
    optimistic:    round2(projected),
    low:           round2(projected),
    high:          round2(projected),
    method:        "amortization",
    horizonDays,
    deterministic: round2(principalSum),
    stochastic:    0,
  };
}

export function projectBalance(
  account:      AccountRecord,
  snapshots:    AccountSnapshotRecord[],
  recurrings:   RecurringRecord[],
  transactions: TransactionRecord[],
  horizonDays:  number,
  loans:        LoanRecord[]        = [],
  loanPayments: LoanPaymentRecord[] = [],
): BalanceProjection {
  // CREDIT cards: cohort method (last 8 cycles), ceiling at 0. Falls
  // through to the legacy blended path when fewer than 2 payments exist.
  if (account.type === "CREDIT") {
    const cohort = projectCreditCohorts(account, transactions, horizonDays, 8);
    if (cohort) return cohort;
  }

  // LOAN: deterministic from SCHEDULED amortization rows. Falls through
  // to the blended path when no schedule is available (legacy import or
  // post-import correction state).
  if (account.type === "LOAN") {
    const amort = projectLoanAmortization(account, loans, loanPayments, horizonDays);
    if (amort) return amort;
  }

  const current = account.currentBalance ?? 0;
  const todayStr = todayIso();
  const horizonEnd = addDays(todayStr, horizonDays);

  // ── Deterministic: enumerate recurring occurrences in the window ──────
  // A rule affects this account either as its source (accountId → apply amount)
  // or, for a TRANSFER, as its destination (toAccountId → apply the opposite
  // amount = money in). Pair each rule with its signed effect on THIS account.
  const myRules = recurrings
    .filter((r) => isRecurrenceLive(r) && (
      r.accountId === account.id || (r.type === "TRANSFER" && r.toAccountId === account.id)
    ))
    .map((r) => ({
      rule: r,
      // A TRANSFER moves |amount| out of its source and into its destination —
      // magnitude-based so a mis-signed stored amount can't invert the direction.
      effAmount: r.type === "TRANSFER"
        ? (r.toAccountId === account.id ? Math.abs(r.amount ?? 0) : -Math.abs(r.amount ?? 0))
        : (r.amount ?? 0),
    }));
  const recurringDates = new Set<string>();
  let deterministic = 0;

  for (const { rule, effAmount: amount } of myRules) {
    const cadence = rule.cadence as Cadence;
    const seed = rule.nextDate ?? rule.startDate ?? todayStr;

    // Roll to first occurrence ≥ today. Anchor follows the current value
    // so manual edits to nextDate carry forward instead of snapping back
    // to the original startDate anchor day.
    let occ = nextOccurrence(seed, cadence);
    // Safety cap — cadence-based advance is always finite but defend anyway
    let guard = 0;
    while (occ <= horizonEnd && guard++ < 1000) {
      if (rule.endDate && occ > rule.endDate) break;
      deterministic += amount;
      recurringDates.add(occ);
      const next = advanceByCadence(occ, cadence);
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
      Math.abs((r.effAmount ?? 0) - flowToday) < 0.01,
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
  // Sum-over-N random walk: variance scales with N, stddev with √N.
  const scaledStdev = stochasticStdev * Math.sqrt(horizonDays);
  const band = scaledStdev;            // ±1σ (P16/P84)
  const pad  = Z_P20 * scaledStdev;    // ±0.84σ (P20/P80)

  // Asset accounts can't realistically go negative — you run out of money, you
  // don't overdraw savings into the red — so floor their projection at 0. A
  // net-negative trailing drift would otherwise carry the point estimate (and
  // its conservative band) straight through zero. CREDIT/LOAN are liabilities
  // and legitimately negative; they normally return above via the cohort /
  // amortization paths, but a data-poor one can fall through here, so gate on
  // type rather than clamping unconditionally.
  const floor = ASSET_ACCOUNT_TYPES.has(account.type ?? "") ? 0 : -Infinity;
  const clamp = (v: number) => round2(Math.max(floor, v));

  return {
    current:       round2(current),
    projected:     clamp(projected),
    conservative:  clamp(projected - pad),
    optimistic:    clamp(projected + pad),
    low:           clamp(projected - band),
    high:          clamp(projected + band),
    method,
    horizonDays,
    deterministic: round2(deterministic),
    stochastic:    round2(stochastic),
  };
}

/**
 * Whether we should surface a balance projection for this account type.
 * - BROKERAGE / RETIREMENT: dominated by market noise, skip.
 * - CHECKING: pass-through float, not an accumulating balance — the
 *   extrapolated "EOY" is rarely meaningful (money in, money out, roughly
 *   breakeven). Skip.
 * Savings, credit, loan, cash do get projections.
 */
export function isProjectableAccount(type: AccountRecord["type"]): boolean {
  if (type === "BROKERAGE") return false;
  if (type === "RETIREMENT") return false;
  if (type === "CHECKING") return false;
  return true;
}

/**
 * Rough months-until-zero for a credit card (or any drawing-down account).
 * Uses the 30-day projection to estimate monthly direction; returns null when
 * the account isn't trending toward zero (flat or diverging). Loans have a
 * dedicated `recalculateLoan` scenario and shouldn't use this.
 */
export function estimateTimeToZero(
  account:      AccountRecord,
  snapshots:    AccountSnapshotRecord[],
  recurrings:   RecurringRecord[],
  transactions: TransactionRecord[],
  loans:        LoanRecord[]        = [],
  loanPayments: LoanPaymentRecord[] = [],
): { months: number; method: BalanceProjection["method"] } | null {
  const current = account.currentBalance ?? 0;
  if (Math.abs(current) < 0.01) return null;
  const proj = projectBalance(account, snapshots, recurrings, transactions, 30, loans, loanPayments);
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
