import { describe, it, expect } from "vitest";
import {
  valueAtYear,
  salaryAtYear,
  projectYear,
  planYears,
  inferPaychecksPerYear,
  isPaycheckStale,
  projectFromPaychecks,
  additionalMedicareTaxOwed,
  additionalMedicareTaxWithheld,
  taxOwedFederal,
  taxGap,
  irs401kElectiveLimit,
  irs401kTotalLimit,
  project401kWithCap,
  contribPctToReachCap,
  extractEmployerMatchYtd,
  extractEmployerMatchPeriod,
  project415cTotal,
  defaultPlanScenario,
  type PlanScenario,
} from "@/components/finance/planning";

// Characterization tests: these pin the CURRENT behavior of the tax/401k math
// (2025 constants from Rev. Proc. 2024-40 + OBBBA, 2026 best-effort estimates)
// so refactors can be verified against a known baseline. If a constant refresh
// intentionally changes an expected value, update the test alongside it.

// ── valueAtYear (sparse YearMap carry-forward) ─────────────────────────────

describe("valueAtYear", () => {
  const map = { 2026: 0.10, 2029: 0.12 };

  it("carries the latest entry ≤ target forward", () => {
    expect(valueAtYear(map, 2026, 0)).toBe(0.10);
    expect(valueAtYear(map, 2027, 0)).toBe(0.10);
    expect(valueAtYear(map, 2028, 0)).toBe(0.10);
    expect(valueAtYear(map, 2029, 0)).toBe(0.12);
    expect(valueAtYear(map, 2035, 0)).toBe(0.12);
  });

  it("returns the fallback before the first entry and for empty maps", () => {
    expect(valueAtYear(map, 2025, 0.05)).toBe(0.05);
    expect(valueAtYear({}, 2030, 42)).toBe(42);
  });
});

// ── salaryAtYear ───────────────────────────────────────────────────────────

describe("salaryAtYear", () => {
  const traj = {
    baseYear: 2025,
    baseAmount: 100_000,
    defaultGrowthPct: 0.10,
    jumps: [{ year: 2027, amount: 150_000 }],
  };

  it("applies default growth in non-jump years", () => {
    expect(salaryAtYear(traj, 2025)).toBe(100_000);
    expect(salaryAtYear(traj, 2026)).toBeCloseTo(110_000, 6);
  });

  it("a jump replaces the salary and growth resumes from it", () => {
    expect(salaryAtYear(traj, 2027)).toBe(150_000);
    expect(salaryAtYear(traj, 2028)).toBeCloseTo(165_000, 6);
  });

  it("years at or before baseYear return baseAmount", () => {
    expect(salaryAtYear(traj, 2020)).toBe(100_000);
  });
});

// ── taxOwedFederal (bracket math) ──────────────────────────────────────────

describe("taxOwedFederal", () => {
  it("computes 2025 MFJ tax across three brackets", () => {
    // taxable = 131,500 − 31,500 std deduction = 100,000
    // 10% × 23,850 + 12% × (96,950 − 23,850) + 22% × (100,000 − 96,950)
    // = 2,385 + 8,772 + 671 = 11,828
    expect(
      taxOwedFederal({ projectedTaxableWage: 131_500, filingStatus: "MFJ", year: 2025 }),
    ).toBeCloseTo(11_828, 2);
  });

  it("computes 2025 SINGLE tax in the first bracket", () => {
    // taxable = 20,000 − 15,750 = 4,250 → 10% = 425
    expect(
      taxOwedFederal({ projectedTaxableWage: 20_000, filingStatus: "SINGLE", year: 2025 }),
    ).toBeCloseTo(425, 2);
  });

  it("wage at or under the standard deduction owes zero", () => {
    expect(
      taxOwedFederal({ projectedTaxableWage: 15_750, filingStatus: "SINGLE", year: 2025 }),
    ).toBe(0);
    expect(taxOwedFederal({ projectedTaxableWage: 0, filingStatus: "MFJ", year: 2025 })).toBe(0);
  });

  it("unknown years fall back to the most recent defined constants (2026)", () => {
    const wage = 200_000;
    expect(taxOwedFederal({ projectedTaxableWage: wage, filingStatus: "MFJ", year: 2030 })).toBe(
      taxOwedFederal({ projectedTaxableWage: wage, filingStatus: "MFJ", year: 2026 }),
    );
  });
});

