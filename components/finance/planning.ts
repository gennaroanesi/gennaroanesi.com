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

// ── Year-keyed tax constants ─────────────────────────────────────────────
// Brackets, standard deduction, and OASDI cap inflation-adjust each year.
// Refresh annually when the IRS publishes its Rev. Proc. (typically Oct/
// Nov of the prior year) and SSA announces the new wage base. The Tax
// Outlook page passes its selectedYear into taxOwedFederal so the math
// matches the year being viewed (validation against 2025 actuals uses
// 2025; current-year projections use 2026).

type Bracket = { rate: number; upTo: number };

type YearTaxConstants = {
  brackets:          Record<FilingStatus, Bracket[]>;
  standardDeduction: Record<FilingStatus, number>;
  oasdiCap:          number;
};

const TAX_CONSTANTS_BY_YEAR: Record<number, YearTaxConstants> = {
  // 2025 — IRS Rev. Proc. 2024-40 + OBBBA (One Big Beautiful Bill Act,
  // July 2025) bumped the standard deduction from the original $30k MFJ
  // / $15k single to the values below.
  2025: {
    brackets: {
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
    },
    standardDeduction: { SINGLE: 15750, MFJ: 31500 },
    oasdiCap:          176100,
  },
  // 2026 — best-effort estimates pending verification against the official
  // IRS Rev. Proc. 2025-32 (issued Oct 2025) and SSA's 2026 wage-base
  // announcement. The bracket cutoffs are approximately +2.5% over 2025 to
  // mirror the typical inflation-adjustment factor; verify and replace
  // with the official figures when convenient. The Additional Medicare Tax
  // thresholds ($200k/$250k) are fixed in statute and don't index.
  // TODO: verify against Rev. Proc. 2025-32.
  2026: {
    brackets: {
      SINGLE: [
        { rate: 0.10, upTo:  12225 },
        { rate: 0.12, upTo:  49700 },
        { rate: 0.22, upTo: 105950 },
        { rate: 0.24, upTo: 202250 },
        { rate: 0.32, upTo: 256800 },
        { rate: 0.35, upTo: 642150 },
        { rate: 0.37, upTo: Infinity },
      ],
      MFJ: [
        { rate: 0.10, upTo:  24450 },
        { rate: 0.12, upTo:  99400 },
        { rate: 0.22, upTo: 211900 },
        { rate: 0.24, upTo: 404500 },
        { rate: 0.32, upTo: 513600 },
        { rate: 0.35, upTo: 770400 },
        { rate: 0.37, upTo: Infinity },
      ],
    },
    standardDeduction: { SINGLE: 16150, MFJ: 32300 },
    oasdiCap:          184500,
  },
};

function taxConstantsForYear(year: number): YearTaxConstants {
  if (TAX_CONSTANTS_BY_YEAR[year] != null) return TAX_CONSTANTS_BY_YEAR[year];
  // Fall back to the most recent defined year so a stale planner doesn't
  // crash when 2027 paychecks land before the next constants refresh.
  const years = Object.keys(TAX_CONSTANTS_BY_YEAR).map(Number).sort();
  return TAX_CONSTANTS_BY_YEAR[years[years.length - 1]];
}

const OASDI_RATE                     = 0.062;
const MEDICARE_RATE                  = 0.0145;
const ADDITIONAL_MEDICARE_RATE       = 0.009;
const ADDITIONAL_MEDICARE_THRESHOLD  = 200000; // employer-side withholding trigger; per-employee

// Filing-status thresholds for the 0.9% Additional Medicare Tax owed at
// filing. These differ from the per-employer withholding trigger — wage
// earners over $250k MFJ / $200k single owe the 0.9% on *combined*
// medicare wages above the threshold, regardless of how it was withheld.
// Form 8959 reconciles. Source: IRC §3101(b)(2).
const ADDITIONAL_MEDICARE_TAX_THRESHOLDS: Record<FilingStatus, number> = {
  SINGLE: 200000,
  MFJ:    250000,
};

