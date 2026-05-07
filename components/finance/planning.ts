/**
 * Long-term planning math — paycheck deduction chain + multi-year salary
 * trajectory. Used by the Planning simulator. Standalone from the live
 * finance models (no DB reads, no projections). Pure functions only.
 *
 * ── Tax constants ────────────────────────────────────────────────────────
 * Federal brackets, standard deductions, OASDI cap, and Medicare rates are
 * IRS values for tax year 2025 (Rev. Proc. 2024-40). Refresh annually when
 * the IRS publishes the next year's revenue procedure (typically October /
 * November of the prior year). Withholding on far-future years (2030+) is
 * inherently approximate either way — these constants are the model's
 * baseline, not a forecast of bracket creep.
 *
 * ── Withholding model ────────────────────────────────────────────────────
 * Pub 15-T percentage method on annualized taxable wage minus the standard
 * deduction. Approximate; W-4 step 4 adjustments are not modeled. Use the
 * `extraWithholdingPerCheck` field to fine-tune.
 */

// ── Filing status ─────────────────────────────────────────────────────────

export const FILING_STATUSES = ["SINGLE", "MFJ"] as const;
export type  FilingStatus    = (typeof FILING_STATUSES)[number];

export const FILING_STATUS_LABELS: Record<FilingStatus, string> = {
  SINGLE: "Single",
  MFJ:    "Married filing jointly",
};

// ── Tax year 2025 constants ──────────────────────────────────────────────

type Bracket = { rate: number; upTo: number };

const FED_BRACKETS_2025: Record<FilingStatus, Bracket[]> = {
  SINGLE: [
    { rate: 0.10, upTo:  11925 },
    { rate: 0.12, upTo:  48475 },
    { rate: 0.22, upTo: 103350 },
    { rate: 0.24, upTo: 197300 },
    { rate: 0.32, upTo: 250525 },
    { rate: 0.35, upTo: 626350 },
    { rate: 0.37, upTo: Infinity },
  ],
  MFJ: [
    { rate: 0.10, upTo:  23850 },
    { rate: 0.12, upTo:  96950 },
    { rate: 0.22, upTo: 206700 },
    { rate: 0.24, upTo: 394600 },
    { rate: 0.32, upTo: 501050 },
    { rate: 0.35, upTo: 751600 },
    { rate: 0.37, upTo: Infinity },
  ],
};

const STANDARD_DEDUCTION_2025: Record<FilingStatus, number> = {
  SINGLE: 15000,
  MFJ:    30000,
};

const OASDI_CAP_2025                 = 176100;
const OASDI_RATE                     = 0.062;
const MEDICARE_RATE                  = 0.0145;
const ADDITIONAL_MEDICARE_RATE       = 0.009;
const ADDITIONAL_MEDICARE_THRESHOLD  = 200000; // employer-side trigger; not filing-status-dependent

// IRS supplemental wage flat rate (Pub 15, Section 7) — applies to bonuses /
// RSU vesting / commissions up to $1M cumulative per employer per year.
// Above $1M, the rate jumps to 37%; the planner does not model that step.
const SUPPLEMENTAL_FED_RATE = 0.22;

export const PLAN_TAX_YEAR_LABEL = "2025 IRS rates";

// ── YearMap: sparse year→value with carry-forward lookup ─────────────────

export type YearMap = Record<number, number>;

// Returns the value for `year` from a sparse YearMap. Latest entry whose
// year is ≤ target wins; if none, returns `fallback`. Used so the user can
// say "set 401k % to 10% in 2026, 12% in 2029" without having to fill every
// year in between.
export function valueAtYear(byYear: YearMap, year: number, fallback: number): number {
  let best = fallback;
  let bestYear = -Infinity;
  for (const k of Object.keys(byYear)) {
    const y = Number(k);
    if (!Number.isFinite(y) || y > year || y <= bestYear) continue;
    best = byYear[y];
    bestYear = y;
  }
  return best;
}

