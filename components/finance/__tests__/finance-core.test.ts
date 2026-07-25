import { describe, it, expect } from "vitest";
import {
  isInvestedAccount,
  isLotVested,
  buildQuoteMap,
  tickerAggregate,
  uniqueTickers,
  accountTotalValue,
  computeGoalAllocations,
  effectiveGoalAmount,
  goalHasVolatileFunding,
  goalHasFundingSource,
  type AccountRecord,
  type GoalRecord,
  type GoalFundingSourceRecord,
  type HoldingRecord,
  type HoldingLotRecord,
  type TickerQuoteRecord,
} from "@/components/finance/finance-core";

// Characterization tests for the pure money math consumed by the dashboard,
// goals page, and the financeSnapshots Lambda. Fixtures are minimal partials
// cast through the Schema record types — only the fields each function reads.

const acc = (o: Partial<AccountRecord>): AccountRecord => o as AccountRecord;
const goal = (o: Partial<GoalRecord>): GoalRecord => o as GoalRecord;
const mapping = (o: Partial<GoalFundingSourceRecord>): GoalFundingSourceRecord =>
  o as GoalFundingSourceRecord;
const holding = (o: Partial<HoldingRecord>): HoldingRecord => o as HoldingRecord;
const lot = (o: Partial<HoldingLotRecord>): HoldingLotRecord => o as HoldingLotRecord;
const quote = (o: Partial<TickerQuoteRecord>): TickerQuoteRecord => o as TickerQuoteRecord;

// ── Classification ─────────────────────────────────────────────────────────

describe("isInvestedAccount", () => {
  it("brokerage and retirement hold positions; everything else is cash-only", () => {
    expect(isInvestedAccount("BROKERAGE")).toBe(true);
    expect(isInvestedAccount("RETIREMENT")).toBe(true);
    expect(isInvestedAccount("CHECKING")).toBe(false);
    expect(isInvestedAccount("CREDIT")).toBe(false);
    expect(isInvestedAccount(null)).toBe(false);
  });
});

describe("isLotVested", () => {
  it("vested by default; only an explicit false is unvested", () => {
    expect(isLotVested(lot({}))).toBe(true);
    expect(isLotVested(lot({ isVested: true }))).toBe(true);
    expect(isLotVested(lot({ isVested: false }))).toBe(false);
  });
});

// ── Quotes ─────────────────────────────────────────────────────────────────

describe("buildQuoteMap", () => {
  it("keys by uppercase ticker and skips blank tickers", () => {
    const m = buildQuoteMap([
      quote({ ticker: "swppx", price: 80 }),
      quote({ ticker: "META", price: 700 }),
      quote({ ticker: "", price: 1 }),
    ]);
    expect(m.get("SWPPX")?.price).toBe(80);
    expect(m.get("META")?.price).toBe(700);
    expect(m.size).toBe(2);
  });
});

// ── tickerAggregate ────────────────────────────────────────────────────────

describe("tickerAggregate", () => {
  const quotes = buildQuoteMap([quote({ ticker: "META", price: 100, fetchedAt: "2026-07-25T00:00:00Z" })]);

  it("the holding row is authoritative for the vested position; lot drift is surfaced", () => {
    const h = holding({ quantity: 100, costBasisTotal: 5_000, assetType: "STOCK" });
    const lots = [
      lot({ ticker: "META", quantity: 60, costBasis: 3_000, purchaseDate: "2025-01-01" }),
      lot({ ticker: "META", quantity: 30, costBasis: 1_500, purchaseDate: "2024-01-01" }),
    ];
    const a = tickerAggregate("meta", h, lots, quotes);
    expect(a.ticker).toBe("META");
    expect(a.totalQty).toBe(100);          // holding wins over Σ lots (90)
    expect(a.totalCost).toBe(5_000);
    expect(a.lotQtyDrift).toBe(10);        // 100 − 90
    expect(a.marketValue).toBe(10_000);
    expect(a.gainLoss).toBe(5_000);
    expect(a.gainLossPct).toBeCloseTo(1.0, 6);
    // lots sorted by purchaseDate asc
    expect(a.lots[0].purchaseDate).toBe("2024-01-01");
  });

  it("falls back to vested lots when no holding row exists", () => {
    const lots = [
      lot({ ticker: "META", quantity: 60, costBasis: 3_000 }),
      lot({ ticker: "META", quantity: 30, costBasis: 1_500 }),
    ];
    const a = tickerAggregate("META", null, lots, quotes);
    expect(a.totalQty).toBe(90);
    expect(a.totalCost).toBe(4_500);
    expect(a.lotQtyDrift).toBe(0); // no holding → drift not meaningful
  });

  it("any lot missing costBasis nulls the aggregate cost and gain (honest partial data)", () => {
    const lots = [
      lot({ ticker: "META", quantity: 60, costBasis: 3_000 }),
      lot({ ticker: "META", quantity: 30 }),
    ];
    const a = tickerAggregate("META", null, lots, quotes);
    expect(a.totalCost).toBeNull();
    expect(a.gainLoss).toBeNull();
    expect(a.gainLossPct).toBeNull();
    expect(a.marketValue).toBe(9_000); // qty still priced
  });

  it("unvested lots are excluded from the vested position and totaled separately", () => {
    const lots = [
      lot({ ticker: "META", quantity: 50, costBasis: 2_500 }),
      lot({ ticker: "META", quantity: 40, isVested: false }),
    ];
    const a = tickerAggregate("META", null, lots, quotes);
    expect(a.totalQty).toBe(50);
    expect(a.unvestedQty).toBe(40);
    expect(a.unvestedValue).toBe(4_000);
    expect(a.unvestedLotsCount).toBe(1);
  });

  it("no quote → null price and null market value", () => {
    const a = tickerAggregate("SWISX", null, [lot({ ticker: "SWISX", quantity: 10, costBasis: 100 })], quotes);
    expect(a.price).toBeNull();
    expect(a.marketValue).toBeNull();
    expect(a.gainLoss).toBeNull();
  });
});

