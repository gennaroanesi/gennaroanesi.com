import React, { useCallback, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useS3JsonState } from "@/hooks/useS3JsonState";
import FinanceLayout from "@/layouts/finance";
import { PageTitle, PageLoading } from "@/components/common/ui";
import {
  client,
  FINANCE_COLOR,
  fmtCurrency, todayIso, amountColor,
  listAll,
  PAYCHECK_PERSON_LABELS,
  type PaycheckRecord, type PaycheckPerson,
} from "@/components/finance/_shared";
import {
  type FilingStatus,
  projectFromPaychecks, taxOwedFederal, taxGap, isPaycheckStale,
  project401kWithCap, contribPctToReachCap, irs401kElectiveLimit,
  additionalMedicareTaxOwed,
  additionalMedicareTaxWithheld,
  RSU_VEST_CADENCES, RSU_VEST_CADENCE_LABELS, type RsuVestCadence,
  PLAN_TAX_YEAR_LABEL,
} from "@/components/finance/planning";

const S3_BUCKET             = "gennaroanesi.com";
const SETTINGS_S3_PATH      = "paycheck-settings/v1.json";
const SETTINGS_LOCAL_KEY    = "finance:paycheck-settings:v1";

type PaycheckSettings = {
  filingStatus:   FilingStatus;
  rsuVestCadence: { ME?: RsuVestCadence; SPOUSE?: RsuVestCadence };
};

const DEFAULT_SETTINGS: PaycheckSettings = {
  filingStatus:   "MFJ",
  rsuVestCadence: { ME: "IRREGULAR", SPOUSE: "IRREGULAR" },
};

type PerPerson = {
  person:        PaycheckPerson;
  paychecks:     PaycheckRecord[];   // all current-year stubs for this person
  latest:        PaycheckRecord;     // overall most recent (RSU or salary)
  projection:    NonNullable<ReturnType<typeof projectFromPaychecks>>;
  // Effective YTD 401k contribution rate (decimal). Used as the baseline
  // for the "what-if 401k %" slider so the user starts from where they are.
  current401kPct: number;
  stale:         boolean;
};

const TODAY = todayIso();

function PersonHeader({ person }: { person: PaycheckPerson }) {
  return (
    <h2 className="text-sm font-semibold uppercase tracking-widest text-purple dark:text-rose mb-3">
      {PAYCHECK_PERSON_LABELS[person]}
    </h2>
  );
}

function StatRow({ label, value, hint, color }: { label: string; value: string; hint?: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {label}{hint && <span className="ml-1 text-gray-400">{hint}</span>}
      </span>
      <span className="tabular-nums text-sm font-semibold text-gray-800 dark:text-gray-200" style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  );
}

