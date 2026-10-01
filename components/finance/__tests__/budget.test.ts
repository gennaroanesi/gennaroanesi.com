import { describe, it, expect } from "vitest";
import {
  isInForce, resolveBudgetLines, validateBudgetHistory, planBudgetChange,
  budgetWindow, cycleWindow, elapsedFraction, spendByCategory, committedByCategory,
  previousDay, monthStart, monthEnd, daysBetween, DEFAULT_PERIOD,
  seedFromHistory, computeLineView, summarizePools, unassignedCategories,
  type BudgetLine,
} from "@/components/finance/budget";

const line = (over: Partial<BudgetLine> & { id: string }): BudgetLine => ({
  category: "Dining", fundingSource: "SALARY", amount: 500, period: "MONTHLY",
  rollover: false, effectiveFrom: "2026-01-01", effectiveTo: null, active: true, ...over,
});

describe("isInForce", () => {
  const l = line({ id: "a", effectiveFrom: "2026-03-01", effectiveTo: "2026-05-31" });

  it("covers the range inclusively at both ends", () => {
    expect(isInForce(l, "2026-02-28")).toBe(false);
    expect(isInForce(l, "2026-03-01")).toBe(true);
    expect(isInForce(l, "2026-05-31")).toBe(true);
    expect(isInForce(l, "2026-06-01")).toBe(false);
  });

  it("treats a null effectiveTo as open-ended, never as a sentinel date", () => {
    const open = line({ id: "b", effectiveFrom: "2026-03-01", effectiveTo: null });
    expect(isInForce(open, "2999-12-31")).toBe(true);
  });

  it("reads `active` as paused, not as is-current", () => {
    // The row is squarely inside its range; only `active` excludes it.
    expect(isInForce({ ...l, active: false }, "2026-04-01")).toBe(false);
  });

  it("is not in force before it starts, even open-ended — this is how a future budget is staged", () => {
    expect(isInForce(line({ id: "c", effectiveFrom: "2027-03-01" }), "2026-09-30")).toBe(false);
  });
});

describe("resolveBudgetLines", () => {
  it("picks the version in force on the date, not the newest row", () => {
    const lines = [
      line({ id: "v1", amount: 400, effectiveFrom: "2026-01-01", effectiveTo: "2026-02-28" }),
      line({ id: "v2", amount: 540, effectiveFrom: "2026-03-01", effectiveTo: null }),
    ];
    expect(resolveBudgetLines(lines, "2026-02-15")[0].amount).toBe(400);
    expect(resolveBudgetLines(lines, "2026-03-15")[0].amount).toBe(540);
  });

  it("keeps one line per (category, fundingSource) — a category may draw on two pools", () => {
    const lines = [
      line({ id: "a", category: "Travel", fundingSource: "SALARY", amount: 400 }),
      line({ id: "b", category: "Travel", fundingSource: "RSU", amount: 3000, period: "CYCLE" }),
      line({ id: "c", category: "Dining", fundingSource: "SALARY", amount: 500 }),
    ];
    const got = resolveBudgetLines(lines, "2026-06-01");
    expect(got).toHaveLength(3);
    const travel = got.filter((l) => l.category === "Travel");
    expect(travel).toHaveLength(2);
    expect(travel.reduce((s, l) => s + (l.amount ?? 0), 0)).toBe(3400);
  });

  it("breaks an overlap by latest effectiveFrom, so a half-applied change is harmless", () => {
    // What insert-new-then-close-old leaves behind when the close fails.
    const lines = [
      line({ id: "old", amount: 400, effectiveFrom: "2026-01-01", effectiveTo: null }),
      line({ id: "new", amount: 540, effectiveFrom: "2026-03-01", effectiveTo: null }),
    ];
    const got = resolveBudgetLines(lines, "2026-03-15");
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe("new");
  });

  it("returns nothing for a category that is not yet budgeted", () => {
    expect(resolveBudgetLines([line({ id: "a", effectiveFrom: "2027-01-01" })], "2026-09-30")).toEqual([]);
  });
});

