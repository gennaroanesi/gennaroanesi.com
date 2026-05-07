import React, { useCallback, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useS3JsonState, type S3SyncStatus } from "@/hooks/useS3JsonState";
import FinanceLayout from "@/layouts/finance";
import SimulatorTabs from "@/components/finance/SimulatorTabs";
import {
  FINANCE_COLOR,
  fmtCurrency,
  amountColor,
} from "@/components/finance/_shared";
import {
  defaultPlanScenario,
  projectYear,
  planYears,
  valueAtYear,
  FILING_STATUSES,
  FILING_STATUS_LABELS,
  PLAN_TAX_YEAR_LABEL,
  type PlanScenario,
  type SalaryJump,
  type SpendCategory,
  type YearMap,
  type FilingStatus,
} from "@/components/finance/planning";

// ── Persistence config ──────────────────────────────────────────────────────

const S3_BUCKET     = "gennaroanesi.com";
const S3_PATH       = "simulator-state/planning.json";
const LOCAL_KEY     = "finance:simulator:planning:v1";
const ACTIVE_LS_KEY = "finance:simulator:planning:active";

function makeId(prefix = "p"): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

function defaultScenarios(): PlanScenario[] {
  return [defaultPlanScenario(makeId("s"), new Date().getFullYear())];
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function PlanningSimulatorPage() {
  const { authState } = useRequireAuth();

  const { value: scenarios, setValue: setScenarios, status: syncStatus, lastSavedAt } =
    useS3JsonState<PlanScenario[]>(S3_PATH, defaultScenarios, {
      bucket: S3_BUCKET,
      localStorageKey: LOCAL_KEY,
      enabled: authState === "authenticated",
    });

  useEffect(() => {
    if (Array.isArray(scenarios) && scenarios.length === 0) {
      setScenarios(defaultScenarios());
    }
  }, [scenarios, setScenarios]);

  const [activeId, setActiveId] = useState<string>("");
  useEffect(() => {
    const hasActive = !!activeId && scenarios.some((s) => s.id === activeId);
    if (hasActive) return;
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(ACTIVE_LS_KEY);
    if (saved && scenarios.some((s) => s.id === saved)) {
      setActiveId(saved);
    } else if (scenarios.length > 0) {
      setActiveId(scenarios[0].id);
    }
  }, [scenarios, activeId]);
  useEffect(() => {
    if (typeof window === "undefined" || !activeId) return;
    window.localStorage.setItem(ACTIVE_LS_KEY, activeId);
  }, [activeId]);

  const active = useMemo(
    () => scenarios.find((s) => s.id === activeId) ?? scenarios[0],
    [scenarios, activeId],
  );

  const updateActive = useCallback((updater: (prev: PlanScenario) => PlanScenario) => {
    setScenarios((prev) => prev.map((s) => (s.id === activeId ? updater(s) : s)));
  }, [activeId, setScenarios]);

  const addScenario = useCallback(() => {
    const newId = makeId("s");
    setScenarios((prev) => {
      const seed = defaultPlanScenario(newId, prev[0]?.startYear ?? new Date().getFullYear());
      seed.name = `Trajectory ${prev.length + 1}`;
      return [...prev, seed];
    });
    setActiveId(newId);
  }, [setScenarios]);

  const deleteScenario = useCallback((id: string) => {
    if (scenarios.length <= 1) {
      alert("Can't delete the last scenario — clear its data instead.");
      return;
    }
    const s = scenarios.find((x) => x.id === id);
    if (!confirm(`Delete scenario "${s?.name ?? id}"?`)) return;
    const remaining = scenarios.filter((x) => x.id !== id);
    setScenarios(remaining);
    if (activeId === id) setActiveId(remaining[0].id);
  }, [scenarios, activeId, setScenarios]);

  const renameActive = useCallback((name: string) => {
    updateActive((s) => ({ ...s, name }));
  }, [updateActive]);

  if (authState !== "authenticated" || !active) return null;

  const years = planYears(active);
  const breakdowns = years.map((y) => projectYear(active, y));

  // Spending categories store MONTHLY amounts (negative = expense). Annual
  // is just × 12. Per-month values are the headline number for the grid.
  const monthlySpendByYear = years.map((y) =>
    active.spend.reduce((sum, c) => sum + valueAtYear(c.byYear, y, 0), 0),
  );
  const annualSpendByYear = monthlySpendByYear.map((s) => s * 12);

  // Monthly view runs on salary net only — bonus / stocks are lumpy and
  // shouldn't be averaged into "what's left at the end of a normal month."
  // Annual reference still uses annualNet (all-in) for the yearly bottom line.
  const monthlySalaryNetByYear = breakdowns.map((b) => b.annualSalaryNet / 12);
  const monthlySurplusByYear   = monthlySalaryNetByYear.map((n, i) => n + monthlySpendByYear[i]);
  const annualSurplusByYear    = breakdowns.map((b, i) => b.annualNet + annualSpendByYear[i]);

  const cumulativeAnnualSurplusByYear: number[] = [];
  annualSurplusByYear.reduce((acc, v) => {
    cumulativeAnnualSurplusByYear.push(acc + v);
    return acc + v;
  }, 0);

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

          <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
            <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
            <span>›</span>
            <span>Simulator</span>
            <span>›</span>
            <span>Long-term planning</span>
          </div>

          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
            <div>
              <h1 className="text-2xl font-bold text-purple dark:text-rose">Long-term Planning</h1>
              <p className="text-xs text-gray-400 mt-0.5">
                Multi-year salary trajectory + paycheck math + spending. Macro view —
                pure scratchpad, no transactions touched. Withholding uses {PLAN_TAX_YEAR_LABEL}.
              </p>
            </div>
            <SyncStatusChip status={syncStatus} lastSavedAt={lastSavedAt} />
          </div>

          <SimulatorTabs />

          {/* ── Scenario tabs ───────────────────────────────────────── */}
          <div className="mb-4 flex items-center gap-1 overflow-x-auto pb-1">
            {scenarios.map((s) => {
              const isActive = s.id === active.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveId(s.id)}
                  className={[
                    "flex-shrink-0 px-3 py-1.5 rounded-t border-b-2 text-xs font-medium transition-colors",
                    isActive ? "" : "border-transparent text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5",
                  ].join(" ")}
                  style={isActive ? { borderColor: FINANCE_COLOR, color: FINANCE_COLOR } : undefined}
                >
                  {s.name}
                </button>
              );
            })}
            <button
              onClick={addScenario}
              className="flex-shrink-0 px-3 py-1.5 text-xs font-semibold text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
              title="Add a new trajectory"
            >
              + Add
            </button>
          </div>

          {/* ── Scenario header ─────────────────────────────────────── */}
          <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
            <input
              type="text"
              value={active.name}
              onChange={(e) => renameActive(e.target.value)}
              placeholder="Scenario name"
              className="bg-transparent border-b border-gray-200 dark:border-darkBorder text-base font-semibold text-gray-700 dark:text-gray-200 focus:outline-none focus:border-emerald-500 px-1 py-0.5 max-w-sm w-full"
            />
            <button
              onClick={() => deleteScenario(active.id)}
              disabled={scenarios.length <= 1}
              className="text-[11px] text-gray-400 hover:text-red-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title={scenarios.length <= 1 ? "Can't delete the last scenario" : "Delete this scenario"}
            >
              Delete scenario
            </button>
          </div>

          {/* ── Editors (4 cards) ───────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
            <SalaryCard scenario={active} update={updateActive} />
            <PaycheckCard scenario={active} update={updateActive} />
            <SupplementalCard scenario={active} update={updateActive} />
            <HorizonCard scenario={active} update={updateActive} />
          </div>

          <SpendCard scenario={active} update={updateActive} />

          {/* ── Year grid output ────────────────────────────────────── */}
          <YearGrid
            scenario={active}
            years={years}
            breakdowns={breakdowns}
            monthlySpendByYear={monthlySpendByYear}
            annualSpendByYear={annualSpendByYear}
            monthlySalaryNetByYear={monthlySalaryNetByYear}
            monthlySurplusByYear={monthlySurplusByYear}
            annualSurplusByYear={annualSurplusByYear}
            cumulativeAnnualSurplusByYear={cumulativeAnnualSurplusByYear}
          />

          <p className="text-[10px] text-gray-400 mt-4">
            Tip: this is a macro picture, not a precise withholding calc. Federal tax uses the
            percentage method on annualized wage minus the standard deduction. Use the
            "Extra withholding" field to fine-tune toward your actual paycheck.
          </p>
        </div>
      </div>
    </FinanceLayout>
  );
}

