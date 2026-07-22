import { describe, it, expect } from "vitest";
import {
  summarizeIncomeSources,
  summarizeCoverage,
  analyzeCategory,
  listSpendCategories,
  detectOneOffs,
  type DateRange,
} from "@/components/finance/review";
import type { AccountRecord, TransactionRecord, RecurringRecord } from "@/components/finance/_shared";

// Minimal fixture builders — the functions only read a handful of fields.
const acct = (p: Partial<AccountRecord>): AccountRecord => ({ id: "a", name: "Acc", type: "CHECKING", ...p } as AccountRecord);
const tx = (p: Partial<TransactionRecord>): TransactionRecord =>
  ({ id: Math.random().toString(36).slice(2), accountId: "chk", status: "POSTED", ...p } as TransactionRecord);

const YEAR: DateRange = { fromIso: "2026-01-01", toIso: "2026-12-31", label: "2026" };
const checking = acct({ id: "chk", name: "Checking", type: "CHECKING" });
const loan = acct({ id: "loan", name: "Mortgage", type: "LOAN" });

describe("summarizeIncomeSources", () => {
  const accounts = [checking, loan];
  const txs = [
    tx({ amount: 5000, type: "INCOME", description: "META PAYROLL", date: "2026-01-15" }),
    tx({ amount: 5000, type: "INCOME", description: "META PAYROLL", date: "2026-01-29" }),
    tx({ amount: 5000, type: "INCOME", description: "META PAYROLL", date: "2026-02-12" }),
    tx({ amount: 40000, type: "INCOME", description: "META PAYROLL", date: "2026-03-20" }), // bonus (>=2x median)
    tx({ amount: 20000, type: "SELL", ticker: "META", description: "Sell 30 META", date: "2026-02-18" }),
    tx({ amount: 1500, type: "INCOME", category: "Loan principal", description: "Principal payment #1", date: "2026-02-01", accountId: "loan" }),
    tx({ amount: 1000, type: "INCOME", description: "MPB US INC", date: "2026-05-28" }),
  ];
  const s = summarizeIncomeSources(txs, accounts, YEAR);

  it("splits regular payroll into salary", () => expect(s.salary).toBe(15000));
  it("detects the bonus as payroll >= 2x median", () => expect(s.bonus).toBe(40000));
  it("counts META share sales as RSU", () => expect(s.rsu).toBe(20000));
  it("excludes Loan principal (a balance-sheet artifact) from income", () => expect(s.other).toBe(1000));
  it("keeps RSU/bonus out of salary (salary is exactly the 3 regular checks)", () => expect(s.salary).toBe(15000));
  it("exposes the composition lines for drill-down", () => {
    expect(s.salaryLines).toHaveLength(3);
    expect(s.bonusLines).toHaveLength(1);
    expect(s.rsuLines).toHaveLength(1);
  });
});

describe("summarizeCoverage", () => {
  const accounts = [checking, loan];
  const txs = [
    // income
    tx({ amount: 5000, type: "INCOME", description: "META PAYROLL", date: "2026-01-15" }),
    tx({ amount: 5000, type: "INCOME", description: "META PAYROLL", date: "2026-01-29" }),
    tx({ amount: 40000, type: "INCOME", description: "META PAYROLL", date: "2026-03-20" }),
    tx({ amount: 20000, type: "SELL", ticker: "META", description: "Sell 30 META", date: "2026-02-18" }),
    // spend
    tx({ amount: -2000, type: "EXPENSE", category: "Groceries", description: "HEB", date: "2026-01-10" }),
    tx({ amount: -1500, type: "EXPENSE", category: "Dining", description: "restaurant", date: "2026-01-11" }),
    tx({ amount: -8000, type: "EXPENSE", category: "Watches/Jewelry", description: "watch", date: "2026-02-01" }),
    tx({ amount: -3000, type: "EXPENSE", category: "Taxes", description: "US TREAS TAX", date: "2026-04-15" }),
    tx({ amount: -1200, type: "EXPENSE", category: "Loan Payment", description: "BMW BANK BMWFS PYMT", date: "2026-03-02" }),
    tx({ amount: -1000, type: "EXPENSE", category: "Credit Card Payment", description: "AMEX card payment", date: "2026-03-05" }),
  ];
  const income = summarizeIncomeSources(txs, accounts, YEAR);
  const cov = summarizeCoverage(txs, accounts, YEAR, income);

  it("buckets essentials, lifestyle and taxes separately", () => {
    expect(cov.essentials).toBe(2000);   // Groceries only
    expect(cov.lifestyle).toBe(9500);    // Dining 1500 + Watches 8000
    expect(cov.taxes).toBe(3000);        // separate — NOT folded into essentials
  });
  it("tracks debt service and excludes it from consumption", () => {
    expect(cov.debtService).toBe(1200);
  });
  it("ignores credit-card payments entirely (balance-sheet)", () => {
    expect(cov.essentials + cov.lifestyle + cov.taxes + cov.debtService).toBe(15700); // the 1000 CC payment excluded
  });
  it("computes salary-covers-essentials on essentials+debt, taxes excluded", () => {
    // salary 10000 vs essentials 2000 + debt 1200 = 3200 → covered
    expect(cov.salaryCoversEssentials).toBe(true);
  });
});