describe("validateBudgetHistory", () => {
  it("passes a clean series", () => {
    expect(validateBudgetHistory([
      line({ id: "v1", effectiveFrom: "2026-01-01", effectiveTo: "2026-02-28" }),
      line({ id: "v2", effectiveFrom: "2026-03-01", effectiveTo: null }),
    ])).toEqual([]);
  });

  it("flags two open-ended rows in one series", () => {
    const issues = validateBudgetHistory([
      line({ id: "a", effectiveFrom: "2026-01-01", effectiveTo: null }),
      line({ id: "b", effectiveFrom: "2026-03-01", effectiveTo: null }),
    ]);
    expect(issues.map((i) => i.kind)).toContain("multiple-open");
  });

  it("flags an overlap", () => {
    const issues = validateBudgetHistory([
      line({ id: "a", effectiveFrom: "2026-01-01", effectiveTo: "2026-03-15" }),
      line({ id: "b", effectiveFrom: "2026-03-01", effectiveTo: "2026-06-30" }),
    ]);
    expect(issues.some((i) => i.kind === "overlap")).toBe(true);
  });

  it("flags a reversed range and a missing effectiveFrom", () => {
    const issues = validateBudgetHistory([
      line({ id: "a", effectiveFrom: "2026-05-01", effectiveTo: "2026-01-01" }),
      line({ id: "b", category: "Golf", effectiveFrom: null }),
    ]);
    expect(issues.map((i) => i.kind)).toEqual(
      expect.arrayContaining(["reversed-range", "missing-from"]),
    );
  });

  it("does NOT flag a gap — an unbudgeted stretch is legitimate", () => {
    expect(validateBudgetHistory([
      line({ id: "a", effectiveFrom: "2026-01-01", effectiveTo: "2026-02-28" }),
      line({ id: "b", effectiveFrom: "2026-06-01", effectiveTo: null }),
    ])).toEqual([]);
  });

  it("ignores paused rows, which may legitimately overlap live ones", () => {
    expect(validateBudgetHistory([
      line({ id: "a", effectiveFrom: "2026-01-01", effectiveTo: null }),
      line({ id: "b", effectiveFrom: "2026-01-01", effectiveTo: null, active: false }),
    ])).toEqual([]);
  });
});

describe("planBudgetChange", () => {
  it("closes the old row the day before the new one starts — no overlap, no gap", () => {
    const current = line({ id: "v1", amount: 400, effectiveFrom: "2026-01-01" });
    const { insert, close } = planBudgetChange(
      current,
      { amount: 540, fundingSource: "SALARY", period: "MONTHLY", label: "post-raise" },
      "2026-03-01", "Dining",
    );
    expect(close).toEqual({ id: "v1", effectiveTo: "2026-02-28" });
    expect(insert.effectiveFrom).toBe("2026-03-01");
    expect(insert.effectiveTo).toBeNull();
    expect(insert.amount).toBe(540);
    expect(insert.label).toBe("post-raise");
  });

  it("has nothing to close when the category is budgeted for the first time", () => {
    const { close } = planBudgetChange(null,
      { amount: 200, fundingSource: "RSU", period: "CYCLE" }, "2026-10-01", "Golf");
    expect(close).toBeNull();
  });

  it("produces a series that resolves correctly on both sides of the change", () => {
    const current = line({ id: "v1", amount: 400, effectiveFrom: "2026-01-01" });
    const { insert, close } = planBudgetChange(current,
      { amount: 540, fundingSource: "SALARY", period: "MONTHLY" }, "2026-03-01", "Dining");
    const after: BudgetLine[] = [
      { ...current, effectiveTo: close!.effectiveTo },
      { ...insert, id: "v2" } as BudgetLine,
    ];
    expect(validateBudgetHistory(after)).toEqual([]);
    expect(resolveBudgetLines(after, "2026-02-28")[0].amount).toBe(400);
    expect(resolveBudgetLines(after, "2026-03-01")[0].amount).toBe(540);
  });
});