describe("taxGap", () => {
  it("positive = refund, negative = owed", () => {
    expect(taxGap(12_000, 11_828)).toBeCloseTo(172, 6);
    expect(taxGap(10_000, 11_828)).toBeCloseTo(-1_828, 6);
  });
});

// ── Additional Medicare Tax (Form 8959) ────────────────────────────────────

describe("additionalMedicareTaxOwed", () => {
  it("0.9% on combined wages above the filing-status threshold", () => {
    expect(
      additionalMedicareTaxOwed({ combinedMedicareWages: 300_000, filingStatus: "MFJ" }),
    ).toBeCloseTo(450, 6); // (300k − 250k) × 0.9%
    expect(
      additionalMedicareTaxOwed({ combinedMedicareWages: 250_000, filingStatus: "SINGLE" }),
    ).toBeCloseTo(450, 6); // (250k − 200k) × 0.9%
  });

  it("zero at or below the threshold", () => {
    expect(
      additionalMedicareTaxOwed({ combinedMedicareWages: 250_000, filingStatus: "MFJ" }),
    ).toBe(0);
  });
});

describe("additionalMedicareTaxWithheld", () => {
  it("each person triggers independently at the $200k per-employer threshold", () => {
    // Person A: 250k → 50k × 0.9% = 450. Person B: 150k → 0.
    expect(additionalMedicareTaxWithheld({ perPersonMedicareWages: [250_000, 150_000] })).toBeCloseTo(450, 6);
  });

  it("MFJ combined-over-threshold but individually-under withholds nothing", () => {
    expect(additionalMedicareTaxWithheld({ perPersonMedicareWages: [180_000, 180_000] })).toBe(0);
  });
});

// ── IRS 401k limits ────────────────────────────────────────────────────────

describe("irs401kElectiveLimit / irs401kTotalLimit", () => {
  it("returns published limits for known years", () => {
    expect(irs401kElectiveLimit(2025)).toBe(23_500);
    expect(irs401kElectiveLimit(2026)).toBe(24_500);
    expect(irs401kTotalLimit(2025)).toBe(70_000);
    expect(irs401kTotalLimit(2026)).toBe(72_000);
  });

  it("falls back to the most recent defined year for ANY unknown year (including past ones)", () => {
    // Pinning current behavior: 2024 also resolves to the 2026 value because the
    // fallback picks the latest defined year, not the nearest.
    expect(irs401kElectiveLimit(2030)).toBe(24_500);
    expect(irs401kElectiveLimit(2024)).toBe(24_500);
    expect(irs401kTotalLimit(2030)).toBe(72_000);
  });
});

// ── project401kWithCap ─────────────────────────────────────────────────────