describe("uniqueTickers", () => {
  it("dedupes across holdings ∪ lots, uppercased and sorted", () => {
    const tickers = uniqueTickers(
      [holding({ ticker: "meta" }), holding({ ticker: "SWPPX" })],
      [lot({ ticker: "META" }), lot({ ticker: "ba" })],
    );
    expect(tickers).toEqual(["BA", "META", "SWPPX"]);
  });
});

// ── accountTotalValue ──────────────────────────────────────────────────────

describe("accountTotalValue", () => {
  const quotes = buildQuoteMap([quote({ ticker: "META", price: 5 })]);

  it("non-invested accounts are cash only, ignoring any holdings rows", () => {
    const a = acc({ id: "a1", type: "CHECKING", currentBalance: 1_000 });
    const h = [holding({ accountId: "a1", ticker: "META", quantity: 10 })];
    expect(accountTotalValue(a, h, quotes)).toBe(1_000);
  });

  it("invested accounts add Σ(qty × price) for their own holdings only", () => {
    const a = acc({ id: "a1", type: "BROKERAGE", currentBalance: 1_000 });
    const h = [
      holding({ accountId: "a1", ticker: "META", quantity: 10 }), // +50
      holding({ accountId: "a2", ticker: "META", quantity: 99 }), // other account
      holding({ accountId: "a1", ticker: "NOQUOTE", quantity: 5 }), // no quote → 0
    ];
    expect(accountTotalValue(a, h, quotes)).toBe(1_050);
  });
});

// ── computeGoalAllocations ─────────────────────────────────────────────────