describe("windows", () => {
  it("MONTHLY spans the calendar month, including a leap February", () => {
    expect(budgetWindow("MONTHLY", "2026-09-30")).toEqual({
      fromIso: "2026-09-01", toIso: "2026-09-30", label: "2026-09",
    });
    expect(monthEnd("2028-02-10")).toBe("2028-02-29");
    expect(monthEnd("2026-02-10")).toBe("2026-02-28");
  });

  it("CYCLE runs from the last vest to the next", () => {
    const w = cycleWindow("2026-09-30", ["2026-08-15", "2026-11-15", "2027-02-15"]);
    expect(w).toEqual({ fromIso: "2026-08-15", toIso: "2026-11-15", label: "2026-08-15 → 2026-11-15" });
  });

  it("returns null when no future vest is known rather than assuming a cadence", () => {
    // An invented boundary would silently rescale every pace number on the page.
    expect(cycleWindow("2026-09-30", ["2026-08-15"])).toBeNull();
    expect(budgetWindow("CYCLE", "2026-09-30", [])).toBeNull();
  });

  it("starts the cycle at today when there is no prior vest on record", () => {
    expect(cycleWindow("2026-09-30", ["2026-11-15"])?.fromIso).toBe("2026-09-30");
  });

  it("measures elapsed fraction and clamps it", () => {
    const w = { fromIso: "2026-09-01", toIso: "2026-09-11", label: "x" };
    expect(elapsedFraction(w, "2026-09-01")).toBe(0);
    expect(elapsedFraction(w, "2026-09-06")).toBeCloseTo(0.5, 5);
    expect(elapsedFraction(w, "2026-09-11")).toBe(1);
    expect(elapsedFraction(w, "2026-10-01")).toBe(1);
    expect(elapsedFraction(w, "2026-08-01")).toBe(0);
  });

  it("defaults the period from the funding source", () => {
    expect(DEFAULT_PERIOD.SALARY).toBe("MONTHLY");
    expect(DEFAULT_PERIOD.RSU).toBe("CYCLE");
    expect(DEFAULT_PERIOD.BONUS).toBe("CYCLE");
  });

  it("handles date helpers across month and year boundaries", () => {
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
    expect(previousDay("2027-01-01")).toBe("2026-12-31");
    expect(monthStart("2026-09-30")).toBe("2026-09-01");
    expect(daysBetween("2026-09-30", "2026-11-15")).toBe(46);
  });
});

describe("spendByCategory", () => {
  const w = { fromIso: "2026-09-01", toIso: "2026-09-30", label: "2026-09" };
  const tx = (over: any) => ({
    id: "t", accountId: "a", amount: -100, date: "2026-09-10", status: "POSTED",
    type: "EXPENSE", category: "Dining", description: "x", ...over,
  });

  it("sums outflows per category inside the window", () => {
    const got = spendByCategory([tx({ amount: -40 }), tx({ amount: -60 }), tx({ amount: -25, category: "Golf" })] as any, w);
    expect(got.get("Dining")).toBe(100);
    expect(got.get("Golf")).toBe(25);
  });

  it("excludes pending rows, inflows and anything outside the window", () => {
    const got = spendByCategory([
      tx({ amount: -40, status: "PENDING" }),
      tx({ amount: 40 }),                       // a refund is not spend
      tx({ amount: -40, date: "2026-08-31" }),
      tx({ amount: -40, date: "2026-10-01" }),
    ] as any, w);
    expect(got.get("Dining")).toBeUndefined();
  });

  it("excludes group-tagged spend so one trip cannot eat a category", () => {
    const got = spendByCategory([
      tx({ amount: -300, spendGroupId: "trip-1" }),
      tx({ amount: -50 }),
    ] as any, w);
    expect(got.get("Dining")).toBe(50);
  });
});