// ── Salary trajectory ────────────────────────────────────────────────────

export type SalaryJump = {
  year:  number;
  amount: number;
  label?: string;
};

export type SalaryTrajectory = {
  baseYear:         number;   // first year of the plan
  baseAmount:       number;   // starting annual salary
  defaultGrowthPct: number;   // 0.06 = 6% applied to non-jump years
  jumps:            SalaryJump[];
};

// Walks the trajectory year-by-year, applying jumps where defined and
// `defaultGrowthPct` otherwise. Returns the salary for `year`. Years before
// `baseYear` return `baseAmount` (no historical projection).
export function salaryAtYear(s: SalaryTrajectory, year: number): number {
  if (year <= s.baseYear) return s.baseAmount;
  const jumps = new Map(s.jumps.map((j) => [j.year, j.amount]));
  let cur = s.baseAmount;
  for (let y = s.baseYear + 1; y <= year; y++) {
    const jump = jumps.get(y);
    if (jump != null) cur = jump;
    else              cur = cur * (1 + s.defaultGrowthPct);
  }
  return cur;
}

// ── Paycheck params ──────────────────────────────────────────────────────

export type PaycheckParams = {
  paychecksPerYear: number;          // 26 for biweekly, 24 for semimonthly
  filingStatus:     FilingStatus;
  contrib401kPct:           YearMap; // 0.10 = 10%
  contribAfterTaxPct:       YearMap;
  impGtlPerCheck:           number;  // imputed group-term life income; phantom
  medicalPerCheck:          YearMap;
  dentalPerCheck:           number;
  visionPerCheck:           number;
  loan401kPerCheck:         number;
  loan401kEndYear:          number | null; // inclusive; null = ongoing
  extraWithholdingPerCheck: YearMap;
};

// ── Spending ─────────────────────────────────────────────────────────────

export type SpendCategory = {
  id:     string;
  label:  string;
  byYear: YearMap; // annual amount (sign per user convention; expenses negative)
};

// ── Scenario ─────────────────────────────────────────────────────────────

export type PlanScenario = {
  id:           string;
  name:         string;
  startYear:    number;
  horizonYears: number;
  salary:       SalaryTrajectory;
  paycheck:     PaycheckParams;
  // Supplemental wages — annual lump sums taxed via the IRS supplemental
  // wage method (22% flat federal + remaining OASDI cap headroom +
  // Medicare). Optional in the persisted shape so older scenarios saved
  // before these fields were added still load cleanly.
  bonusByYear?:  YearMap;
  stocksByYear?: YearMap;
  spend:        SpendCategory[];
};

// ── Bracket math ─────────────────────────────────────────────────────────

function bracketTax(brackets: Bracket[], income: number): number {
  if (income <= 0) return 0;
  let tax = 0;
  let prev = 0;
  for (const b of brackets) {
    if (income <= b.upTo) {
      tax += (income - prev) * b.rate;
      return tax;
    }
    tax += (b.upTo - prev) * b.rate;
    prev = b.upTo;
  }
  return tax;
}

// ── Per-year paycheck breakdown ──────────────────────────────────────────

export type YearBreakdown = {
  year:                 number;
  annualSalary:         number;
  // Per-paycheck values (informational; matches the spreadsheet's column shape)
  grossPaycheck:        number;
  contrib401kPerCheck:  number;
  premiumsPerCheck:     number;
  impGtlPerCheck:       number;
  taxableWagePerCheck:  number;
  fedWhPerCheck:        number;
  oasdiPerCheck:        number;
  medicarePerCheck:     number;
  extraWhPerCheck:      number;
  postTaxPerCheck:      number;
  loan401kPerCheck:     number;
  afterTax401kPerCheck: number;
  netPaycheck:          number;
  // Annual rollups for the regular paycheck stream
  annual401k:           number;
  annualAfterTax401k:   number;
  annualSalaryNet:      number;
  annualExtraWh:        number;
  // Supplemental wages (bonus + RSU vesting)
  bonusGross:           number;
  stocksGross:          number;
  supplementalFedWh:    number;
  supplementalOasdi:    number;
  supplementalMedicare: number;
  supplementalNet:      number;
  // Bottom line: salary take-home + supplemental net
  annualNet:            number;
};