// IRS supplemental wage flat rate (Pub 15, Section 7) — applies to bonuses /
// RSU vesting / commissions up to $1M cumulative per employer per year.
// Above $1M, the rate jumps to 37%; the planner does not model that step.
const SUPPLEMENTAL_FED_RATE = 0.22;

// 401(k) elective deferral limit (employee contribution cap, IRC §402(g)).
// Refresh annually with the rest of the IRS constants — the limit increases
// most years. 50+ catch-up adds $7,500 (not modeled here).
const IRS_401K_ELECTIVE_LIMITS: Record<number, number> = {
  2025: 23500,
  2026: 24500,
};

// 401(k) total annual additions limit (IRC §415(c)) — the combined ceiling
// for all employee elective + employer match + after-tax employee
// contributions to a single plan in one year. Drives mega-backdoor Roth
// headroom: 415(c) − 402(g)-elective − employer match = max after-tax room.
const IRS_401K_TOTAL_LIMITS: Record<number, number> = {
  2025: 70000,
  2026: 72000,
};

/** Returns the IRS §402(g) elective-deferral limit for `year`. Falls back to
 *  the most-recent year defined when an unknown year is passed. */
export function irs401kElectiveLimit(year: number): number {
  if (IRS_401K_ELECTIVE_LIMITS[year] != null) return IRS_401K_ELECTIVE_LIMITS[year];
  // Fall back to the most recent defined year.
  const years = Object.keys(IRS_401K_ELECTIVE_LIMITS).map(Number).sort();
  return IRS_401K_ELECTIVE_LIMITS[years[years.length - 1]];
}