describe("analyzeCategory", () => {
  const txs = [
    tx({ amount: -100, type: "EXPENSE", category: "Dining", description: "a", date: "2026-01-01" }),
    tx({ amount: -50, type: "EXPENSE", category: "Dining", description: "b", date: "2026-02-01" }),
    tx({ amount: -150, type: "EXPENSE", category: "Dining", description: "c", date: "2026-04-01" }),
    tx({ amount: -999, type: "EXPENSE", category: "Flying", description: "other cat", date: "2026-03-01" }),
  ];
  const a = analyzeCategory(txs, YEAR, "Dining");

  it("counts and totals the category's transactions", () => {
    expect(a.count).toBe(3);
    expect(a.total).toBe(300);
    expect(a.average).toBe(100);
    expect(a.median).toBe(100);
  });
  it("computes p90 and max", () => {
    expect(a.p90).toBe(150);
    expect(a.max).toBe(150);
    expect(a.min).toBe(50);
  });
  it("computes the average interval between transactions", () => {
    // Jan 1 → Apr 1 = 90 days / (3-1) = 45
    expect(a.avgIntervalDays).toBe(45);
  });
  it("fills interior gap months in the timeseries (Jan→Feb→Mar$0→Apr)", () => {
    expect(a.series.map((s) => s.amount)).toEqual([100, 50, 0, 150]);
    expect(a.series).toHaveLength(4);
  });
});

describe("listSpendCategories", () => {
  it("lists real spend categories and excludes balance-sheet buckets", () => {
    const txs = [
      tx({ amount: -100, type: "EXPENSE", category: "Dining", description: "a", date: "2026-01-01" }),
      tx({ amount: -500, type: "EXPENSE", category: "Flying", description: "b", date: "2026-01-02" }),
      tx({ amount: -1000, type: "EXPENSE", category: "Credit Card Payment", description: "pay", date: "2026-01-03" }),
      tx({ amount: -2000, type: "EXPENSE", category: "Loan Payment", description: "mtg", date: "2026-01-04" }),
      tx({ amount: -50, type: "TRANSFER", category: "Transfers", description: "xfer", date: "2026-01-05" }),
    ];
    const cats = listSpendCategories(txs, YEAR);
    expect(cats).toContain("Dining");
    expect(cats).toContain("Flying");
    expect(cats).not.toContain("Credit Card Payment");
    expect(cats).not.toContain("Loan Payment");
    expect(cats).not.toContain("Transfers");
    expect(cats[0]).toBe("Flying"); // sorted by spend desc (500 > 100)
  });
});

describe("detectOneOffs", () => {
  const recurrings: RecurringRecord[] = [];
  it("flags large non-recurring purchases and computes the adjusted run-rate", () => {
    const txs = [
      tx({ amount: -10000, type: "EXPENSE", category: "Watches/Jewelry", description: "RICHEMONT", date: "2026-05-20" }),
      tx({ amount: -80, type: "EXPENSE", category: "Dining", description: "lunch", date: "2026-05-21" }),
      tx({ amount: -90, type: "EXPENSE", category: "Dining", description: "dinner", date: "2026-05-22" }),
    ];
    const oo = detectOneOffs(txs, [checking], recurrings, YEAR, { minAmount: 750, maxOccurrences: 2 });
    expect(oo.items).toHaveLength(1);
    expect(oo.items[0].category).toBe("Watches/Jewelry");
    expect(oo.total).toBe(10000);
    // raw run-rate includes the one-off; adjusted excludes it
    expect(oo.rawPerMonth).toBeGreaterThan(oo.adjustedPerMonth);
  });
  it("does not flag a repeated merchant even if large", () => {
    const txs = Array.from({ length: 3 }, (_, i) =>
      tx({ amount: -2000, type: "EXPENSE", category: "Home", description: "REGULAR VENDOR", date: `2026-0${i + 1}-15` }));
    const oo = detectOneOffs(txs, [checking], recurrings, YEAR, { minAmount: 750, maxOccurrences: 2 });
    expect(oo.items).toHaveLength(0); // appears 3x > maxOccurrences
  });
});