export function projectYear(scenario: PlanScenario, year: number): YearBreakdown {
  const p = scenario.paycheck;
  const ppy = Math.max(1, p.paychecksPerYear);

  const annualSalary = salaryAtYear(scenario.salary, year);

  // Rates / dollar amounts that may vary by year, looked up with carry-forward.
  const pct401k    = valueAtYear(p.contrib401kPct,           year, 0);
  const pctAft     = valueAtYear(p.contribAfterTaxPct,       year, 0);
  const medical    = valueAtYear(p.medicalPerCheck,          year, 0);
  const extraWh    = valueAtYear(p.extraWithholdingPerCheck, year, 0);

  const loanActive = p.loan401kEndYear == null ? true : year <= p.loan401kEndYear;
  const loan401k   = loanActive ? p.loan401kPerCheck : 0;

  // Annual aggregates first — withholding is computed on annualized taxable
  // wage, which is the correct base for percentage-method bracket math even
  // though we surface per-paycheck slices for display.
  const grossAnnual         = annualSalary;
  const contrib401kAnnual   = grossAnnual * pct401k;
  const contribAfterAnnual  = grossAnnual * pctAft;
  const premiumsAnnual      = (medical + p.dentalPerCheck + p.visionPerCheck) * ppy;
  const impGtlAnnual        = p.impGtlPerCheck * ppy;
  const taxableAnnual       = grossAnnual + impGtlAnnual - contrib401kAnnual - premiumsAnnual;

  const stdDeduction = STANDARD_DEDUCTION_2025[p.filingStatus];
  const fedWhAnnual  = bracketTax(FED_BRACKETS_2025[p.filingStatus], Math.max(0, taxableAnnual - stdDeduction));

  const oasdiBase    = Math.min(taxableAnnual, OASDI_CAP_2025);
  const oasdiAnnual  = Math.max(0, oasdiBase) * OASDI_RATE;
  const medicareAnnual =
    Math.max(0, taxableAnnual) * MEDICARE_RATE +
    Math.max(0, taxableAnnual - ADDITIONAL_MEDICARE_THRESHOLD) * ADDITIONAL_MEDICARE_RATE;

  const extraAnnual  = extraWh * ppy;
  const loanAnnual   = loan401k * ppy;

  const postTaxAnnual    = taxableAnnual - fedWhAnnual - oasdiAnnual - medicareAnnual - extraAnnual;
  const annualSalaryNet  = postTaxAnnual - loanAnnual - contribAfterAnnual;

  // ── Supplemental wages: bonus + RSU vesting ────────────────────────────
  const bonusGross       = valueAtYear(scenario.bonusByYear  ?? {}, year, 0);
  const stocksGross      = valueAtYear(scenario.stocksByYear ?? {}, year, 0);
  const supplementalGross = bonusGross + stocksGross;

  const supplementalFedWh = supplementalGross * SUPPLEMENTAL_FED_RATE;
  // OASDI applies only to cap headroom not already consumed by salary.
  // Using `taxableAnnual` as the salary OASDI base matches the simplified
  // calc above (which doesn't separately track Medicare/OASDI wages from
  // federal taxable wages).
  const oasdiHeadroom    = Math.max(0, OASDI_CAP_2025 - Math.max(0, taxableAnnual));
  const supplementalOasdi = Math.max(0, Math.min(supplementalGross, oasdiHeadroom)) * OASDI_RATE;
  // Medicare: 1.45% on the supplemental, plus 0.9% additional only on the
  // combined comp portion above $200K that wasn't already counted on salary.
  const combinedAdditional   = Math.max(0, taxableAnnual + supplementalGross - ADDITIONAL_MEDICARE_THRESHOLD);
  const salaryAdditional     = Math.max(0, taxableAnnual                       - ADDITIONAL_MEDICARE_THRESHOLD);
  const supplementalMedicare = supplementalGross * MEDICARE_RATE +
                               (combinedAdditional - salaryAdditional) * ADDITIONAL_MEDICARE_RATE;

  const supplementalNet = supplementalGross - supplementalFedWh - supplementalOasdi - supplementalMedicare;
  const netAnnual       = annualSalaryNet + supplementalNet;

  return {
    year,
    annualSalary,
    grossPaycheck:         grossAnnual / ppy,
    contrib401kPerCheck:   contrib401kAnnual / ppy,
    premiumsPerCheck:      premiumsAnnual / ppy,
    impGtlPerCheck:        p.impGtlPerCheck,
    taxableWagePerCheck:   taxableAnnual / ppy,
    fedWhPerCheck:         fedWhAnnual / ppy,
    oasdiPerCheck:         oasdiAnnual / ppy,
    medicarePerCheck:      medicareAnnual / ppy,
    extraWhPerCheck:       extraWh,
    postTaxPerCheck:       postTaxAnnual / ppy,
    loan401kPerCheck:      loan401k,
    afterTax401kPerCheck:  contribAfterAnnual / ppy,
    netPaycheck:           annualSalaryNet / ppy,
    annual401k:            contrib401kAnnual,
    annualAfterTax401k:    contribAfterAnnual,
    annualSalaryNet,
    annualExtraWh:         extraAnnual,
    bonusGross,
    stocksGross,
    supplementalFedWh,
    supplementalOasdi,
    supplementalMedicare,
    supplementalNet,
    annualNet:             netAnnual,
  };
}