/** IRS §415(c) total-additions limit (employee + employer + after-tax). */
export function irs401kTotalLimit(year: number): number {
  if (IRS_401K_TOTAL_LIMITS[year] != null) return IRS_401K_TOTAL_LIMITS[year];
  const years = Object.keys(IRS_401K_TOTAL_LIMITS).map(Number).sort();
  return IRS_401K_TOTAL_LIMITS[years[years.length - 1]];
}

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

  const yearConstants = taxConstantsForYear(year);
  const stdDeduction = yearConstants.standardDeduction[p.filingStatus];
  const fedWhAnnual  = bracketTax(yearConstants.brackets[p.filingStatus], Math.max(0, taxableAnnual - stdDeduction));

  const oasdiBase    = Math.min(taxableAnnual, yearConstants.oasdiCap);
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
  const oasdiHeadroom    = Math.max(0, yearConstants.oasdiCap - Math.max(0, taxableAnnual));
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
  // `+1` makes the period length inclusive: a Mon→Sun week is a 7-day period,
  // a 14-day biweekly run from Sun→second-Sat is 14 days, etc.
  const days = Math.round(
    (new Date(p.periodEnd + "T00:00:00Z").getTime()
      - new Date(p.periodStart + "T00:00:00Z").getTime()) / 86400000,
  ) + 1;
  // Thresholds sit at the midpoints between cadences so the natural period
  // length lands inside the correct bracket: weekly 7d, biweekly 14d,
  // semimonthly 15–16d, monthly 28–31d.
  if (days <= 10) return 52;
  if (days <= 14) return 26;
  if (days <= 22) return 24;
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
  // Salary cash YTD — computed by summing per-paycheck max(0, gross −
  // bonusGross − rsuGross). This is the source of truth for the salary
  // baseline; latestStub.ytdGross is unreliable because Workday rolls
  // bonuses into it.
  ytdSalaryGross:          number;
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
  // latest stub's YTD column when present, else summed from per-period
  // values across all paychecks for the year.
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
  // Optional — actual fedWh on supplemental wages. When present we trust
  // it (employer's real flat 22% / aggregate-method withholding); when
  // absent we fall back to the SUPPLEMENTAL_FED_RATE imputation.
  ytdSupplementalFedWh?: number | null;
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

  // Count actual regular (salary > 0) paychecks YTD instead of estimating
  // from day-of-year × ppy. Biweekly cadence drifts off the calendar — by
  // mid-May you've received 11 biweekly paychecks but day-of-year math
  // only credits 10, which inflated the linear projection. RSU/bonus-only
  // stubs are excluded so they don't double-count alongside the regular
  // paycheck that paid out on the same day.
  const regularCount = paychecks.filter(
    (p) => Math.max(0, (p.gross ?? 0) - (p.bonusGross ?? 0) - (p.rsuGross ?? 0)) > 0,
  ).length;
  const elapsed   = Math.min(ppy, Math.max(1, regularCount));
  const scale     = ppy / elapsed;

  // ── Decompose YTD into salary vs supplemental ───────────────────────
  // Supplemental is what's reported in ytdRsuGross + ytdBonusGross. RSU
  // and bonus are taxed as ordinary wages with no pretax deductions, so
  // their full gross is in ytdTaxableWage. The salary portion is the
  // remainder.
  //
  // Fallback: if the latest stub doesn't carry the YTD column (e.g. it
  // was uploaded before the schema knew about these fields), sum the
  // per-period values across all paychecks for the year. This makes the
  // tool resilient to partial backfills — fill in just the per-event
  // rsuGross OR just the YTD on the latest stub, either works.
  const summedRsu      = paychecks.reduce((s, p) => s + (p.rsuGross   ?? 0), 0);
  const summedBonus    = paychecks.reduce((s, p) => s + (p.bonusGross ?? 0), 0);
  const ytdRsuGross    = latestStub.ytdRsuGross    ?? summedRsu;
  const ytdBonusGross  = latestStub.ytdBonusGross  ?? summedBonus;
  const supplementalYtd = ytdRsuGross + ytdBonusGross;

  // Salary cash YTD computed from per-paycheck data. We can't trust
  // latestStub.ytdGross here because Workday rolls bonuses (and sometimes
  // RSU vests) into that running total — extrapolating it linearly would
  // pretend you got a bonus every paycheck. The defensive `max(0, gross −
  // bonusGross − rsuGross)` handles every stub shape: regular salary
  // ($9,116 − 0 − 0 = $9,116), bonus ($0 − $54k − 0 → 0), RSU ($0 − 0 −
  // $119k → 0), and even parser-slipped variants where the same dollar
  // ended up in both gross and rsuGross/bonusGross.
  const ytdGrossSalary       = paychecks.reduce(
    (sum, p) => sum + Math.max(0, (p.gross ?? 0) - (p.bonusGross ?? 0) - (p.rsuGross ?? 0)),
    0,
  );
  const ytdTaxableSalary     = Math.max(0, (latestStub.ytdTaxableWage ?? 0) - supplementalYtd);
  // Federal WH on supplemental is the IRS flat 22% — back it out of
  // ytdFedWh so the linear-projected salary fedWh isn't inflated by past
  // vests' withholding.
  // Prefer the real per-stub supplemental WH when populated (employers using
  // the aggregate method on large vests routinely withhold 30-37%, not the
  // IRS flat 22%). Falls back to the 22% imputation when the stub doesn't
  // carry the column, which keeps older paychecks working.
  const ytdSupplementalFedWh = latestStub.ytdSupplementalFedWh != null
    ? Math.max(0, latestStub.ytdSupplementalFedWh)
    : supplementalYtd * SUPPLEMENTAL_FED_RATE;
  const ytdSalaryFedWh       = Math.max(0, (latestStub.ytdFedWh ?? 0) - ytdSupplementalFedWh);

  // ── Linear projection of salary-side YTD ────────────────────────────
  const projectedGross         = ytdGrossSalary       * scale;
  const projectedSalaryTaxable = ytdTaxableSalary     * scale;
  const projectedSalaryFedWh   = ytdSalaryFedWh       * scale;
  const projected401k          = (latestStub.ytd401k     ?? 0) * scale;
  const projectedAfterTax401k  = (latestStub.ytdAfterTax401k ?? 0) * scale;
  const projectedNet           = (latestStub.ytdNet      ?? 0) * scale;

  // ── Supplemental projection on user-configured cadence ──────────────
  // vestsCompleted counts paychecks where the user has filled in
  // rsuGross. If they haven't filled any (older RSU stubs, pre-schema-
  // change) but the YTD column says RSU income exists, infer at least one
  // vest happened so the cadence math has a non-zero denominator.
  let vestsCompleted = paychecks.filter((p) => (p.rsuGross ?? 0) > 0).length;
  if (vestsCompleted === 0 && ytdRsuGross > 0) vestsCompleted = 1;
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

  // ── Payroll-tax projection (OASDI + Medicare) ───────────────────────
  // Compute these from projected year-end FICA wages instead of scaling
  // YTD linearly. FICA wages don't subtract 401k pre-tax, so
  // projectedTotalEarnings is a good proxy for both Box 3 (OASDI) and
  // Box 5 (Medicare). This handles two kinks that linear scaling missed:
  //   • OASDI: caps at the SSA wage base (2026: $184,500), so projected
  //     OASDI can't exceed cap × 6.2%.
  //   • Medicare: 1.45% on all wages PLUS an additional 0.9% above $200k
  //     YTD per-employer (the Form 8959 per-paycheck trigger). The
  //     piecewise function can't be approximated by a single scale.
  // Source of truth so the user can compare against W-2 forecast.
  const projYear = Number((latestStub.payDate ?? "").slice(0, 4)) || new Date().getUTCFullYear();
  const yearConstants = taxConstantsForYear(projYear);
  const oasdiWagesProjected   = Math.min(projectedTotalEarnings, yearConstants.oasdiCap);
  const projectedOasdi        = oasdiWagesProjected * OASDI_RATE;
  const projectedMedicare     = projectedTotalEarnings * MEDICARE_RATE
    + Math.max(0, projectedTotalEarnings - ADDITIONAL_MEDICARE_THRESHOLD) * ADDITIONAL_MEDICARE_RATE;

  return {
    paychecksPerYear:        ppy,
    paychecksElapsed:        elapsed,
    ytdSalaryGross:          ytdGrossSalary,
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
    ytdSalaryGross: 0,
    projectedGross: 0, projectedTaxableWage: 0, projectedFedWh: 0,
    projectedOasdi: 0, projectedMedicare: 0, projected401k: 0,
    projectedAfterTax401k: 0, projectedNet: 0,
    ytdRsuGross: 0, ytdBonusGross: 0, vestsCompleted: 0, vestsExpected: 0,
    projectedRsuGross: 0, projectedBonusGross: 0, projectedTotalEarnings: 0,
  };
}