// ── Salary editor ──────────────────────────────────────────────────────────

function SalaryCard({ scenario, update }: {
  scenario: PlanScenario;
  update:   (u: (prev: PlanScenario) => PlanScenario) => void;
}) {
  const s = scenario.salary;
  const setBaseAmount = (n: number) =>
    update((p) => ({ ...p, salary: { ...p.salary, baseAmount: n } }));
  const setGrowth = (n: number) =>
    update((p) => ({ ...p, salary: { ...p.salary, defaultGrowthPct: n } }));
  const addJump = () =>
    update((p) => ({
      ...p,
      salary: {
        ...p.salary,
        jumps: [...p.salary.jumps, { year: p.startYear + p.salary.jumps.length + 1, amount: p.salary.baseAmount, label: "" }],
      },
    }));
  const updateJump = (i: number, patch: Partial<SalaryJump>) =>
    update((p) => ({
      ...p,
      salary: { ...p.salary, jumps: p.salary.jumps.map((j, idx) => (idx === i ? { ...j, ...patch } : j)) },
    }));
  const removeJump = (i: number) =>
    update((p) => ({ ...p, salary: { ...p.salary, jumps: p.salary.jumps.filter((_, idx) => idx !== i) } }));

  const sortedJumps = [...s.jumps].sort((a, b) => a.year - b.year);

  return (
    <Card title="Salary trajectory">
      <Row label="Base amount">
        <CurrencyInput value={s.baseAmount} onChange={setBaseAmount} />
      </Row>
      <Row label="Default growth">
        <PercentInput value={s.defaultGrowthPct} onChange={setGrowth} />
        <span className="text-[10px] text-gray-400 ml-2">applied to non-jump years</span>
      </Row>

      <div className="mt-3">
        <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium mb-2">Jumps (promotions / job changes)</p>
        <div className="flex flex-col gap-2">
          {sortedJumps.length === 0 && (
            <p className="text-xs text-gray-400 italic">No jumps yet — add one to override default growth in a specific year.</p>
          )}
          {sortedJumps.map((j) => {
            const i = s.jumps.indexOf(j);
            return (
              <div key={i} className="flex items-center gap-2 flex-wrap">
                <NumberInput
                  value={j.year}
                  onChange={(n) => updateJump(i, { year: n })}
                  className="w-20"
                  inputMode="numeric"
                />
                <CurrencyInput value={j.amount} onChange={(n) => updateJump(i, { amount: n })} className="w-32" />
                <input
                  type="text"
                  value={j.label ?? ""}
                  placeholder="Label (optional)"
                  onChange={(e) => updateJump(i, { label: e.target.value })}
                  className="flex-1 min-w-[120px] bg-transparent border border-gray-200 dark:border-darkBorder rounded px-2 py-1 text-xs"
                />
                <button onClick={() => removeJump(i)} className="text-xs text-gray-400 hover:text-red-500" title="Remove jump">×</button>
              </div>
            );
          })}
          <button
            onClick={addJump}
            className="self-start text-[11px] font-semibold px-2 py-1 rounded border transition-colors"
            style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR }}
          >
            + Add jump
          </button>
        </div>
      </div>
    </Card>
  );
}