describe("project401kWithCap", () => {
  const base = { ytd401k: 10_000, ytdGross: 100_000, projectedGross: 200_000, year: 2025 };

  it("projects linearly when the cap is not reached", () => {
    const r = project401kWithCap({ ...base, contributionPct: 0.10 });
    // remaining gross 100k × 10% = 10k addition → 20k projected, under the 23.5k cap
    expect(r.projected401k).toBeCloseTo(20_000, 6);
    expect(r.uncapped).toBeCloseTo(20_000, 6);
    expect(r.irsLimit).toBe(23_500);
    expect(r.headroom).toBeCloseTo(3_500, 6);
    expect(r.capReached).toBe(false);
    expect(r.excessOverCap).toBe(0);
  });

  it("caps at the §402(g) limit and reports the excess", () => {
    const r = project401kWithCap({ ...base, contributionPct: 0.20 });
    // desired 20k, headroom only 13.5k
    expect(r.projected401k).toBe(23_500);
    expect(r.uncapped).toBeCloseTo(30_000, 6);
    expect(r.headroom).toBe(0);
    expect(r.capReached).toBe(true);
    expect(r.excessOverCap).toBeCloseTo(6_500, 6);
  });

  it("already at the cap: no addition, capReached false (no headroom to consume)", () => {
    const r = project401kWithCap({ ...base, ytd401k: 23_500, contributionPct: 0.10 });
    expect(r.projected401k).toBe(23_500);
    expect(r.headroom).toBe(0);
    expect(r.capReached).toBe(false);
  });
});

describe("contribPctToReachCap", () => {
  it("returns headroom ÷ remaining gross", () => {
    expect(
      contribPctToReachCap({ ytd401k: 10_000, ytdGross: 100_000, projectedGross: 200_000, year: 2025 }),
    ).toBeCloseTo(0.135, 6);
  });

  it("returns null when already at cap or nothing remains", () => {
    expect(
      contribPctToReachCap({ ytd401k: 23_500, ytdGross: 100_000, projectedGross: 200_000, year: 2025 }),
    ).toBeNull();
    expect(
      contribPctToReachCap({ ytd401k: 10_000, ytdGross: 200_000, projectedGross: 200_000, year: 2025 }),
    ).toBeNull();
  });

  it("clamps at 100% when headroom exceeds remaining gross", () => {
    expect(
      contribPctToReachCap({ ytd401k: 0, ytdGross: 190_000, projectedGross: 200_000, year: 2025 }),
    ).toBe(1);
  });
});

// ── Cadence inference / staleness ──────────────────────────────────────────

describe("inferPaychecksPerYear", () => {
  it("maps inclusive period length to cadence", () => {
    expect(inferPaychecksPerYear({ periodStart: "2026-01-01", periodEnd: "2026-01-07" })).toBe(52);
    expect(inferPaychecksPerYear({ periodStart: "2026-01-01", periodEnd: "2026-01-14" })).toBe(26);
    expect(inferPaychecksPerYear({ periodStart: "2026-01-01", periodEnd: "2026-01-15" })).toBe(24);
    expect(inferPaychecksPerYear({ periodStart: "2026-01-01", periodEnd: "2026-01-31" })).toBe(12);
  });

  it("falls back to defaultPpy when period dates are missing", () => {
    expect(inferPaychecksPerYear({})).toBe(26);
    expect(inferPaychecksPerYear({ periodStart: "2026-01-01" }, 24)).toBe(24);
  });
});

describe("isPaycheckStale", () => {
  it("strictly more than staleDays ago is stale", () => {
    expect(isPaycheckStale("2026-06-01", "2026-07-25")).toBe(true);
    expect(isPaycheckStale("2026-07-01", "2026-07-25")).toBe(false);
    expect(isPaycheckStale("2026-06-25", "2026-07-25")).toBe(false); // exactly 30 days
    expect(isPaycheckStale("2026-06-24", "2026-07-25")).toBe(true);  // 31 days
  });
});

// ── projectYear (full paycheck deduction chain) ────────────────────────────

function scenario(overrides: Partial<PlanScenario> = {}): PlanScenario {
  return {
    ...defaultPlanScenario("t", 2025),
    salary: { baseYear: 2025, baseAmount: 200_000, defaultGrowthPct: 0, jumps: [] },
    paycheck: {
      paychecksPerYear: 24,
      filingStatus: "MFJ",
      contrib401kPct: { 2025: 0.10 },
      contribAfterTaxPct: { 2025: 0 },
      impGtlPerCheck: 20,
      medicalPerCheck: { 2025: 100 },
      dentalPerCheck: 10,
      visionPerCheck: 5,
      loan401kPerCheck: 0,
      loan401kEndYear: null,
      extraWithholdingPerCheck: { 2025: 50 },
    },
    ...overrides,
  };
}