describe("committedByCategory", () => {
  const w = { fromIso: "2026-09-01", toIso: "2026-09-30", label: "2026-09" };
  const every = () => 1;

  it("decomposes a line rather than adding to it", () => {
    const got = committedByCategory([
      { id: "r1", category: "Utilities", amount: -240, type: "EXPENSE", active: true },
    ] as any, w, every);
    // 240 of the Utilities budget is committed; the budget itself is unchanged.
    expect(got.get("Utilities")).toBe(240);
  });

  it("counts a rule once per occurrence in the window", () => {
    const got = committedByCategory(
      [{ id: "r1", category: "Dining", amount: -50, type: "EXPENSE", active: true }] as any,
      w, () => 4,
    );
    expect(got.get("Dining")).toBe(200);
  });

  it("ignores paused rules, income rules and uncategorized rules", () => {
    const got = committedByCategory([
      { id: "a", category: "Utilities", amount: -100, type: "EXPENSE", active: false },
      { id: "b", category: "Utilities", amount: 5000, type: "INCOME", active: true },
      { id: "c", category: "",          amount: -100, type: "EXPENSE", active: true },
    ] as any, w, every);
    expect(got.size).toBe(0);
  });
});

describe("seedFromHistory", () => {
  const MONTHS = ["2026-07", "2026-08", "2026-09"];
  const tx = (over: any) => ({
    id: "t", accountId: "a", amount: -100, date: "2026-07-10", status: "POSTED",
    type: "EXPENSE", category: "Dining", description: "x", ...over,
  });

  it("uses the median month, so one lumpy purchase can't set the budget", () => {
    const seeds = seedFromHistory([
      tx({ id: "1", amount: -100, date: "2026-07-05" }),
      tx({ id: "2", amount: -120, date: "2026-08-05" }),
      tx({ id: "3", amount: -4000, date: "2026-09-05" }),   // the outlier month
    ] as any, MONTHS);
    const dining = seeds.find((s) => s.category === "Dining")!;
    expect(dining.median).toBe(120);          // a mean would say 1406
    expect(dining.max).toBe(4000);
    expect(dining.volatility).toBeCloseTo((4000 - 100) / 120, 5);
  });

  it("honours the excluded one-off ids the caller passes in", () => {
    const seeds = seedFromHistory([
      tx({ id: "1", amount: -100, date: "2026-07-05" }),
      tx({ id: "2", amount: -120, date: "2026-08-05" }),
      tx({ id: "big", amount: -4000, date: "2026-09-05" }),
    ] as any, MONTHS, new Set(["big"]));
    const dining = seeds.find((s) => s.category === "Dining")!;
    expect(dining.monthly).toEqual([100, 120, 0]);
    expect(dining.median).toBe(100);
  });

  it("drops group-tagged spend and months outside the window", () => {
    const seeds = seedFromHistory([
      tx({ id: "1", amount: -100 }),
      tx({ id: "2", amount: -900, spendGroupId: "trip" }),
      tx({ id: "3", amount: -900, date: "2026-01-05" }),
    ] as any, MONTHS);
    expect(seeds.find((s) => s.category === "Dining")!.max).toBe(100);
  });

  it("can exclude structural categories the caller doesn't budget", () => {
    const seeds = seedFromHistory(
      [tx({ id: "1", category: "Transfers", amount: -5000 }), tx({ id: "2", amount: -50 })] as any,
      MONTHS, new Set(), new Set(["Transfers"]),
    );
    expect(seeds.map((s) => s.category)).toEqual(["Dining"]);
  });
});

describe("computeLineView", () => {
  const w = { fromIso: "2026-09-01", toIso: "2026-09-30", label: "2026-09" };
  const l = line({ id: "a", category: "Dining", amount: 600 });

  it("splits a line into committed and variable without inflating it", () => {
    const v = computeLineView(l, w, new Map(), new Map([["Dining", 240]]), "2026-09-01");
    expect(v.budgeted).toBe(600);     // not 840
    expect(v.committed).toBe(240);
    expect(v.variable).toBe(360);
  });

  it("measures pace against elapsed time, not the whole window", () => {
    // ~half the month gone, half the budget spent → on pace.
    const v = computeLineView(l, w, new Map([["Dining", 300]]), new Map(), "2026-09-16");
    expect(v.pace).toBeCloseTo(1.0, 1);
    expect(v.status).toBe("on");
  });

  it("flags over and under outside the tolerance band", () => {
    expect(computeLineView(l, w, new Map([["Dining", 500]]), new Map(), "2026-09-16").status).toBe("over");
    expect(computeLineView(l, w, new Map([["Dining", 50]]),  new Map(), "2026-09-16").status).toBe("under");
  });

  it("does not flicker to over on day one, when no time has elapsed", () => {
    const v = computeLineView(l, w, new Map([["Dining", 20]]), new Map(), "2026-09-01");
    expect(v.pace).toBeNull();
    expect(v.status).toBe("on");
  });

  it("still calls it over on day one if the budget is already blown", () => {
    expect(computeLineView(l, w, new Map([["Dining", 900]]), new Map(), "2026-09-01").status).toBe("over");
  });

  it("reports the daily spend that lands exactly on budget, and 0 once overspent", () => {
    const ok = computeLineView(l, w, new Map([["Dining", 300]]), new Map(), "2026-09-20");
    expect(ok.safeDailyRemaining).toBeCloseTo(300 / 10, 5);
    expect(computeLineView(l, w, new Map([["Dining", 700]]), new Map(), "2026-09-20").safeDailyRemaining).toBe(0);
  });
});