/**
 * Additional Medicare Tax (Form 8959) liability on combined Medicare wages
 * above the filing-status threshold. 0.9% on the excess. This is the TOTAL
 * liability — Form 8959 then nets out the per-employer withholding that
 * already happened (see `additionalMedicareTaxWithheld`). Callers wanting
 * the actual cash impact at filing should subtract the withheld amount
 * from this value.
 */
export function additionalMedicareTaxOwed(args: {
  combinedMedicareWages: number;
  filingStatus:          FilingStatus;
}): number {
  const threshold = ADDITIONAL_MEDICARE_TAX_THRESHOLDS[args.filingStatus];
  return Math.max(0, args.combinedMedicareWages - threshold) * ADDITIONAL_MEDICARE_RATE;
}

/**
 * Additional Medicare Tax already withheld by paychecks (per Form 8959,
 * Part II). Each employer triggers at $200k YTD per IRC §3101(b)(2),
 * regardless of filing status — so per-person wages above $200k accrue
 * 0.9% withholding throughout the year. This lives in Box 6 (medicare
 * withholding), not Box 2 (income tax WH), which is why it needs its
 * own credit lane on the gap calc.
 *
 * Sum each person's wages independently — assumes one employer per person
 * (good enough for the W-2-style planner; multi-employer cases get a
 * one-off Form 8959 reconciliation that our model approximates).
 */