describe("projectYear", () => {
  it("computes the full 2025 deduction chain on annualized taxable wage", () => {
    const y = projectYear(scenario(), 2025);
    // gross 200,000; 401k 20,000; premiums (100+10+5)×24 = 2,760; imputed GTL 20×24 = 480
    // taxable = 200,000 + 480 − 20,000 − 2,760 = 177,720
    expect(y.annualSalary).toBe(200_000);
    expect(y.annual401k).toBeCloseTo(20_000, 6);
    expect(y.taxableWagePerCheck * 24).toBeCloseTo(177_720, 4);
    // fed WH on 177,720 − 31,500 = 146,220 → 2,385 + 8,772 + 22% × 49,270 = 21,996.40
    expect(y.fedWhPerCheck * 24).toBeCloseTo(21_996.4, 2);
    // OASDI capped at 176,100 × 6.2% = 10,918.20
    expect(y.oasdiPerCheck * 24).toBeCloseTo(10_918.2, 2);
    // Medicare 177,720 × 1.45% (under the 200k additional threshold)
    expect(y.medicarePerCheck * 24).toBeCloseTo(2_576.94, 2);
    // net = taxable − fedWh − oasdi − medicare − extraWh(1,200)
    expect(y.annualSalaryNet).toBeCloseTo(141_028.46, 2);
    expect(y.netPaycheck).toBeCloseTo(141_028.46 / 24, 4);
    expect(y.annualNet).toBeCloseTo(141_028.46, 2); // no supplemental
  });

  it("taxes supplemental wages at the flat 22% + FICA with OASDI headroom", () => {
    const y = projectYear(scenario({ bonusByYear: { 2025: 50_000 } }), 2025);
    expect(y.bonusGross).toBe(50_000);
    expect(y.supplementalFedWh).toBeCloseTo(11_000, 6); // 22% flat
    // salary taxable 177,720 already exceeds the 176,100 OASDI cap → no headroom
    expect(y.supplementalOasdi).toBe(0);
    // 1.45% × 50k + 0.9% × (177,720 + 50,000 − 200,000)
    expect(y.supplementalMedicare).toBeCloseTo(725 + 249.48, 2);
    expect(y.supplementalNet).toBeCloseTo(50_000 - 11_000 - 974.48, 2);
    expect(y.annualNet).toBeCloseTo(y.annualSalaryNet + y.supplementalNet, 6);
  });

  it("401k loan repayments stop after loan401kEndYear", () => {
    const s = scenario();
    s.paycheck.loan401kPerCheck = 200;
    s.paycheck.loan401kEndYear = 2026;
    expect(projectYear(s, 2026).loan401kPerCheck).toBe(200);
    expect(projectYear(s, 2027).loan401kPerCheck).toBe(0);
  });
});

describe("planYears", () => {
  it("returns the inclusive horizon", () => {
    const s = { ...defaultPlanScenario("t", 2025), horizonYears: 3 };
    expect(planYears(s)).toEqual([2025, 2026, 2027]);
  });
});

// ── projectFromPaychecks (YTD-driven projection) ───────────────────────────