describe("summarizePools & unassignedCategories", () => {
  const w = { fromIso: "2026-09-01", toIso: "2026-09-30", label: "2026-09" };

  it("reports over-commitment of a pool as negative unallocated", () => {
    const views = [
      computeLineView(line({ id: "a", category: "Dining", amount: 600 }), w, new Map(), new Map(), "2026-09-15"),
      computeLineView(line({ id: "b", category: "Golf", amount: 400 }), w, new Map(), new Map(), "2026-09-15"),
    ];
    const [salary] = summarizePools(views, { SALARY: 900 });
    expect(salary.allocated).toBe(1000);
    expect(salary.unallocated).toBe(-100);
  });

  it("keeps pools separate by funding source", () => {
    const views = [
      computeLineView(line({ id: "a", category: "Dining", fundingSource: "SALARY", amount: 600 }), w, new Map(), new Map(), "2026-09-15"),
      computeLineView(line({ id: "b", category: "Travel", fundingSource: "RSU", amount: 3000 }), w, new Map(), new Map(), "2026-09-15"),
    ];
    const pools = summarizePools(views, { SALARY: 1000, RSU: 40000 });
    expect(pools.find((p) => p.source === "SALARY")!.allocated).toBe(600);
    expect(pools.find((p) => p.source === "RSU")!.unallocated).toBe(37000);
  });

  it("surfaces categories with spend but no line, biggest first", () => {
    const spent = new Map([["Dining", 300], ["Golf", 900], ["Flying", 50]]);
    const got = unassignedCategories(spent, [line({ id: "a", category: "Dining" })]);
    expect(got.map((u) => u.category)).toEqual(["Golf", "Flying"]);
  });
});

describe("spendByCategory — balance-sheet movement is not spend", () => {
  const w = { fromIso: "2026-09-01", toIso: "2026-09-30", label: "2026-09" };
  const tx = (over: any) => ({
    id: "t", accountId: "a", amount: -100, date: "2026-09-10", status: "POSTED",
    type: "EXPENSE", category: "Dining", description: "x", ...over,
  });

  it("ignores transfers, card payments, loan payments and investments", () => {
    // Counting a card payment AND the charge it settles double-counts the purchase.
    const got = spendByCategory([
      tx({ id: "1", category: "Transfers",           amount: -13977 }),
      tx({ id: "2", category: "Credit Card Payment", amount: -8139 }),
      tx({ id: "3", category: "Loan Payment",        amount: -5619 }),
      tx({ id: "4", category: "Investments",         amount: -3000 }),
      tx({ id: "5", category: "Dining",              amount: -60 }),
    ] as any, w);
    expect([...got.keys()]).toEqual(["Dining"]);
    expect(got.get("Dining")).toBe(60);
  });

  it("seedFromHistory applies the same exclusion by default", () => {
    const seeds = seedFromHistory([
      tx({ id: "1", category: "Transfers", amount: -5000 }),
      tx({ id: "2", category: "Dining", amount: -50 }),
    ] as any, ["2026-09"]);
    expect(seeds.map((s) => s.category)).toEqual(["Dining"]);
  });
});
