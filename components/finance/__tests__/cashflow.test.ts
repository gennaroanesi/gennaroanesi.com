import { describe, it, expect } from "vitest";
import { analyzeCashflow, type Account, type Recurring } from "@/components/finance/cashflow";

/**
 * The defect these pin: card-payment suggestions were sized from the
 * END-of-window surplus but attached to each card's own due date, so income
 * arriving AFTER a due date funded a payment made ON it.
 *
 * Live case (2026-10-09, 14d window): Chase held $93.16, paychecks of $5,600
 * landed 10-09 and 10-23, and AMEX was due 10-10. The tool suggested paying
 * $1,760.85 + $7,032.31 = $8,793.16 on 10-10, when 10-10 would hold $5,193.16
 * — the second paycheck, 13 days later, was already being spent.
 */

const checking = (over: Partial<Account> = {}): Account => ({
  id: "chase", name: "Chase Checking", type: "CHECKING", currentBalance: 93.16,
  minBalance: 750, ...over,
});
const card = (over: Partial<Account> & { id: string; name: string }): Account => ({
  type: "CREDIT", currentBalance: -1000, ...over,
} as Account);

const salary = (over: Partial<Recurring> = {}): Recurring => ({
  id: "sal", description: "META Salary", amount: 5600, type: "INCOME",
  cadence: "BIWEEKLY", nextDate: "2026-10-09", active: true, accountId: "chase", ...over,
});

const OPTS = { todayIso: "2026-10-09", horizonDays: 14 };

describe("card suggestions are limited by cash on the due date", () => {
  it("does not spend a paycheck that lands after the due date", () => {
    const accounts = [
      checking(),
      card({ id: "amex", name: "AMEX", currentBalance: -50884.15, statementDueDay: 10 }),
    ];
    const res = analyzeCashflow(accounts, [salary()], OPTS);

    // End-of-window surplus is genuinely large — two paychecks land in 14 days.
    expect(res.surplus).toBeGreaterThan(10000);

    // But on 10-10 only the first paycheck has arrived: 93.16 + 5600 = 5693.16,
    // less the 750 buffer.
    const amex = res.actions.find((a) => a.card === "AMEX")!;
    expect(amex).toBeDefined();
    expect(amex.amount).toBeCloseTo(5693.16 - 750, 2);
    // Before the fix this was ~10,543 — the second paycheck spent 13 days early.
    expect(amex.amount).toBeLessThan(res.surplus);
  });

  it("labels a payment that does not clear the statement as partial", () => {
    const accounts = [
      checking(),
      card({ id: "amex", name: "AMEX", currentBalance: -50884.15, statementDueDay: 10 }),
    ];
    const res = analyzeCashflow(accounts, [salary()], OPTS);
    const amex = res.actions.find((a) => a.card === "AMEX")!;
    expect(amex.reason).toContain("partial");
    expect(amex.reason).toContain("2026-10-10");
  });

  it("does not let an early card starve a later one it cannot afford anyway", () => {
    // United due 10-10 takes what's there then; Prime due 10-19 is funded from
    // what remains at ITS date, not from the same dollars twice.
    const accounts = [
      checking(),
      card({ id: "united", name: "United Quest", currentBalance: -1760.85, statementDueDay: 10 }),
      card({ id: "prime", name: "Prime Visa", currentBalance: -1307.34, statementDueDay: 19 }),
    ];
    const res = analyzeCashflow(accounts, [salary()], OPTS);
    const united = res.actions.find((a) => a.card === "United Quest")!;
    expect(united.amount).toBeCloseTo(1760.85, 2);

    // On 10-19 the balance is still the first paycheck only, minus United.
    // 5693.16 − 750 buffer − 1760.85 = 3182.31, which covers Prime in full.
    const prime = res.actions.find((a) => a.card === "Prime Visa")!;
    expect(prime.amount).toBeCloseTo(1307.34, 2);
    expect(prime.reason).not.toContain("partial");
  });

  it("suggests nothing for a card due before any money arrives", () => {
    const accounts = [
      // Below buffer, and the paycheck lands after the due date.
      checking({ currentBalance: 93.16 }),
      card({ id: "amex", name: "AMEX", currentBalance: -5000, statementDueDay: 10 }),
    ];
    const res = analyzeCashflow(accounts, [salary({ nextDate: "2026-10-20" })], {
      ...OPTS, todayIso: "2026-10-09",
    });
    // 10-10 holds $93.16, under the $750 buffer → no payment is payable then.
    expect(res.actions.find((a) => a.reason.includes("statement due"))).toBeUndefined();
  });

  it("still sweeps genuine end-of-window spare cash, dated so", () => {
    const accounts = [
      checking({ currentBalance: 20000 }),
      card({ id: "amex", name: "AMEX", currentBalance: -500, statementDueDay: 10, apr: 0.2749 }),
    ];
    const res = analyzeCashflow(accounts, [salary()], OPTS);
    // The statement clears in full at its due date; nothing is left owing, so
    // the avalanche step has no balance to chase.
    const amex = res.actions.find((a) => a.card === "AMEX")!;
    expect(amex.amount).toBeCloseTo(500, 2);
    expect(amex.reason).toBe("statement due 2026-10-10");
  });

  it("dates the avalanche suggestion so it doesn't read as due now", () => {
    const accounts = [
      checking({ currentBalance: 20000 }),
      // No due day in the window → only the avalanche step can pay it.
      card({ id: "amex", name: "AMEX", currentBalance: -3000, apr: 0.2749 }),
    ];
    const res = analyzeCashflow(accounts, [salary()], OPTS);
    const amex = res.actions.find((a) => a.card === "AMEX")!;
    expect(amex.reason).toContain("spare by 2026-10-23");
    expect(amex.reason).toContain("27.5%");
  });

  it("never suggests paying more than the card owes", () => {
    const accounts = [
      checking({ currentBalance: 50000 }),
      card({ id: "amex", name: "AMEX", currentBalance: -250, statementDueDay: 10 }),
    ];
    const res = analyzeCashflow(accounts, [salary()], OPTS);
    const total = res.actions.filter((a) => a.card === "AMEX").reduce((s, a) => s + a.amount, 0);
    expect(total).toBeCloseTo(250, 2);
  });

  it("respects the account buffer — spare cash never dips into it", () => {
    const accounts = [
      checking({ currentBalance: 1000, minBalance: 750 }),
      card({ id: "amex", name: "AMEX", currentBalance: -5000, statementDueDay: 10 }),
    ];
    // No income at all in the window.
    const res = analyzeCashflow(accounts, [], OPTS);
    const amex = res.actions.find((a) => a.card === "AMEX")!;
    expect(amex.amount).toBeCloseTo(250, 2);   // 1000 − 750, not 1000
  });
});