// Returns the list of years in the scenario's horizon (inclusive on both ends).
export function planYears(scenario: PlanScenario): number[] {
  const out: number[] = [];
  for (let y = 0; y < scenario.horizonYears; y++) out.push(scenario.startYear + y);
  return out;
}

// ── Paycheck-driven YTD projection ───────────────────────────────────────
// These helpers run off the latest financePaycheck row's YTD columns —
// no historical sum required. The latest stub's `ytd*` numbers ARE the
// authoritative YTD figure; everything else is forward extrapolation.

/** Days into a calendar year for an ISO `YYYY-MM-DD` date. */
function daysIntoYear(isoDate: string): number {
  const d = new Date(isoDate + "T00:00:00Z");
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.max(1, Math.round((d.getTime() - start.getTime()) / 86400000) + 1);
}

/**
 * Best-effort cadence inference from a paycheck's period length. Falls
 * back to `defaultPpy` (typically 26 = biweekly) when the period dates
 * aren't populated. Standard US payroll cadences:
 *   weekly      → 52     (period ≈ 7d)
 *   biweekly    → 26     (period ≈ 14d)
 *   semimonthly → 24     (period ≈ 15-16d)
 *   monthly     → 12     (period ≈ 28-31d)
 */
export function inferPaychecksPerYear(p: { periodStart?: string | null; periodEnd?: string | null }, defaultPpy = 26): number {
  if (!p.periodStart || !p.periodEnd) return defaultPpy;
  const days = Math.round(
    (new Date(p.periodEnd + "T00:00:00Z").getTime()
      - new Date(p.periodStart + "T00:00:00Z").getTime()) / 86400000,
  ) + 1;
  if (days <= 8)  return 52;
  if (days <= 13) return 26;
  if (days <= 18) return 24;
  return 12;
}

/** True if the paycheck was issued more than `staleDays` (default 30) ago. */
export function isPaycheckStale(payDateIso: string, todayIso: string, staleDays = 30): boolean {
  const pay = new Date(payDateIso + "T00:00:00Z").getTime();
  const today = new Date(todayIso + "T00:00:00Z").getTime();
  return (today - pay) / 86400000 > staleDays;
}