// ── Paycheck editor ────────────────────────────────────────────────────────

function PaycheckCard({ scenario, update }: {
  scenario: PlanScenario;
  update:   (u: (prev: PlanScenario) => PlanScenario) => void;
}) {
  const p = scenario.paycheck;
  const setField = <K extends keyof typeof p>(k: K, v: (typeof p)[K]) =>
    update((prev) => ({ ...prev, paycheck: { ...prev.paycheck, [k]: v } }));

  return (
    <Card title="Paycheck">
      <Row label="Filing status">
        <select
          value={p.filingStatus}
          onChange={(e) => setField("filingStatus", e.target.value as FilingStatus)}
          className="bg-transparent border border-gray-200 dark:border-darkBorder rounded px-2 py-1 text-xs"
        >
          {FILING_STATUSES.map((fs) => (
            <option key={fs} value={fs}>{FILING_STATUS_LABELS[fs]}</option>
          ))}
        </select>
      </Row>
      <Row label="Paychecks / yr">
        <NumberInput value={p.paychecksPerYear} onChange={(n) => setField("paychecksPerYear", n)} className="w-20" />
        <span className="text-[10px] text-gray-400 ml-2">26 = biweekly</span>
      </Row>

      <Divider />

      <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium mb-2">Pre-tax contributions (% of salary)</p>
      <YearMapEditor
        label="401k"
        startYear={scenario.startYear}
        valueLabel="%"
        valueScale="percent"
        map={p.contrib401kPct}
        onChange={(m) => setField("contrib401kPct", m)}
      />
      <YearMapEditor
        label="After-tax 401k"
        startYear={scenario.startYear}
        valueLabel="%"
        valueScale="percent"
        map={p.contribAfterTaxPct}
        onChange={(m) => setField("contribAfterTaxPct", m)}
      />

      <Divider />

      <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium mb-2">Per-paycheck premiums</p>
      <Row label="Imp GTL">
        <CurrencyInput value={p.impGtlPerCheck} onChange={(n) => setField("impGtlPerCheck", n)} className="w-28" />
      </Row>
      <Row label="Dental">
        <CurrencyInput value={p.dentalPerCheck} onChange={(n) => setField("dentalPerCheck", n)} className="w-28" />
      </Row>
      <Row label="Vision">
        <CurrencyInput value={p.visionPerCheck} onChange={(n) => setField("visionPerCheck", n)} className="w-28" />
      </Row>
      <YearMapEditor
        label="Medical"
        startYear={scenario.startYear}
        valueLabel="$"
        valueScale="currency"
        map={p.medicalPerCheck}
        onChange={(m) => setField("medicalPerCheck", m)}
      />

      <Divider />

      <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium mb-2">Other</p>
      <Row label="401k loan / check">
        <CurrencyInput value={p.loan401kPerCheck} onChange={(n) => setField("loan401kPerCheck", n)} className="w-28" />
      </Row>
      <Row label="Loan ends after">
        <NumberInput
          value={p.loan401kEndYear ?? 0}
          onChange={(n) => setField("loan401kEndYear", n || null)}
          className="w-20"
        />
        <span className="text-[10px] text-gray-400 ml-2">0 = ongoing</span>
      </Row>
      <YearMapEditor
        label="Extra withholding / check"
        startYear={scenario.startYear}
        valueLabel="$"
        valueScale="currency"
        map={p.extraWithholdingPerCheck}
        onChange={(m) => setField("extraWithholdingPerCheck", m)}
      />
    </Card>
  );
}