export function additionalMedicareTaxWithheld(args: {
  perPersonMedicareWages: number[];
}): number {
  return args.perPersonMedicareWages.reduce(
    (s, w) => s + Math.max(0, w - ADDITIONAL_MEDICARE_THRESHOLD) * ADDITIONAL_MEDICARE_RATE,
    0,
  );
}

/**
 * Federal tax owed on `projectedTaxableWage` for `filingStatus`. Brackets
 * and standard deduction are pulled from TAX_CONSTANTS_BY_YEAR[year], so
 * pass the year being projected (2025 for validation, 2026 for current
 * planning, etc.). Assumes the user itemizes nothing beyond the standard
 * deduction; a more sophisticated version would accept overrides.
 */
export function taxOwedFederal(args: {
  projectedTaxableWage: number;
  filingStatus:         FilingStatus;
  year:                 number;
}): number {
  const constants = taxConstantsForYear(args.year);
  const taxable   = Math.max(0, args.projectedTaxableWage - constants.standardDeduction[args.filingStatus]);
  return bracketTax(constants.brackets[args.filingStatus], taxable);
}

/**
 * Signed gap between projected withholding and projected federal liability.
 * Positive number = refund expected; negative = balance owed at filing.
 */
export function taxGap(projectedFedWh: number, taxOwed: number): number {
  return projectedFedWh - taxOwed;
}

// ── 401(k) elective-deferral cap projection ──────────────────────────────

export type Contribution401kProjection = {
  projected401k:    number;   // capped at IRS §402(g) limit
  uncapped:         number;   // ytd + (remainingGross × pct), no cap applied
  irsLimit:         number;
  headroom:         number;   // irsLimit - projected401k (≥ 0)
  capReached:       boolean;  // true when contribution actually hits the cap
  // Amount the linear-projection would have flowed into 401k but instead
  // shows up as taxable wage because the cap kicked in mid-year. Callers
  // use this to correct projectedTaxableWage upward when their projection
  // started from a YTD-linear extrapolation.
  excessOverCap:    number;
};

/**
 * Project end-of-year 401(k) employee contribution, applying the IRS §402(g)
 * cap. The math is intentionally simple: contribution = remaining-salary-gross
 * × pct, capped at (limit - YTD). Real plans may behave more subtly (true-up,
 * payroll-rounding, percentage-of-pre-tax-instead-of-gross) but this is good
 * enough for an at-a-glance year-end estimate.
 */
export function project401kWithCap(args: {
  ytd401k:         number;
  ytdGross:        number;   // salary cash gross YTD — RSU vests excluded
  projectedGross:  number;   // salary cash gross projected to year-end
  contributionPct: number;   // 0..1
  year?:           number;
}): Contribution401kProjection {
  const irsLimit            = irs401kElectiveLimit(args.year ?? new Date().getUTCFullYear());
  const remainingGross      = Math.max(0, args.projectedGross - args.ytdGross);
  const headroomBefore      = Math.max(0, irsLimit - args.ytd401k);
  const desiredAddition     = remainingGross * args.contributionPct;
  const actualAddition      = Math.min(desiredAddition, headroomBefore);
  const projected           = args.ytd401k + actualAddition;
  return {
    projected401k:  projected,
    uncapped:       args.ytd401k + desiredAddition,
    irsLimit,
    headroom:       Math.max(0, irsLimit - projected),
    capReached:     actualAddition >= headroomBefore && headroomBefore > 0,
    excessOverCap:  Math.max(0, desiredAddition - actualAddition),
  };
}