export type YtdProjection = {
  paychecksPerYear:        number;   // either inferred or the caller-supplied value
  paychecksElapsed:        number;   // 1..paychecksPerYear
  projectedGross:          number;   // CASH gross only — salary, no RSU / bonus
  projectedTaxableWage:    number;   // includes salary taxable + projected supplemental
  projectedFedWh:          number;   // salary linear + 22% on additional supplemental
  projectedOasdi:          number;
  projectedMedicare:       number;
  projected401k:           number;
  projectedAfterTax401k:   number;
  projectedNet:            number;
  // Supplemental decomposition — RSU vests + bonuses, projected on cadence
  // rather than linearly. ytdRsuGross + ytdBonusGross are pulled from the
  // latest stub overall (which always carries the most-current YTD).
  ytdRsuGross:             number;
  ytdBonusGross:           number;
  vestsCompleted:          number;
  vestsExpected:           number;
  projectedRsuGross:       number;   // ytdRsuGross + avgVest × remainingVests
  projectedBonusGross:     number;   // = ytdBonusGross (no extrapolation)
  projectedTotalEarnings:  number;   // projectedGross + projectedRsuGross + projectedBonusGross
};

// ── RSU vest cadence ─────────────────────────────────────────────────────

export const RSU_VEST_CADENCES = ["QUARTERLY", "MONTHLY", "SEMIANNUAL", "ANNUAL", "IRREGULAR"] as const;
export type  RsuVestCadence    = (typeof RSU_VEST_CADENCES)[number];

export const RSU_VEST_CADENCE_LABELS: Record<RsuVestCadence, string> = {
  QUARTERLY:  "Quarterly (4/yr)",
  MONTHLY:    "Monthly (12/yr)",
  SEMIANNUAL: "Semi-annual (2/yr)",
  ANNUAL:     "Annual (1/yr)",
  IRREGULAR:  "Irregular (no extrapolation)",
};

const VESTS_PER_YEAR: Record<RsuVestCadence, number> = {
  QUARTERLY:  4,
  MONTHLY:    12,
  SEMIANNUAL: 2,
  ANNUAL:     1,
  IRREGULAR:  0,
};

// IRS supplemental wage flat rate already declared above as
// SUPPLEMENTAL_FED_RATE — used here for projecting fedWh on additional
// (yet-to-vest) RSU income.

type PaycheckLike = {
  payDate:               string;
  periodStart?:          string | null;
  periodEnd?:            string | null;
  gross?:                number | null;
  taxableWage?:          number | null;
  ytdGross?:             number | null;
  ytdTaxableWage?:       number | null;
  ytdFedWh?:             number | null;
  ytdOasdi?:             number | null;
  ytdMedicare?:          number | null;
  ytd401k?:              number | null;
  ytdAfterTax401k?:      number | null;
  ytdNet?:               number | null;
  bonusGross?:           number | null;
  rsuGross?:             number | null;
  ytdBonusGross?:        number | null;
  ytdRsuGross?:          number | null;
};

/**
 * Project a person's full-year tax picture from their current-year paychecks.
 * Decomposes salary (linear extrapolation, off the latest REGULAR stub's
 * cadence) from supplemental income (RSU vests projected via cadence,
 * bonuses held flat). RSU-only stubs have `gross == 0` and screw with
 * cadence inference if used as the linear base — we skip them.
 *
 * `paychecks` should be ALL of this person's paychecks for the current
 * calendar year, in any order. Returns null if no paycheck found.
 */