// ── Supplemental income editor (bonus + RSU vesting) ──────────────────────

function SupplementalCard({ scenario, update }: {
  scenario: PlanScenario;
  update:   (u: (prev: PlanScenario) => PlanScenario) => void;
}) {
  const setBonus = (m: YearMap) =>
    update((p) => ({ ...p, bonusByYear: m }));
  const setStocks = (m: YearMap) =>
    update((p) => ({ ...p, stocksByYear: m }));

  return (
    <Card
      title="Supplemental income"
      subtitle="Annual gross amounts. Taxed via the IRS supplemental wage method (22% flat federal + remaining OASDI cap headroom + Medicare). The grid shows both gross and after-tax."
    >
      <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">Bonus (gross)</p>
      <YearMapEditor
        label=""
        startYear={scenario.startYear}
        valueLabel="$"
        valueScale="currency"
        map={scenario.bonusByYear ?? {}}
        onChange={setBonus}
      />

      <Divider />

      <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">Stocks / RSU vesting (gross)</p>
      <YearMapEditor
        label=""
        startYear={scenario.startYear}
        valueLabel="$"
        valueScale="currency"
        map={scenario.stocksByYear ?? {}}
        onChange={setStocks}
      />
    </Card>
  );
}

// ── Horizon editor ─────────────────────────────────────────────────────────