describe("projectFromPaychecks", () => {
  it("projects salary linearly from actual paycheck count", () => {
    const out = projectFromPaychecks({
      paychecks: [
        { payDate: "2026-01-15", gross: 10_000 },
        {
          payDate: "2026-01-31", gross: 10_000,
          ytdGross: 20_000, ytdTaxableWage: 18_000, ytdFedWh: 4_000,
          ytd401k: 2_000, ytdAfterTax401k: 500, ytdNet: 12_000,
        },
      ],
      rsuVestCadence: "IRREGULAR",
      paychecksPerYearOverride: 24,
    })!;
    expect(out.paychecksElapsed).toBe(2);
    expect(out.ytdSalaryGross).toBe(20_000);
    // scale = 24 / 2 = 12
    expect(out.projectedGross).toBeCloseTo(240_000, 6);
    expect(out.projectedTaxableWage).toBeCloseTo(216_000, 6);
    expect(out.projectedFedWh).toBeCloseTo(48_000, 6);
    expect(out.projected401k).toBeCloseTo(24_000, 6);
    expect(out.projectedAfterTax401k).toBeCloseTo(6_000, 6);
    expect(out.projectedNet).toBeCloseTo(144_000, 6);
    // FICA from projected year-end wages (2026 constants), not linear scaling:
    // OASDI min(240k, 184.5k) × 6.2%; Medicare 1.45% × 240k + 0.9% × 40k
    expect(out.projectedOasdi).toBeCloseTo(184_500 * 0.062, 2);
    expect(out.projectedMedicare).toBeCloseTo(240_000 * 0.0145 + 40_000 * 0.009, 2);
  });

  it("decomposes RSU income from salary and projects vests on cadence", () => {
    const out = projectFromPaychecks({
      paychecks: [
        { payDate: "2026-01-31", gross: 10_000 },
        { payDate: "2026-02-28", gross: 10_000 },
        { payDate: "2026-03-15", gross: 0, rsuGross: 30_000 }, // RSU-only stub
        {
          payDate: "2026-03-31", gross: 10_000,
          ytdGross: 60_000, ytdTaxableWage: 60_000, ytdFedWh: 15_600,
          ytdRsuGross: 30_000, ytdBonusGross: 0, ytd401k: 3_000,
        },
      ],
      rsuVestCadence: "QUARTERLY",
      paychecksPerYearOverride: 12,
    })!;
    // RSU-only stub is excluded from the regular count (3 regulars → scale 4)
    expect(out.paychecksElapsed).toBe(3);
    expect(out.ytdSalaryGross).toBe(30_000);
    expect(out.projectedGross).toBeCloseTo(120_000, 6);
    // 1 of 4 vests done at 30k → 3 more expected → 120k projected RSU
    expect(out.vestsCompleted).toBe(1);
    expect(out.vestsExpected).toBe(4);
    expect(out.projectedRsuGross).toBeCloseTo(120_000, 6);
    // salary taxable (60k − 30k supplemental) × 4 + projected RSU
    expect(out.projectedTaxableWage).toBeCloseTo(120_000 + 120_000, 6);
    // fedWh: salary (15,600 − 22% × 30k = 9,000) × 4 + 6,600 YTD supp + 22% × 90k future
    expect(out.projectedFedWh).toBeCloseTo(36_000 + 6_600 + 19_800, 2);
    expect(out.projectedTotalEarnings).toBeCloseTo(240_000, 6);
  });

  it("IRREGULAR cadence never extrapolates RSU beyond YTD", () => {
    const out = projectFromPaychecks({
      paychecks: [
        { payDate: "2026-03-15", gross: 0, rsuGross: 30_000 },
        { payDate: "2026-03-31", gross: 10_000, ytdRsuGross: 30_000 },
      ],
      rsuVestCadence: "IRREGULAR",
      paychecksPerYearOverride: 24,
    })!;
    expect(out.projectedRsuGross).toBe(30_000);
  });

  it("returns null with no paychecks", () => {
    expect(
      projectFromPaychecks({ paychecks: [], rsuVestCadence: "IRREGULAR" }),
    ).toBeNull();
  });

  it("prefers the stub's real supplemental withholding over the 22% imputation", () => {
    const out = projectFromPaychecks({
      paychecks: [
        {
          payDate: "2026-03-31", gross: 10_000,
          ytdGross: 10_000, ytdTaxableWage: 40_000, ytdFedWh: 12_000,
          ytdRsuGross: 30_000, ytdSupplementalFedWh: 11_100, // aggregate-method 37%
        },
      ],
      rsuVestCadence: "IRREGULAR",
      paychecksPerYearOverride: 24,
    })!;
    // salary fedWh = 12,000 − 11,100 = 900, scaled ×24; supp WH carried as-is
    expect(out.projectedFedWh).toBeCloseTo(900 * 24 + 11_100, 2);
  });
});