export function projectFromPaychecks(args: {
  paychecks:      PaycheckLike[];
  rsuVestCadence: RsuVestCadence;
  paychecksPerYearOverride?: number;
}): YtdProjection | null {
  const { paychecks, rsuVestCadence, paychecksPerYearOverride } = args;
  if (paychecks.length === 0) return null;

  // Sorted desc by payDate so [0] is the most recent.
  const sorted = [...paychecks].sort((a, b) => (b.payDate ?? "").localeCompare(a.payDate ?? ""));

  // Latest stub overall — source of truth for YTD numbers.
  const latestStub = sorted[0];
  // Latest REGULAR stub (cash gross > 0) — source of truth for cadence
  // and for "what's a typical paycheck looks like" linear projection.
  // Falls back to the overall latest if the user has only ever uploaded
  // RSU-only stubs (edge case).
  const latestRegular = sorted.find((p) => (p.gross ?? 0) > 0) ?? latestStub;

  const ppy = paychecksPerYearOverride ?? inferPaychecksPerYear(latestRegular);

  // Day-of-year is taken off the regular paycheck — RSU stubs have a
  // single-day period that fakes out the cadence math.
  const dayOfYear = daysIntoYear(latestRegular.payDate);
  const elapsed   = Math.min(ppy, Math.max(1, Math.round((dayOfYear / 365) * ppy)));
  const scale     = ppy / elapsed;

  // ── Decompose YTD into salary vs supplemental ───────────────────────
  // Supplemental is what's reported in ytdRsuGross + ytdBonusGross. RSU
  // and bonus are taxed as ordinary wages with no pretax deductions, so
  // their full gross is in ytdTaxableWage. The salary portion is the
  // remainder.
  const ytdRsuGross    = latestStub.ytdRsuGross    ?? 0;
  const ytdBonusGross  = latestStub.ytdBonusGross  ?? 0;
  const supplementalYtd = ytdRsuGross + ytdBonusGross;

  const ytdGrossSalary       = latestStub.ytdGross       ?? 0;
  const ytdTaxableSalary     = Math.max(0, (latestStub.ytdTaxableWage ?? 0) - supplementalYtd);
  // Federal WH on supplemental is the IRS flat 22% — back it out of
  // ytdFedWh so the linear-projected salary fedWh isn't inflated by past
  // vests' withholding.
  const ytdSupplementalFedWh = supplementalYtd * SUPPLEMENTAL_FED_RATE;
  const ytdSalaryFedWh       = Math.max(0, (latestStub.ytdFedWh ?? 0) - ytdSupplementalFedWh);

  // ── Linear projection of salary-side YTD ────────────────────────────
  const projectedGross         = ytdGrossSalary       * scale;
  const projectedSalaryTaxable = ytdTaxableSalary     * scale;
  const projectedSalaryFedWh   = ytdSalaryFedWh       * scale;
  const projectedOasdi         = (latestStub.ytdOasdi    ?? 0) * scale;
  const projectedMedicare      = (latestStub.ytdMedicare ?? 0) * scale;
  const projected401k          = (latestStub.ytd401k     ?? 0) * scale;
  const projectedAfterTax401k  = (latestStub.ytdAfterTax401k ?? 0) * scale;
  const projectedNet           = (latestStub.ytdNet      ?? 0) * scale;

  // ── Supplemental projection on user-configured cadence ──────────────
  const vestsCompleted = paychecks.filter((p) => (p.rsuGross ?? 0) > 0).length;
  const vestsExpected  = VESTS_PER_YEAR[rsuVestCadence];
  let projectedAdditionalRsu = 0;
  if (rsuVestCadence !== "IRREGULAR" && vestsCompleted > 0 && vestsCompleted < vestsExpected) {
    const avgVest = ytdRsuGross / vestsCompleted;
    projectedAdditionalRsu = avgVest * (vestsExpected - vestsCompleted);
  }
  const projectedRsuGross       = ytdRsuGross + projectedAdditionalRsu;
  const projectedBonusGross     = ytdBonusGross; // bonuses held flat — no extrapolation
  const additionalSupplementalFedWh = projectedAdditionalRsu * SUPPLEMENTAL_FED_RATE;

  // ── Combine ─────────────────────────────────────────────────────────
  const projectedTaxableWage   = projectedSalaryTaxable + projectedRsuGross + projectedBonusGross;
  const projectedFedWh         = projectedSalaryFedWh   + ytdSupplementalFedWh + additionalSupplementalFedWh;
  const projectedTotalEarnings = projectedGross + projectedRsuGross + projectedBonusGross;

  return {
    paychecksPerYear:        ppy,
    paychecksElapsed:        elapsed,
    projectedGross,
    projectedTaxableWage,
    projectedFedWh,
    projectedOasdi,
    projectedMedicare,
    projected401k,
    projectedAfterTax401k,
    projectedNet,
    ytdRsuGross,
    ytdBonusGross,
    vestsCompleted,
    vestsExpected,
    projectedRsuGross,
    projectedBonusGross,
    projectedTotalEarnings,
  };
}