function Card({ title, subtitle, children, className = "" }: { title: string; subtitle?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface p-4 flex flex-col gap-2 ${className}`}>
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">{title}</h3>
        {subtitle && <span className="text-[10px] text-gray-400">{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

export default function TaxOutlookPage() {
  const { authState } = useRequireAuth();

  const [paychecks, setPaychecks] = useState<PaycheckRecord[]>([]);
  const [loading,   setLoading]   = useState(true);

  // Settings live in S3 (with localStorage mirror) so per-person RSU
  // cadence survives across devices. filingStatus is no longer user-
  // configurable (per-person view always uses SINGLE; combined view
  // always uses MFJ) but the field stays in the settings shape so older
  // saved blobs still load.
  const { value: settings, setValue: setSettings } = useS3JsonState<PaycheckSettings>(
    SETTINGS_S3_PATH,
    () => DEFAULT_SETTINGS,
    {
      bucket: S3_BUCKET,
      localStorageKey: SETTINGS_LOCAL_KEY,
      enabled: authState === "authenticated",
    },
  );
  const setRsuVestCadence = useCallback((person: PaycheckPerson, cadence: RsuVestCadence) => {
    setSettings((prev) => ({
      ...prev,
      rsuVestCadence: { ...prev.rsuVestCadence, [person]: cadence },
    }));
  }, [setSettings]);

  // 401k what-if slider — applied to BOTH persons' projections. -1 = "use
  // current" (no override), else a decimal pct in [0, 0.50].
  const [pctOverride, setPctOverride] = useState<number>(-1);

  // Year selector — defaults to current calendar year. Lets the user
  // upload past-year paychecks (e.g. 2025) and validate the planner's
  // year-end projection against actual numbers from their TurboTax-filed
  // return. Past years skip the stale-paycheck warning since every stub
  // is by definition >30 days old.
  const [selectedYear, setSelectedYear] = useState<number>(() => new Date(TODAY).getUTCFullYear());
  const isCurrentYear = selectedYear === new Date(TODAY).getUTCFullYear();

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listAll<PaycheckRecord>(client.models.financePaycheck as any);
      setPaychecks(rows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchData();
  }, [authState, fetchData]);

  // Group paychecks by person, filter to the selected year. Latest stub
  // of that year drives the projection — for past years that's the last
  // paycheck of December, so the projection collapses to the actual
  // year-end numbers (good for validation).
  const byPerson = useMemo<PerPerson[]>(() => {
    const out: PerPerson[] = [];
    for (const person of ["ME", "SPOUSE"] as PaycheckPerson[]) {
      const mine = paychecks
        .filter((p) => p.person === person)
        .filter((p) => (p.payDate ?? "").startsWith(`${selectedYear}`))
        .sort((a, b) => (b.payDate ?? "").localeCompare(a.payDate ?? ""));
      if (mine.length === 0) continue;
      const latest = mine[0];
      const cadence = settings.rsuVestCadence[person] ?? "IRREGULAR";
      const projection = projectFromPaychecks({ paychecks: mine, rsuVestCadence: cadence });
      if (!projection) continue;
      // current 401k pct from YTD — falls back to per-paycheck ratio if the
      // YTD numbers aren't populated. Uses ytdGross (cash gross / salary
      // only) as the denominator since 401k contributions don't apply to
      // RSU vest income.
      // Denominator must be salary-only YTD — `latest.ytdGross` is whatever
      // Workday put in that column, which rolls RSU vests + bonus into the
      // running total. Using projection.ytdSalaryGross (Σ per-stub
      // max(0, gross − bonus − rsu)) gives the actual salary against which
      // 401k % was deducted.
      const current401kPct = (() => {
        const ytdSalary = projection.ytdSalaryGross;
        const ytd401k   = latest.ytd401k ?? 0;
        if (ytdSalary > 0) return ytd401k / ytdSalary;
        // Fallback: latest regular paycheck's per-stub ratio.
        const latestReg = mine.find((c) => Math.max(0, (c.gross ?? 0) - (c.bonusGross ?? 0) - (c.rsuGross ?? 0)) > 0);
        if (latestReg) {
          const salary = Math.max(0, (latestReg.gross ?? 0) - (latestReg.bonusGross ?? 0) - (latestReg.rsuGross ?? 0));
          if (salary > 0) return (latestReg.contrib401k ?? 0) / salary;
        }
        return 0;
      })();
      out.push({
        person,
        paychecks:    mine,
        latest,
        projection,
        current401kPct,
        // Stale check only applies to the current year — past years are
        // intrinsically old and the warning would always fire.
        stale: isCurrentYear && isPaycheckStale(latest.payDate ?? TODAY, TODAY),
      });
    }
    return out;
  }, [paychecks, settings.rsuVestCadence, selectedYear, isCurrentYear]);

  // Years available in the dropdown — every year that has at least one
  // paycheck on file, plus the current year (so it's always selectable
  // even before any 2026 stubs land). Sorted newest first.
  const availableYears = useMemo(() => {
    const ys = new Set<number>();
    ys.add(new Date(TODAY).getUTCFullYear());
    for (const p of paychecks) {
      const y = (p.payDate ?? "").slice(0, 4);
      if (y) ys.add(Number(y));
    }
    return Array.from(ys).sort((a, b) => b - a);
  }, [paychecks]);

  // Per-person tax outcome (current and slider-adjusted). Cap-aware: every
  // 401k delta is clipped at the IRS §402(g) elective-deferral limit, so a
  // 30%-slider on a $260k salary doesn't pretend to deduct $78k from
  // taxable wage. The same cap correction also bumps taxable wage upward
  // by however much the linear-projection over-deducted from late-year
  // paychecks that would've already hit the cap.
  type Outcome = {
    taxableWage:  number;
    fedWh:        number;
    taxOwed:      number;
    gap:          number;
    new401k:      number;
    irsLimit:     number;
    capReached:   boolean;
  };
  function outcomeFor(p: PerPerson, pct: number | null): Outcome {
    const adjustedPct = pct ?? p.current401kPct;
    const ytd401k   = p.latest.ytd401k ?? 0;
    // Salary-only YTD — see project401kWithCap's JSDoc. Using latest.ytdGross
    // here under-projects remaining 401k contribution whenever RSU/bonus has
    // inflated the Workday running-total column.
    const ytdGross  = p.projection.ytdSalaryGross;
    const args      = { ytd401k, ytdGross, projectedGross: p.projection.projectedGross, year: selectedYear };

    const currentCap  = project401kWithCap({ ...args, contributionPct: p.current401kPct });
    const adjustedCap = project401kWithCap({ ...args, contributionPct: adjustedPct });

    // delta401k = how much MORE the user actually contributes (capped) under
    // adjustedPct vs currentPct. Negative when slider is below current.
    const delta401k = adjustedCap.projected401k - currentCap.projected401k;

    // Correction: projection.projectedTaxableWage was extrapolated linearly
    // from ytdTaxableWage, which implicitly assumed contributions kept
    // flowing all year at the current rate. If currentPct would have hit
    // the cap, late-year paychecks actually have $0 401k deduction → real
    // taxable wage is HIGHER by currentCap.excessOverCap.
    const baseTaxableWage = p.projection.projectedTaxableWage + currentCap.excessOverCap;
    const taxableWage     = Math.max(0, baseTaxableWage - delta401k);

    // Per-person card always uses SINGLE brackets — the subtitle reads
    // "single-filer view" and that's the most useful comparison point
    // (vs the combined MFJ card below). Married users with only one set
    // of paychecks on file (e.g. spouse hasn't been uploaded yet) read
    // the SINGLE numbers as informational — combined MFJ math kicks in
    // automatically once the second person has rows.
    const personFiling: FilingStatus = "SINGLE";
    const fedWh   = p.projection.projectedFedWh;
    const bracketTax = taxOwedFederal({
      projectedTaxableWage: taxableWage,
      filingStatus:         personFiling,
      year:                 selectedYear,
    });
    // Additional Medicare Tax (Form 8959). Net the liability against the
    // 0.9% already withheld via paycheck (per-employer trigger at $200k YTD,
    // independent of filing status). For SINGLE filers the two cancel
    // exactly (same $200k threshold both sides). The combined-MFJ card
    // below is where this matters — over-withholding becomes a refund.
    // Medicare wages approximated via projectedTotalEarnings since they
    // don't subtract 401k.
    const addlMedicareLiability = additionalMedicareTaxOwed({
      combinedMedicareWages: p.projection.projectedTotalEarnings,
      filingStatus:          personFiling,
    });
    const addlMedicareWh = additionalMedicareTaxWithheld({
      perPersonMedicareWages: [p.projection.projectedTotalEarnings],
    });
    const taxOwed = bracketTax + (addlMedicareLiability - addlMedicareWh);
    const gap     = taxGap(fedWh, taxOwed);
    return {
      taxableWage, fedWh, taxOwed, gap,
      new401k:    adjustedCap.projected401k,
      irsLimit:   adjustedCap.irsLimit,
      capReached: adjustedCap.capReached,
    };
  }

  // For the per-person card we keep filingStatus in sync — when there's
  // only ME (no spouse), the user might still file SINGLE or MFJ depending
  // on their reality. The combined card only shows when both rows exist.
  const sliderOverride = pctOverride < 0 ? null : pctOverride;
  const personOutcomes = byPerson.map((p) => ({
    person:  p,
    current: outcomeFor(p, p.current401kPct),
    slider:  outcomeFor(p, sliderOverride),
  }));

  // Slider's resting position when no override is active. Falls back to
  // the average of all current contribution rates so a two-person view
  // doesn't bias toward whichever person renders first; with one person
  // the average == that person's rate.
  const defaultSliderPct = byPerson.length > 0
    ? byPerson.reduce((sum, p) => sum + p.current401kPct, 0) / byPerson.length
    : 0;

  const combined = byPerson.length === 2 ? (() => {
    const taxableWage = personOutcomes.reduce((s, o) => s + o.slider.taxableWage, 0);
    const fedWh       = personOutcomes.reduce((s, o) => s + o.slider.fedWh, 0);
    const bracketTax  = taxOwedFederal({
      projectedTaxableWage: taxableWage,
      filingStatus:         "MFJ",
      year:                 selectedYear,
    });
    // Additional Medicare Tax (Form 8959): combined medicare wages above
    // $250k MFJ vs. per-employer $200k WH trigger. Each spouse's wages
    // accrue 0.9% WH independently — over-withholding becomes a refund
    // when combined < $250k (e.g. spouse income drags us under) OR when
    // both spouses are over $200k separately. Medicare wages approximated
    // via projectedTotalEarnings (medicare wages don't subtract 401k).
    const perPersonMedicareWages = byPerson.map((p) => p.projection.projectedTotalEarnings);
    const combinedMedicareWages  = perPersonMedicareWages.reduce((s, w) => s + w, 0);
    const addlMedicareLiability  = additionalMedicareTaxOwed({
      combinedMedicareWages,
      filingStatus: "MFJ",
    });
    const addlMedicareWh = additionalMedicareTaxWithheld({ perPersonMedicareWages });
    const addlMedicare   = addlMedicareLiability - addlMedicareWh;
    const taxOwed        = bracketTax + addlMedicare;
    const gap            = taxGap(fedWh, taxOwed);
    return { taxableWage, fedWh, taxOwed, gap, bracketTax, addlMedicare };
  })() : null;

  if (authState !== "authenticated") return null;

  return (
    <FinanceLayout>
      <div className="px-4 py-5 md:px-6 max-w-5xl mx-auto">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
          <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
        </div>

        {/* Header */}
        <div className="flex items-baseline justify-between mb-5 gap-2 flex-wrap">
          <div>
            <PageTitle>Tax Outlook</PageTitle>
            <p className="text-xs text-gray-400 mt-0.5">
              {PLAN_TAX_YEAR_LABEL} · projected from each person's latest paycheck YTD columns.
              {!isCurrentYear && " · validation view (past year)"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Year</label>
            <select
              value={selectedYear}
              onChange={(e) => setSelectedYear(Number(e.target.value))}
              className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-1 text-gray-700 dark:text-gray-200"
            >
              {availableYears.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        </div>

        {loading && <PageLoading />}

        {!loading && byPerson.length === 0 && (
          <div className="rounded-lg border border-gray-200 dark:border-darkBorder p-8 text-center">
            <p className="text-sm text-gray-400">
              No paychecks for {selectedYear} yet.{" "}
              <NextLink href="/finance/paychecks" className="hover:underline" style={{ color: FINANCE_COLOR }}>Add one</NextLink>{" "}
              to {isCurrentYear ? "project this year's tax outlook" : "validate the model against this year's actuals"}.
            </p>
          </div>
        )}

        {/* Stale-paycheck warning — surfaces when the latest stub for any
            person is older than 30 days. Projections off old paychecks lie. */}
        {byPerson.some((p) => p.stale) && (
          <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/20 px-3 py-2 mb-5 text-xs text-amber-700 dark:text-amber-300">
            Heads up — at least one person's most recent paycheck is more than 30 days old. The projection assumes
            the YTD columns are current; numbers below may be misleading until you upload a fresher stub.
          </div>
        )}

        {/* 401k what-if slider — applies to all persons' projections */}
        {byPerson.length > 0 && (
          <div className="rounded-lg border border-gray-200 dark:border-darkBorder bg-gray-50/50 dark:bg-white/[0.02] p-4 mb-6">
            <div className="flex items-baseline justify-between flex-wrap gap-2 mb-2">
              <h3 className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">401k what-if</h3>
              <p className="text-[10px] text-gray-400">
                {byPerson.map((p, i) => {
                  const capPct = contribPctToReachCap({
                    ytd401k:        p.latest.ytd401k ?? 0,
                    ytdGross:       p.projection.ytdSalaryGross,
                    projectedGross: p.projection.projectedGross,
                    year:           selectedYear,
                  });
                  return (
                    <span key={p.person}>
                      {i > 0 && " · "}
                      {PAYCHECK_PERSON_LABELS[p.person]} now {(p.current401kPct * 100).toFixed(1)}%
                      {capPct == null
                        ? " · already at cap"
                        : ` · cap at ${(capPct * 100).toFixed(1)}%`}
                    </span>
                  );
                })}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={50}
                step={0.5}
                value={pctOverride < 0 ? defaultSliderPct * 100 : pctOverride * 100}
                onChange={(e) => setPctOverride(parseFloat(e.target.value) / 100)}
                className="flex-1 accent-purple dark:accent-rose"
              />
              <span className="tabular-nums text-sm font-semibold text-gray-800 dark:text-gray-200 w-20 text-right">
                {pctOverride < 0
                  ? `${(defaultSliderPct * 100).toFixed(1)}%`
                  : `${(pctOverride * 100).toFixed(1)}%`}
              </span>
              <button
                type="button"
                onClick={() => setPctOverride(-1)}
                disabled={pctOverride < 0}
                className="text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Reset
              </button>
            </div>
            <p className="text-[10px] text-gray-400 mt-2">
              Contributions clip at the IRS §402(g) limit ({fmtCurrency(irs401kElectiveLimit(selectedYear), "USD")} for {selectedYear}).
              Slider beyond the cap-hitting % only changes when in the year you'd hit it, not the year-end total.
              Federal withholding is held constant — directional view only.
            </p>
          </div>
        )}

        {/* Per-person sections */}
        <div className="flex flex-col gap-6 mb-6">
          {personOutcomes.map(({ person: p, current, slider }) => {
            const sliderActive = sliderOverride !== null && Math.abs(sliderOverride - p.current401kPct) > 1e-6;
            const ppy = p.projection.paychecksPerYear;
            const cadence = settings.rsuVestCadence[p.person] ?? "IRREGULAR";
            const hasSupplemental = (p.projection.ytdRsuGross > 0 || p.projection.ytdBonusGross > 0);
            return (
              <div key={p.person}>
                <div className="flex items-baseline justify-between mb-3 gap-2 flex-wrap">
                  <PersonHeader person={p.person} />
                  {/* RSU vest cadence selector — drives how YTD RSU income
                      projects to year-end. Only rendered when the person
                      has any RSU income on file. */}
                  {p.projection.ytdRsuGross > 0 && (
                    <div className="flex items-center gap-2">
                      <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">RSU vests</label>
                      <select
                        value={cadence}
                        onChange={(e) => setRsuVestCadence(p.person, e.target.value as RsuVestCadence)}
                        className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-1 text-gray-700 dark:text-gray-200"
                      >
                        {RSU_VEST_CADENCES.map((c) => (
                          <option key={c} value={c}>{RSU_VEST_CADENCE_LABELS[c]}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <Card title="Year-to-date" subtitle={`as of ${p.latest.payDate ?? "—"}`}>
                    <StatRow label="Salary gross" value={fmtCurrency(p.projection.ytdSalaryGross, "USD")} />
                    {hasSupplemental && (
                      <>
                        <StatRow label="RSU vested"  value={fmtCurrency(p.projection.ytdRsuGross, "USD")} hint={p.projection.vestsCompleted > 0 ? `(${p.projection.vestsCompleted} vest${p.projection.vestsCompleted === 1 ? "" : "s"})` : undefined} />
                        <StatRow label="Bonus"       value={fmtCurrency(p.projection.ytdBonusGross, "USD")} />
                        <StatRow label="Total earnings" value={fmtCurrency(p.projection.ytdSalaryGross + p.projection.ytdRsuGross + p.projection.ytdBonusGross, "USD")} />
                      </>
                    )}
                    <StatRow label="Taxable wage" value={fmtCurrency(p.latest.ytdTaxableWage ?? 0, "USD")} />
                    <StatRow label="Federal WH"   value={fmtCurrency(p.latest.ytdFedWh ?? 0, "USD")} />
                    <StatRow label="401k"         value={fmtCurrency(p.latest.ytd401k ?? 0, "USD")} hint={`(${(p.current401kPct * 100).toFixed(1)}%)`} />
                    <StatRow label="Net"          value={fmtCurrency(p.latest.ytdNet ?? 0, "USD")} />
                  </Card>

                  <Card title="Year-end projection" subtitle={`${p.projection.paychecksElapsed}/${ppy} paychecks`}>
                    <StatRow label="Salary gross" value={fmtCurrency(p.projection.projectedGross, "USD")} />
                    {hasSupplemental && (
                      <>
                        <StatRow
                          label="RSU (full year)"
                          value={fmtCurrency(p.projection.projectedRsuGross, "USD")}
                          hint={cadence === "IRREGULAR" || p.projection.vestsExpected === 0
                            ? "(YTD only — set cadence above)"
                            : `(${p.projection.vestsCompleted}/${p.projection.vestsExpected} vests)`}
                        />
                        <StatRow label="Bonus" value={fmtCurrency(p.projection.projectedBonusGross, "USD")} />
                        <StatRow label="Total earnings" value={fmtCurrency(p.projection.projectedTotalEarnings, "USD")} />
                      </>
                    )}
                    <StatRow label="Taxable wage" value={fmtCurrency(current.taxableWage, "USD")} />
                    <StatRow label="Federal WH"   value={fmtCurrency(p.projection.projectedFedWh, "USD")} />
                    <StatRow
                      label="401k"
                      value={fmtCurrency(current.new401k, "USD")}
                      hint={`/ ${fmtCurrency(current.irsLimit, "USD")}${current.capReached ? " · cap" : ""}`}
                    />
                    <StatRow label="Net"          value={fmtCurrency(p.projection.projectedNet, "USD")} />
                  </Card>

                  <Card
                    title={sliderActive ? `Tax outcome · ${(sliderOverride! * 100).toFixed(1)}% 401k` : "Tax outcome"}
                    subtitle="single-filer view"
                  >
                    <StatRow label="Taxable income" value={fmtCurrency(slider.taxableWage, "USD")} />
                    <StatRow label="Tax owed"       value={fmtCurrency(slider.taxOwed, "USD")} />
                    <StatRow label="Withheld"       value={fmtCurrency(slider.fedWh, "USD")} />
                    <div className="border-t border-gray-200 dark:border-darkBorder mt-1 pt-1.5">
                      <StatRow
                        label={slider.gap >= 0 ? "Refund" : "Owed at filing"}
                        value={fmtCurrency(Math.abs(slider.gap), "USD")}
                        color={amountColor(slider.gap)}
                      />
                    </div>
                    {sliderActive && (
                      <p className="text-[10px] text-gray-400 mt-1">
                        Δ vs current: {fmtCurrency(slider.taxOwed - current.taxOwed, "USD", true)} tax
                      </p>
                    )}
                  </Card>
                </div>
              </div>
            );
          })}
        </div>

        {/* Combined MFJ — only when both persons have current-year paychecks */}
        {combined && (
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-widest text-purple dark:text-rose mb-3">
              Married filing jointly · combined
            </h2>
            <Card title="MFJ outcome" subtitle="combined taxable wage at MFJ brackets">
              <StatRow label="Combined taxable income" value={fmtCurrency(combined.taxableWage, "USD")} />
              <StatRow label="MFJ tax owed"            value={fmtCurrency(combined.taxOwed, "USD")} />
              <StatRow label="Combined withheld"       value={fmtCurrency(combined.fedWh, "USD")} />
              <div className="border-t border-gray-200 dark:border-darkBorder mt-1 pt-1.5">
                <StatRow
                  label={combined.gap >= 0 ? "Refund" : "Owed at filing"}
                  value={fmtCurrency(Math.abs(combined.gap), "USD")}
                  color={amountColor(combined.gap)}
                />
              </div>
            </Card>
            <p className="text-[10px] text-gray-400 mt-2">
              MFJ brackets are progressive on combined wages — typically lower total tax than two single-filer projections summed.
            </p>
          </div>
        )}
      </div>
    </FinanceLayout>
  );
}