// ── Employer-match extraction from lineItems ───────────────────────────────

describe("extractEmployerMatchYtd / extractEmployerMatchPeriod", () => {
  const items = [
    { name: "401k Employer Match", type: "EMPLOYER_PAID", ytd: 5_000, amount: 400 },
    { name: "Group Term Life", type: "EMPLOYER_PAID", ytd: 900, amount: 75 },
    { name: "Medical", type: "PRETAX", ytd: 1_000, amount: 90 },
  ];

  it("sums only EMPLOYER_PAID rows whose name contains 'match'", () => {
    expect(extractEmployerMatchYtd(items)).toBe(5_000);
    expect(extractEmployerMatchPeriod(items)).toBe(400);
  });

  it("accepts the AWSJSON string wire format", () => {
    expect(extractEmployerMatchYtd(JSON.stringify(items))).toBe(5_000);
  });

  it("falls back to amount when ytd is missing, and 0 on garbage input", () => {
    expect(extractEmployerMatchYtd([{ name: "Match", type: "EMPLOYER_PAID", amount: 250 }])).toBe(250);
    expect(extractEmployerMatchYtd(null)).toBe(0);
    expect(extractEmployerMatchYtd("not json")).toBe(0);
  });
});

// ── project415cTotal (mega-backdoor headroom) ──────────────────────────────

describe("project415cTotal", () => {
  const base = {
    ytdEmployee: 10_000,
    ytdEmployerMatch: 5_000,
    ytdAfterTax: 8_000,
    ytdGross: 100_000,
    projectedGross: 200_000,
    projectedEmployee: 20_000,
    year: 2026,
  };

  it("projects match and after-tax linearly on the gross scale", () => {
    const r = project415cTotal(base);
    expect(r.irsLimit).toBe(72_000);
    expect(r.projectedEmployerMatch).toBeCloseTo(10_000, 6); // 5k × 2, under the 12,250 ceiling
    expect(r.projectedAfterTax).toBeCloseTo(16_000, 6);
    expect(r.projectedTotal).toBeCloseTo(46_000, 6);
    expect(r.headroom).toBeCloseTo(26_000, 6);
    expect(r.afterTaxHeadroom).toBeCloseTo(26_000, 6);
    expect(r.capReached).toBe(false);
  });

  it("holds match flat when the latest stub shows a $0 per-period match (plateau)", () => {
    const r = project415cTotal({ ...base, ytdEmployerMatch: 6_000, latestPeriodMatch: 0 });
    expect(r.projectedEmployerMatch).toBe(6_000);
  });

  it("caps projected match at 50% of the elective limit", () => {
    const r = project415cTotal({ ...base, ytdEmployerMatch: 8_000 });
    // 8k × 2 = 16k > 24,500 × 0.5 = 12,250 ceiling
    expect(r.projectedEmployerMatch).toBe(12_250);
  });

  it("caps the total at §415(c) and zeroes headroom", () => {
    const r = project415cTotal({
      ...base,
      projectedEmployee: 24_500,
      ytdEmployerMatch: 6_125, // ×2 = 12,250 exactly at the ceiling
      ytdAfterTax: 20_000,     // ×2 = 40,000
    });
    expect(r.projectedTotal).toBe(72_000);
    expect(r.capReached).toBe(true);
    expect(r.headroom).toBe(0);
    expect(r.afterTaxHeadroom).toBe(0);
  });
});