/** @deprecated use projectFromPaychecks — single-paycheck version doesn't
 *  decompose RSU income from salary, which makes RSU-only stubs poison the
 *  cadence inference and inflate the linear projection. Kept here only
 *  while we migrate callers. */
export function projectFromYTD(
  paycheck: PaycheckLike,
  paychecksPerYearOverride?: number,
): YtdProjection {
  // Wrap the new helper. With a single paycheck, "vestsCompleted" defaults
  // to 1 if rsuGross is set, 0 otherwise — and IRREGULAR cadence means we
  // don't extrapolate beyond YTD. This mirrors the old behavior closely
  // enough for callers we haven't migrated yet.
  const out = projectFromPaychecks({
    paychecks: [paycheck],
    rsuVestCadence: "IRREGULAR",
    paychecksPerYearOverride,
  });
  if (out) return out;
  // Empty case — return a zeroed projection so callers don't crash.
  const ppy = paychecksPerYearOverride ?? 26;
  return {
    paychecksPerYear: ppy, paychecksElapsed: 1,
    projectedGross: 0, projectedTaxableWage: 0, projectedFedWh: 0,
    projectedOasdi: 0, projectedMedicare: 0, projected401k: 0,
    projectedAfterTax401k: 0, projectedNet: 0,
    ytdRsuGross: 0, ytdBonusGross: 0, vestsCompleted: 0, vestsExpected: 0,
    projectedRsuGross: 0, projectedBonusGross: 0, projectedTotalEarnings: 0,
  };
}

/**
 * Federal tax owed on `projectedTaxableWage` for `filingStatus`. Uses the
 * 2025 brackets + standard deduction defined above. Assumes the user
 * itemizes nothing beyond the standard deduction; a more sophisticated
 * version would accept overrides.
 */
export function taxOwedFederal(args: {
  projectedTaxableWage: number;
  filingStatus:         FilingStatus;
}): number {
  const taxable = Math.max(0, args.projectedTaxableWage - STANDARD_DEDUCTION_2025[args.filingStatus]);
  return bracketTax(FED_BRACKETS_2025[args.filingStatus], taxable);
}

/**
 * Signed gap between projected withholding and projected federal liability.
 * Positive number = refund expected; negative = balance owed at filing.
 */
export function taxGap(projectedFedWh: number, taxOwed: number): number {
  return projectedFedWh - taxOwed;
}

// ── Defaults for a fresh scenario ────────────────────────────────────────

export function defaultPlanScenario(id: string, startYear: number): PlanScenario {
  return {
    id,
    name:         "Trajectory 1",
    startYear,
    horizonYears: 10,
    salary: {
      baseYear:         startYear,
      baseAmount:       100000,
      defaultGrowthPct: 0.04,
      jumps:            [],
    },
    paycheck: {
      paychecksPerYear: 26,
      filingStatus:     "SINGLE",
      contrib401kPct:           { [startYear]: 0.10 },
      contribAfterTaxPct:       { [startYear]: 0 },
      impGtlPerCheck:           0,
      medicalPerCheck:          { [startYear]: 0 },
      dentalPerCheck:           0,
      visionPerCheck:           0,
      loan401kPerCheck:         0,
      loan401kEndYear:          null,
      extraWithholdingPerCheck: {},
    },
    bonusByYear:  {},
    stocksByYear: {},
    spend: [],
  };
}