/**
 * Returns the contribution percentage at which the user would just barely
 * hit the IRS cap (assuming linear paychecks). Useful for "contributing X%
 * gets you to the cap" hints. Returns null if YTD already at/over cap.
 */
export function contribPctToReachCap(args: {
  ytd401k:        number;
  ytdGross:       number;
  projectedGross: number;
  year?:          number;
}): number | null {
  const irsLimit = irs401kElectiveLimit(args.year ?? new Date().getUTCFullYear());
  const headroom = irsLimit - args.ytd401k;
  if (headroom <= 0) return null;
  const remainingGross = Math.max(0, args.projectedGross - args.ytdGross);
  if (remainingGross <= 0) return null;
  return Math.min(1, headroom / remainingGross);
}

// ── Mega-backdoor / §415(c) projection ───────────────────────────────────

type LineItemLike = {
  name?:   string | null;
  type?:   string | null;
  ytd?:    number | null;
  amount?: number | null;
};

/**
 * Extract the employer-match YTD from a paycheck's lineItems blob.
 * Matches any EMPLOYER_PAID row whose name contains "match" (case-insensitive).
 * Works on Workday-style "401k Employer Match" rows and most other payroll
 * provider variants. Returns 0 when no match line is found.
 *
 * `lineItems` may arrive as a serialized JSON string (AppSync's AWSJSON wire
 * format), a parsed array, or null — handles all three.
 */
function readLineItems(lineItems: unknown): LineItemLike[] {
  if (typeof lineItems === "string") {
    try {
      const parsed = JSON.parse(lineItems);
      return Array.isArray(parsed) ? (parsed as LineItemLike[]) : [];
    } catch { return []; }
  }
  return Array.isArray(lineItems) ? (lineItems as LineItemLike[]) : [];
}

export function extractEmployerMatchYtd(lineItems: unknown): number {
  let total = 0;
  for (const it of readLineItems(lineItems)) {
    if (it?.type !== "EMPLOYER_PAID") continue;
    if (!it.name) continue;
    if (!/match/i.test(it.name)) continue;
    const ytd = it.ytd ?? it.amount ?? 0;
    if (Number.isFinite(ytd)) total += ytd;
  }
  return total;
}

/**
 * Per-period employer match on a single paycheck's lineItems blob — the
 * sibling to `extractEmployerMatchYtd`. Used to detect when the match has
 * plateaued (employer cap hit): if the latest stub's per-period match is
 * $0 while YTD is positive, no more match is coming.
 */
export function extractEmployerMatchPeriod(lineItems: unknown): number {
  let total = 0;
  for (const it of readLineItems(lineItems)) {
    if (it?.type !== "EMPLOYER_PAID") continue;
    if (!it.name) continue;
    if (!/match/i.test(it.name)) continue;
    const amount = it.amount ?? 0;
    if (Number.isFinite(amount)) total += amount;
  }
  return total;
}

export type Mega401kProjection = {
  irsLimit:                 number;   // §415(c) total annual additions cap
  ytdEmployee:              number;   // = ytd401k (pretax/Roth elective)
  ytdEmployerMatch:         number;
  ytdAfterTax:              number;   // = ytdAfterTax401k
  ytdTotal:                 number;   // sum of the three above
  projectedEmployee:        number;   // §402(g)-capped (caller passes this in)
  projectedEmployerMatch:   number;   // linear from YTD
  projectedAfterTax:        number;   // linear from YTD
  projectedTotal:           number;   // sum, capped at irsLimit
  headroom:                 number;   // irsLimit - projectedTotal (≥ 0)
  // Headroom that remains for ADDITIONAL after-tax contributions on top of
  // current pace — i.e. how much more the user could mega-backdoor this year
  // without bumping any other lever.
  afterTaxHeadroom:         number;
  capReached:               boolean;
};