function HorizonCard({ scenario, update }: {
  scenario: PlanScenario;
  update:   (u: (prev: PlanScenario) => PlanScenario) => void;
}) {
  return (
    <Card title="Horizon">
      <Row label="Start year">
        <NumberInput
          value={scenario.startYear}
          onChange={(n) => update((p) => ({
            ...p,
            startYear: n,
            salary: { ...p.salary, baseYear: n },
          }))}
          className="w-24"
        />
      </Row>
      <Row label="Years to project">
        <NumberInput
          value={scenario.horizonYears}
          onChange={(n) => update((p) => ({ ...p, horizonYears: Math.max(1, Math.min(40, n)) }))}
          className="w-24"
        />
        <span className="text-[10px] text-gray-400 ml-2">1–40</span>
      </Row>
    </Card>
  );
}

// ── Spending editor ────────────────────────────────────────────────────────

function SpendCard({ scenario, update }: {
  scenario: PlanScenario;
  update:   (u: (prev: PlanScenario) => PlanScenario) => void;
}) {
  const addCategory = () =>
    update((p) => ({
      ...p,
      spend: [...p.spend, { id: makeId("c"), label: "New category", byYear: { [p.startYear]: 0 } }],
    }));
  const updateCategory = (id: string, patch: Partial<SpendCategory>) =>
    update((p) => ({ ...p, spend: p.spend.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const removeCategory = (id: string) =>
    update((p) => ({ ...p, spend: p.spend.filter((c) => c.id !== id) }));

  return (
    <Card title="Spending categories" subtitle="Monthly amounts. Negative = expense, positive = income (e.g. side gig). Empty year = carry forward from previous setting.">
      {scenario.spend.length === 0 && (
        <p className="text-xs text-gray-400 italic">No categories yet — add Mortgage, Bills, Savings, etc. to model your monthly outflows.</p>
      )}
      <div className="flex flex-col gap-3">
        {scenario.spend.map((c) => (
          <div key={c.id} className="border border-gray-200 dark:border-darkBorder rounded p-3">
            <div className="flex items-center gap-2 mb-2">
              <input
                type="text"
                value={c.label}
                placeholder="Category"
                onChange={(e) => updateCategory(c.id, { label: e.target.value })}
                className="flex-1 bg-transparent border-b border-gray-200 dark:border-darkBorder font-semibold text-sm focus:outline-none focus:border-emerald-500 px-1 py-0.5"
              />
              <button
                onClick={() => removeCategory(c.id)}
                className="text-xs text-gray-400 hover:text-red-500"
                title="Remove category"
              >
                Remove
              </button>
            </div>
            <YearMapEditor
              label=""
              startYear={scenario.startYear}
              valueLabel="$"
              valueScale="currency"
              map={c.byYear}
              onChange={(m) => updateCategory(c.id, { byYear: m })}
            />
          </div>
        ))}
      </div>
      <button
        onClick={addCategory}
        className="mt-3 text-[11px] font-semibold px-2 py-1 rounded border transition-colors"
        style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR }}
      >
        + Add category
      </button>
    </Card>
  );
}

// ── Year grid output ──────────────────────────────────────────────────────

function YearGrid({
  scenario, years, breakdowns,
  monthlySpendByYear, annualSpendByYear,
  monthlySalaryNetByYear, monthlySurplusByYear,
  annualSurplusByYear, cumulativeAnnualSurplusByYear,
}: {
  scenario: PlanScenario;
  years: number[];
  breakdowns: ReturnType<typeof projectYear>[];
  monthlySpendByYear:     number[];
  annualSpendByYear:      number[];
  monthlySalaryNetByYear: number[];
  monthlySurplusByYear:   number[];
  annualSurplusByYear:    number[];
  cumulativeAnnualSurplusByYear: number[];
}) {
  type RowDef = {
    label: string;
    values: number[];
    bold?: boolean;
    accent?: boolean;
    section?: boolean;
    color?: (v: number) => string;
  };

  const rows: RowDef[] = [
    { label: "Monthly view", values: [], section: true },
    { label: "Monthly salary net", values: monthlySalaryNetByYear, bold: true, accent: true },

    ...scenario.spend.map((c): RowDef => ({
      label: c.label,
      values: years.map((y) => valueAtYear(c.byYear, y, 0)),
      color: amountColor,
    })),
    { label: "Total monthly spend", values: monthlySpendByYear, bold: true, color: amountColor },

    { label: "Monthly surplus", values: monthlySurplusByYear, bold: true, accent: true, color: amountColor },

    { label: "Annual reference", values: [], section: true },
    { label: "Annual salary", values: breakdowns.map((b) => b.annualSalary) },
    { label: "Salary net (take-home)", values: breakdowns.map((b) => b.annualSalaryNet) },
    { label: "Bonus (gross)", values: breakdowns.map((b) => b.bonusGross), color: amountColor },
    { label: "Stocks (gross)", values: breakdowns.map((b) => b.stocksGross), color: amountColor },
    { label: "Supplemental net", values: breakdowns.map((b) => b.supplementalNet), color: amountColor },
    { label: "Annual net (all-in)", values: breakdowns.map((b) => b.annualNet), bold: true },
    { label: "Annual spend", values: annualSpendByYear, color: amountColor },
    { label: "Annual surplus", values: annualSurplusByYear, bold: true, color: amountColor },
    { label: "Cumulative surplus", values: cumulativeAnnualSurplusByYear, bold: true, color: amountColor },

    { label: "Annual contributions", values: [], section: true },
    { label: "Annual 401k", values: breakdowns.map((b) => b.annual401k), color: amountColor },
    { label: "Annual after-tax 401k", values: breakdowns.map((b) => b.annualAfterTax401k), color: amountColor },
    { label: "Annual extra WH", values: breakdowns.map((b) => b.annualExtraWh), color: amountColor },

    { label: "Supplemental withholding (annual)", values: [], section: true },
    { label: "Supplemental fed WH", values: breakdowns.map((b) => -b.supplementalFedWh), color: amountColor },
    { label: "Supplemental OASDI", values: breakdowns.map((b) => -b.supplementalOasdi), color: amountColor },
    { label: "Supplemental Medicare", values: breakdowns.map((b) => -b.supplementalMedicare), color: amountColor },

    { label: "Per-paycheck breakdown", values: [], section: true },
    { label: "Gross paycheck", values: breakdowns.map((b) => b.grossPaycheck) },
    { label: "401k / check", values: breakdowns.map((b) => -b.contrib401kPerCheck), color: amountColor },
    { label: "Premiums / check", values: breakdowns.map((b) => -b.premiumsPerCheck), color: amountColor },
    { label: "Imp GTL / check", values: breakdowns.map((b) => b.impGtlPerCheck), color: amountColor },
    { label: "Taxable wage", values: breakdowns.map((b) => b.taxableWagePerCheck) },
    { label: "Federal WH / check", values: breakdowns.map((b) => -b.fedWhPerCheck), color: amountColor },
    { label: "OASDI / check", values: breakdowns.map((b) => -b.oasdiPerCheck), color: amountColor },
    { label: "Medicare / check", values: breakdowns.map((b) => -b.medicarePerCheck), color: amountColor },
    { label: "Extra WH / check", values: breakdowns.map((b) => -b.extraWhPerCheck), color: amountColor },
    { label: "Post-tax / check", values: breakdowns.map((b) => b.postTaxPerCheck) },
    { label: "401k loan / check", values: breakdowns.map((b) => -b.loan401kPerCheck), color: amountColor },
    { label: "After-tax 401k / check", values: breakdowns.map((b) => -b.afterTax401kPerCheck), color: amountColor },
    { label: "Net paycheck (salary only)", values: breakdowns.map((b) => b.netPaycheck), bold: true },
  ];

  return (
    <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-x-auto mt-4">
      <table className="text-xs min-w-full">
        <thead className="bg-gray-50 dark:bg-darkElevated sticky top-0">
          <tr>
            <th className="px-3 py-2 text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium sticky left-0 bg-gray-50 dark:bg-darkElevated z-10 min-w-[180px]">
              Item
            </th>
            {years.map((y) => (
              <th key={y} className="px-3 py-2 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium tabular-nums min-w-[88px]">
                {y}
                {scenario.salary.jumps.find((j) => j.year === y) && (
                  <span title={scenario.salary.jumps.find((j) => j.year === y)?.label || "Jump year"} className="ml-1" style={{ color: FINANCE_COLOR }}>★</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            if (r.section) {
              return (
                <tr key={i} className="bg-gray-50 dark:bg-darkElevated">
                  <td colSpan={years.length + 1} className="px-3 py-1 text-[10px] uppercase tracking-widest text-gray-500 font-medium">
                    {r.label}
                  </td>
                </tr>
              );
            }
            return (
              <tr key={i} className="hover:bg-gray-50 dark:hover:bg-white/5">
                <td className={[
                  "px-3 py-1 sticky left-0 bg-white dark:bg-darkBg z-10",
                  r.bold ? "font-semibold" : "",
                  r.accent ? "" : "text-gray-700 dark:text-gray-200",
                ].join(" ")}
                style={r.accent ? { color: FINANCE_COLOR } : undefined}>
                  {r.label}
                </td>
                {r.values.map((v, j) => (
                  <td key={j} className="px-3 py-1 text-right tabular-nums" style={r.color ? { color: r.color(v) } : undefined}>
                    {fmtCurrency(v)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Reusable input bits ────────────────────────────────────────────────────

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-darkBorder p-4 bg-white dark:bg-darkSurface">
      <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1">{title}</h2>
      {subtitle && <p className="text-[10px] text-gray-400 mb-3">{subtitle}</p>}
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <label className="text-xs text-gray-500 dark:text-gray-400 w-32 flex-shrink-0">{label}</label>
      {children}
    </div>
  );
}

function Divider() {
  return <hr className="border-gray-200 dark:border-darkBorder my-3" />;
}

function NumberInput({
  value, onChange, className, inputMode = "numeric",
}: { value: number; onChange: (n: number) => void; className?: string; inputMode?: "numeric" | "decimal" }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="text"
      inputMode={inputMode}
      value={draft ?? String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const n = Number(raw.replace(/[^\d.-]/g, ""));
        if (Number.isFinite(n)) onChange(n);
      }}
      onBlur={() => setDraft(null)}
      className={[
        "bg-transparent border border-gray-200 dark:border-darkBorder rounded px-2 py-1 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-emerald-500",
        className ?? "w-24",
      ].join(" ")}
    />
  );
}

function CurrencyInput({
  value, onChange, className,
}: { value: number; onChange: (n: number) => void; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? (value === 0 ? "" : value.toFixed(2));
  return (
    <input
      type="text"
      inputMode="decimal"
      placeholder="0"
      value={display}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const n = Number(raw.replace(/[$,\s]/g, ""));
        if (Number.isFinite(n)) onChange(n);
      }}
      onBlur={() => setDraft(null)}
      className={[
        "bg-transparent border border-gray-200 dark:border-darkBorder rounded px-2 py-1 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-emerald-500 text-right",
        className ?? "w-32",
      ].join(" ")}
    />
  );
}

function PercentInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? (value === 0 ? "" : (value * 100).toFixed(1));
  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        inputMode="decimal"
        placeholder="0"
        value={display}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const n = Number(raw.replace(/[^\d.-]/g, ""));
          if (Number.isFinite(n)) onChange(n / 100);
        }}
        onBlur={() => setDraft(null)}
        className="bg-transparent border border-gray-200 dark:border-darkBorder rounded px-2 py-1 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-emerald-500 text-right w-20"
      />
      <span className="text-xs text-gray-400">%</span>
    </div>
  );
}

// Editor for a sparse YearMap. Each row is { year, value } with carry-forward
// semantics — adding a year applies from that year forward until the next
// entry overrides it.
function YearMapEditor({
  label, startYear, valueLabel, valueScale, map, onChange,
}: {
  label:      string;
  startYear:  number;
  valueLabel: string;
  valueScale: "currency" | "percent";
  map:        YearMap;
  onChange:   (next: YearMap) => void;
}) {
  const entries = Object.keys(map)
    .map((k) => ({ year: Number(k), value: map[Number(k)] }))
    .sort((a, b) => a.year - b.year);

  const setEntry = (origYear: number, nextYear: number, nextValue: number) => {
    const next: YearMap = { ...map };
    delete next[origYear];
    next[nextYear] = nextValue;
    onChange(next);
  };
  const removeEntry = (year: number) => {
    const next = { ...map };
    delete next[year];
    onChange(next);
  };
  const addEntry = () => {
    const lastYear = entries.length ? entries[entries.length - 1].year : startYear - 1;
    const lastValue = entries.length ? entries[entries.length - 1].value : 0;
    onChange({ ...map, [lastYear + 1]: lastValue });
  };

  return (
    <div className="mb-2">
      {label && <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">{label}</p>}
      <div className="flex flex-col gap-1">
        {entries.length === 0 && (
          <p className="text-[11px] text-gray-400 italic">— no entries —</p>
        )}
        {entries.map((e) => (
          <div key={e.year} className="flex items-center gap-2">
            <NumberInput
              value={e.year}
              onChange={(y) => setEntry(e.year, y, e.value)}
              className="w-20"
            />
            {valueScale === "percent" ? (
              <PercentInput value={e.value} onChange={(v) => setEntry(e.year, e.year, v)} />
            ) : (
              <CurrencyInput
                value={e.value}
                onChange={(v) => setEntry(e.year, e.year, v)}
                className="w-32"
              />
            )}
            <span className="text-[10px] text-gray-400 flex-1">{valueLabel === "$" ? "" : valueLabel}</span>
            <button
              onClick={() => removeEntry(e.year)}
              className="text-xs text-gray-400 hover:text-red-500"
              title="Remove entry"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={addEntry}
        className="mt-1 text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
      >
        + Add change
      </button>
    </div>
  );
}

// ── Sync chip (shared with cashflow visually) ──────────────────────────────

function SyncStatusChip({ status, lastSavedAt }: { status: S3SyncStatus; lastSavedAt: Date | null }) {
  const config: Record<S3SyncStatus, { label: string; color: string; pulse?: boolean }> = {
    loading:      { label: "Loading…",     color: "#9ca3af", pulse: true },
    saving:       { label: "Saving…",      color: "#9ca3af", pulse: true },
    synced:       { label: "✓ Synced",     color: FINANCE_COLOR },
    "local-only": { label: "⚠ Local only", color: "#f59e0b" },
    error:        { label: "× Error",      color: "#ef4444" },
  };
  const c = config[status];
  const tooltip = lastSavedAt && status === "synced"
    ? `Last saved to S3 at ${lastSavedAt.toLocaleTimeString()}`
    : status === "local-only"
    ? "S3 unreachable — changes are only in this browser. Will retry on next edit."
    : undefined;
  return (
    <span
      className={["text-[10px] font-medium tabular-nums", c.pulse ? "animate-pulse" : ""].join(" ")}
      style={{ color: c.color }}
      title={tooltip}
    >
      {c.label}
    </span>
  );
}