describe("computeGoalAllocations", () => {
  it("fills a goal to target and keeps the excess as account surplus", () => {
    const r = computeGoalAllocations(
      [acc({ id: "a1", type: "SAVINGS", currentBalance: 5_000 })],
      [goal({ id: "g1", targetAmount: 3_000 })],
      [mapping({ id: "m1", accountId: "a1", goalId: "g1", priority: 1 })],
    );
    expect(r.allocatedByGoal.get("g1")).toBe(3_000);
    expect(r.surplusByAccount.get("a1")).toBe(2_000);
    expect(r.allocatedByMapping.get("m1")).toBe(3_000);
  });

  it("a shared account fills goals in priority order", () => {
    const r = computeGoalAllocations(
      [acc({ id: "a1", type: "CHECKING", currentBalance: 5_000 })],
      [goal({ id: "g1", targetAmount: 3_000 }), goal({ id: "g2", targetAmount: 4_000 })],
      [
        mapping({ id: "m2", accountId: "a1", goalId: "g2", priority: 2 }),
        mapping({ id: "m1", accountId: "a1", goalId: "g1", priority: 1 }),
      ],
    );
    expect(r.allocatedByGoal.get("g1")).toBe(3_000);
    expect(r.allocatedByGoal.get("g2")).toBe(2_000); // remainder
    expect(r.surplusByAccount.get("a1")).toBe(0);
  });

  it("CREDIT, LOAN, and inactive accounts never fund goals", () => {
    const goals = [goal({ id: "g1", targetAmount: 10_000 })];
    const r = computeGoalAllocations(
      [
        acc({ id: "c", type: "CREDIT", currentBalance: 5_000 }),
        acc({ id: "l", type: "LOAN", currentBalance: 5_000 }),
        acc({ id: "i", type: "SAVINGS", currentBalance: 5_000, active: false }),
      ],
      goals,
      [
        mapping({ id: "m1", accountId: "c", goalId: "g1" }),
        mapping({ id: "m2", accountId: "l", goalId: "g1" }),
        mapping({ id: "m3", accountId: "i", goalId: "g1" }),
      ],
    );
    expect(r.allocatedByGoal.get("g1")).toBeUndefined();
    expect(r.surplusByAccount.size).toBe(0);
  });

  it("overdrawn accounts clamp to zero", () => {
    const r = computeGoalAllocations(
      [acc({ id: "a1", type: "CHECKING", currentBalance: -500 })],
      [goal({ id: "g1", targetAmount: 1_000 })],
      [mapping({ id: "m1", accountId: "a1", goalId: "g1" })],
    );
    expect(r.allocatedByMapping.get("m1")).toBe(0);
    expect(r.surplusByAccount.get("a1")).toBe(0);
  });

  it("a goal funded by multiple accounts caps globally at its target", () => {
    const r = computeGoalAllocations(
      [
        acc({ id: "a1", type: "SAVINGS", currentBalance: 2_000, name: "A" }),
        acc({ id: "a2", type: "SAVINGS", currentBalance: 2_000, name: "B" }),
      ],
      [goal({ id: "g1", targetAmount: 3_000 })],
      [
        mapping({ id: "m1", accountId: "a1", goalId: "g1" }),
        mapping({ id: "m2", accountId: "a2", goalId: "g1" }),
      ],
    );
    expect(r.allocatedByGoal.get("g1")).toBe(3_000);
    // 2,000 + 1,000; the second account keeps the rest as surplus
    const surpluses = [r.surplusByAccount.get("a1"), r.surplusByAccount.get("a2")].sort();
    expect(surpluses).toEqual([0, 1_000]);
  });

  it("dedicated accounts (fewer mappings) fill their goal before shared pools", () => {
    const r = computeGoalAllocations(
      [
        acc({ id: "pool", type: "CHECKING", currentBalance: 5_000, name: "Pool" }),
        acc({ id: "dedicated", type: "SAVINGS", currentBalance: 1_000, name: "Dedicated" }),
      ],
      [goal({ id: "g1", targetAmount: 1_000 }), goal({ id: "g2", targetAmount: 10_000 })],
      [
        mapping({ id: "mp1", accountId: "pool", goalId: "g1", priority: 1 }),
        mapping({ id: "mp2", accountId: "pool", goalId: "g2", priority: 2 }),
        mapping({ id: "md1", accountId: "dedicated", goalId: "g1", priority: 1 }),
      ],
    );
    // dedicated (1 mapping) runs first and fully funds g1; the pool's g1 mapping takes 0
    expect(r.allocatedByMapping.get("md1")).toBe(1_000);
    expect(r.allocatedByMapping.get("mp1")).toBe(0);
    expect(r.allocatedByGoal.get("g2")).toBe(5_000);
  });

  it("includes brokerage positions at market price", () => {
    const r = computeGoalAllocations(
      [acc({ id: "b1", type: "BROKERAGE", currentBalance: 100 })],
      [goal({ id: "g1", targetAmount: 10_000 })],
      [mapping({ id: "m1", accountId: "b1", goalId: "g1" })],
      [holding({ accountId: "b1", ticker: "META", quantity: 10 })],
      [quote({ ticker: "META", price: 50 })],
    );
    expect(r.allocatedByGoal.get("g1")).toBe(600); // 100 cash + 500 positions
  });
});

// ── effectiveGoalAmount & friends ──────────────────────────────────────────

describe("effectiveGoalAmount", () => {
  const g = goal({ id: "g1", targetAmount: 5_000, currentAmount: 1_234 });

  it("uses the computed allocation when the goal has a mapping", () => {
    const maps = [mapping({ id: "m1", accountId: "a1", goalId: "g1" })];
    const allocations = computeGoalAllocations(
      [acc({ id: "a1", type: "SAVINGS", currentBalance: 2_000 })],
      [g],
      maps,
    );
    expect(effectiveGoalAmount(g, allocations, maps)).toBe(2_000);
  });

  it("falls back to the stored manual currentAmount without mappings", () => {
    const allocations = computeGoalAllocations([], [g], []);
    expect(effectiveGoalAmount(g, allocations, [])).toBe(1_234);
  });
});

describe("goalHasVolatileFunding / goalHasFundingSource", () => {
  const accounts = [
    acc({ id: "cash", type: "SAVINGS" }),
    acc({ id: "brk", type: "BROKERAGE" }),
  ];

  it("volatile only when a mapping points at an invested account", () => {
    const g = goal({ id: "g1" });
    expect(
      goalHasVolatileFunding(g, [mapping({ goalId: "g1", accountId: "cash" })], accounts),
    ).toBe(false);
    expect(
      goalHasVolatileFunding(g, [mapping({ goalId: "g1", accountId: "brk" })], accounts),
    ).toBe(true);
  });

  it("goalHasFundingSource reflects mapping presence", () => {
    const g = goal({ id: "g1" });
    expect(goalHasFundingSource(g, [mapping({ goalId: "g1" })])).toBe(true);
    expect(goalHasFundingSource(g, [mapping({ goalId: "other" })])).toBe(false);
  });
});