/**
 * Project full-year §415(c) total additions and surface mega-backdoor Roth
 * headroom. Pretax/Roth elective comes pre-capped from project401kWithCap;
 * employer match and after-tax both project linearly from YTD on the
 * regular-salary gross axis (after-tax is taken on salary, not RSU).
 */
export function project415cTotal(args: {
  ytdEmployee:           number;   // ytd401k (pretax/Roth elective)
  ytdEmployerMatch:      number;
  ytdAfterTax:           number;   // ytdAfterTax401k
  ytdGross:              number;   // salary cash gross YTD (RSU excluded)
  projectedGross:        number;   // salary cash gross projected year-end
  projectedEmployee:     number;   // pretax §402(g)-capped projection (from project401kWithCap)
  // Per-period employer match on the most recent stub. When 0 alongside
  // a positive YTD match, the employer's match cap has been hit and
  // further linear scaling would project phantom contributions. Optional
  // for back-compat; absence falls back to pure linear projection.
  latestPeriodMatch?:    number | null;
  year?:                 number;
}): Mega401kProjection {
  const irsLimit = irs401kTotalLimit(args.year ?? new Date().getUTCFullYear());
  // Scale = total-year / elapsed-year, derived from the gross ratio. Falls
  // back to 1 when ytdGross is 0 (no projection possible).
  const scale = args.ytdGross > 0 ? args.projectedGross / args.ytdGross : 1;
  // Plateau detection: latest-stub per-period match is $0 while YTD is
  // positive ⇒ the employer's match formula has already capped out, so
  // any forward scaling would project phantom match.
  const matchPlateaued = args.latestPeriodMatch != null
    && args.latestPeriodMatch === 0
    && args.ytdEmployerMatch > 0;
  // Defensive ceiling: Meta / most tech employers cap employer match at
  // 50% × IRS §402(g) elective limit ($12,250 for 2026). The plateau
  // signal only kicks in the paycheck AFTER the cap is hit; this ceiling
  // catches the in-period case where per-period match is still positive
  // on the stub that just crossed it. Conservative bias: under-projects
  // for plans that match more generously (rare; user can override via a
  // future setting if needed).
  const electiveLimit = irs401kElectiveLimit(args.year ?? new Date().getUTCFullYear());
  const defaultMatchCeiling = electiveLimit * 0.5;
  const projectedEmployerMatch = matchPlateaued
    ? args.ytdEmployerMatch
    : Math.min(args.ytdEmployerMatch * scale, defaultMatchCeiling);
  const projectedAfterTax      = args.ytdAfterTax * scale;
  const uncappedTotal          = args.projectedEmployee + projectedEmployerMatch + projectedAfterTax;
  const projectedTotal         = Math.min(irsLimit, uncappedTotal);
  const ytdTotal               = args.ytdEmployee + args.ytdEmployerMatch + args.ytdAfterTax;
  const headroom               = Math.max(0, irsLimit - projectedTotal);
  // After-tax headroom = total headroom plus any room not consumed by
  // employer match + employee elective at year-end. The user can convert
  // this much more (via in-plan Roth conversion or in-service rollover)
  // before hitting §415(c) — assuming their plan supports it.
  const afterTaxHeadroom       = Math.max(0, irsLimit - args.projectedEmployee - projectedEmployerMatch - projectedAfterTax);
  return {
    irsLimit,
    ytdEmployee:            args.ytdEmployee,
    ytdEmployerMatch:       args.ytdEmployerMatch,
    ytdAfterTax:            args.ytdAfterTax,
    ytdTotal,
    projectedEmployee:      args.projectedEmployee,
    projectedEmployerMatch,
    projectedAfterTax,
    projectedTotal,
    headroom,
    afterTaxHeadroom,
    capReached:             uncappedTotal >= irsLimit,
  };
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
