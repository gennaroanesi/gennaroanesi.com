import { describe, it, expect } from "vitest";
import {
  inferCategory,
  effectiveCategory,
  stripProcessorPrefix,
  parseLineItems,
  categoryContributions,
  hasLineItems,
  isExcludedFromPnl,
} from "@/components/finance/categories";

describe("inferCategory", () => {
  it("matches a plain merchant substring rule", () => {
    expect(inferCategory({ description: "NETFLIX.COM", type: "EXPENSE" })).toBe("Subscriptions");
    expect(inferCategory({ description: "SHELL OIL 12345", type: "EXPENSE" })).toBe("Gas/Transport");
  });

  it("strips payment-processor prefixes before matching (the Uncategorized fix)", () => {
    // These would land in Uncategorized without prefix stripping.
    expect(inferCategory({ description: "PWP    AMERICAN EXPR SEATTLE", type: "EXPENSE" })).toBe("Travel");
    expect(inferCategory({ description: "SP BRAZILMKTAUSTIN ROUND ROCK", type: "EXPENSE" })).toBe("Groceries");
    expect(inferCategory({ description: "AplPay PORTE NOIRE LONDON", type: "EXPENSE" })).toBe("Dining");
  });

  it("keeps prefix-dependent rules working (tst* signals a Toast restaurant)", () => {
    expect(inferCategory({ description: "TST* TERRY BLACKS BBQ", type: "EXPENSE" })).toBe("Dining");
  });

  it("treats TRANSFER / BUY / SELL as structural regardless of description", () => {
    expect(inferCategory({ description: "NETFLIX", type: "TRANSFER" })).toBe("Transfers");
    expect(inferCategory({ description: "Buy 10 AAPL", type: "BUY" })).toBe("Investments");
    expect(inferCategory({ description: "Sell 5 META", type: "SELL" })).toBe("Investments");
  });

  it("routes brokerage buy/sell descriptions to Investments", () => {
    expect(inferCategory({ description: "BUY 255.624 SWPPX", type: "EXPENSE" })).toBe("Investments");
    expect(inferCategory({ description: "Cash for Sell 4 BA on 2026-06-03", type: "INCOME" })).toBe("Investments");
  });

  it("falls back to Income for unmatched INCOME, null for unmatched EXPENSE", () => {
    expect(inferCategory({ description: "MYSTERY DEPOSIT", type: "INCOME" })).toBe("Income");
    expect(inferCategory({ description: "some unknown merchant xyz", type: "EXPENSE" })).toBeNull();
  });
});

describe("inferCategory — direction (refunds)", () => {
  it("files a money-in match on a spending rule as Refund, not as that category", () => {
    // Same merchant string, opposite directions.
    expect(inferCategory({ description: "Nike", type: "EXPENSE", amount: -334.69 })).toBe("Apparel");
    expect(inferCategory({ description: "Nike", type: "INCOME",  amount:  334.69 })).toBe("Refund");
    expect(inferCategory({ description: "Trupanion", type: "INCOME", amount: 132.31 })).toBe("Refund");
    expect(inferCategory({ description: "Lululemon Athletica", type: "INCOME", amount: 75 })).toBe("Refund");
    expect(inferCategory({ description: "Amazon", type: "INCOME", amount: 173.19 })).toBe("Refund");
    // A reversed fee is a refund of that fee.
    expect(inferCategory({ description: "Interest Charge", type: "INCOME", amount: 12 })).toBe("Refund");
  });

  it("infers direction from the sign when no type is given", () => {
    expect(inferCategory({ description: "Nike", amount:  50 })).toBe("Refund");
    expect(inferCategory({ description: "Nike", amount: -50 })).toBe("Apparel");
  });

  it("never rewrites structural buckets or real income", () => {
    expect(inferCategory({ description: "META PAYROLL", type: "INCOME", amount: 9000 })).toBe("Income");
    expect(inferCategory({ description: "Interest Paid", type: "INCOME", amount: 4 })).toBe("Income");
    expect(inferCategory({ description: "Chase Credit Card", type: "INCOME", amount: 2865.14 })).toBe("Credit Card Payment");
    expect(inferCategory({ description: "Online Transfer from CHK", type: "INCOME", amount: 500 })).toBe("Transfers");
    expect(inferCategory({ description: "Mortgage Payment", type: "INCOME", amount: 100 })).toBe("Loan Payment");
  });

  it("matches explicit refund wording in either direction", () => {
    expect(inferCategory({ description: "Refund from WAL-MART #0475     SE2", type: "INCOME", amount: 29.17 })).toBe("Refund");
    // "refundable" must not trip the \brefund\b word boundary.
    expect(inferCategory({ description: "REFUNDABLE DEPOSIT HOTEL", type: "EXPENSE", amount: -200 })).toBe("Travel");
  });

  it("files card statement credits as Refund rather than as the perk's category", () => {
    for (const d of [
      "Platinum Digital Entertainment Credit",
      "Platinum Walmart+ Credit",
      "Platinum Hotel Credit",
      "Platinum Resy Credit",
      "AMEX Airline Fee Reimbursement",
      "AMEX TRAVEL PAY WITH POINTS CREDIT",
      "UNITED CREDIT $125/YEAR",
      "UA INFLIGHT/INCLUB CREDIT",
    ]) {
      expect(inferCategory({ description: d, type: "INCOME", amount: 25 }), d).toBe("Refund");
    }
  });
});

describe("inferCategory — bare card payments", () => {
  it("files a description that is just \"Payment\" as Credit Card Payment, not Income", () => {
    for (const d of ["Payment", "payment", "  Payment  ", "Pay off card balance"]) {
      expect(inferCategory({ description: d, type: "INCOME", amount: 10000 }), d).toBe("Credit Card Payment");
    }
  });

  it("does not swallow descriptions that merely contain the word", () => {
    expect(inferCategory({ description: "Return Payment Fee", type: "EXPENSE", amount: -29 })).toBe("Fees");
    expect(inferCategory({ description: "VENMO PAYMENT 1042005633463", type: "EXPENSE", amount: -35 })).toBe("Transfers");
    expect(inferCategory({ description: "Mortgage Payment", type: "EXPENSE", amount: -3000 })).toBe("Loan Payment");
  });
});

describe("inferCategory — payment reversals", () => {
  it("files a returned payment as Credit Card Payment so it cancels the original", () => {
    expect(inferCategory({ description: "Returned Check Decliank Transactions", type: "EXPENSE", amount: -1500 }))
      .toBe("Credit Card Payment");
    expect(inferCategory({ description: "PAYMENT RETURNED", type: "EXPENSE", amount: -200 })).toBe("Credit Card Payment");
    expect(inferCategory({ description: "NSF - insufficient funds", type: "EXPENSE", amount: -50 })).toBe("Credit Card Payment");
  });

  it("keeps the FEE for a returned payment in Fees", () => {
    expect(inferCategory({ description: "Return Payment Fee", type: "EXPENSE", amount: -29 })).toBe("Fees");
    expect(inferCategory({ description: "Returned Check Fee", type: "EXPENSE", amount: -35 })).toBe("Fees");
  });

  it("drops both sides of a reversal out of the P&L", () => {
    expect(isExcludedFromPnl("Credit Card Payment")).toBe(true);
  });
});

describe("stripProcessorPrefix", () => {
  it("removes known processor prefixes", () => {
    expect(stripProcessorPrefix("PAYPAL *FALKEUSAONL")).toBe("FALKEUSAONL");
    expect(stripProcessorPrefix("SP AXIL")).toBe("AXIL");
    expect(stripProcessorPrefix("AplPay TFL TRAVEL")).toBe("TFL TRAVEL");
  });
  it("leaves un-prefixed descriptions untouched", () => {
    expect(stripProcessorPrefix("NETFLIX.COM")).toBe("NETFLIX.COM");
  });
});

describe("effectiveCategory", () => {
  it("prefers a user-set category over inference", () => {
    expect(effectiveCategory({ category: "Dolce", description: "NETFLIX", type: "EXPENSE" })).toBe("Dolce");
  });
  it("infers when no category is set, else Uncategorized", () => {
    expect(effectiveCategory({ description: "SHELL", type: "EXPENSE" })).toBe("Gas/Transport");
    expect(effectiveCategory({ description: "nope nope", type: "EXPENSE" })).toBe("Uncategorized");
  });
});

describe("isExcludedFromPnl", () => {
  it("excludes balance-sheet buckets, includes real spend", () => {
    expect(isExcludedFromPnl("Transfers")).toBe(true);
    expect(isExcludedFromPnl("Credit Card Payment")).toBe(true);
    expect(isExcludedFromPnl("Loan Payment")).toBe(true);
    expect(isExcludedFromPnl("Investments")).toBe(true);
    expect(isExcludedFromPnl("Dining")).toBe(false);
  });
});

describe("parseLineItems", () => {
  it("parses a valid JSON array", () => {
    const items = parseLineItems({ lineItems: JSON.stringify([{ name: "x", amount: 10, category: "Home" }]) });
    expect(items).toEqual([{ name: "x", amount: 10, category: "Home", quantity: null }]);
  });
  it("returns null for empty / malformed / non-array", () => {
    expect(parseLineItems({ lineItems: "" })).toBeNull();
    expect(parseLineItems({ lineItems: "{not json" })).toBeNull();
    expect(parseLineItems({ lineItems: "{}" })).toBeNull();
    expect(parseLineItems({ lineItems: "[]" })).toBeNull();
  });
  it("drops rows missing a numeric amount or a category", () => {
    const items = parseLineItems({ lineItems: JSON.stringify([
      { name: "keep", amount: 5, category: "Home" },
      { name: "no-cat", amount: 5 },
      { name: "no-amt", category: "Home" },
    ]) });
    expect(items).toHaveLength(1);
    expect(items![0].name).toBe("keep");
  });
  it("hasLineItems mirrors parseLineItems", () => {
    expect(hasLineItems({ lineItems: JSON.stringify([{ amount: 1, category: "Home" }]) })).toBe(true);
    expect(hasLineItems({ lineItems: "" })).toBe(false);
  });
});

describe("categoryContributions", () => {
  it("returns a single bucket when there are no line items", () => {
    const c = categoryContributions({ category: "Dining", description: "x", type: "EXPENSE" }, 40);
    expect(c).toEqual([{ category: "Dining", amount: 40 }]);
  });

  it("splits across item categories, merging same-category items", () => {
    const tx = { category: "Amazon", lineItems: JSON.stringify([
      { amount: 30, category: "Electronics" },
      { amount: 10, category: "Home" },
      { amount: 10, category: "Home" },
    ]) };
    const c = categoryContributions(tx, 50);
    const byCat = Object.fromEntries(c.map((x) => [x.category, x.amount]));
    expect(byCat).toEqual({ Electronics: 30, Home: 20 });
  });

  it("scales item amounts to the transaction magnitude (tax/shipping drift)", () => {
    // Items sum to 100, but the charge (with tax) is 110 → contributions scale up.
    const tx = { category: "Amazon", lineItems: JSON.stringify([
      { amount: 60, category: "Electronics" },
      { amount: 40, category: "Home" },
    ]) };
    const c = categoryContributions(tx, 110);
    const total = c.reduce((s, x) => s + x.amount, 0);
    expect(total).toBeCloseTo(110, 6);           // sums exactly to the magnitude
    const byCat = Object.fromEntries(c.map((x) => [x.category, x.amount]));
    expect(byCat.Electronics).toBeCloseTo(66, 6);  // 60/100 * 110
    expect(byCat.Home).toBeCloseTo(44, 6);         // 40/100 * 110
  });

  it("falls back to the single bucket when item sum is zero", () => {
    const tx = { category: "Amazon", lineItems: JSON.stringify([{ amount: 0, category: "Home" }]) };
    expect(categoryContributions(tx, 25)).toEqual([{ category: "Amazon", amount: 25 }]);
  });
});

describe("rules against raw bank descriptors", () => {
  const cases: Array<[string, string]> = [
    ["UA INFLT    XXXXXXXXX2867",                        "Travel"],
    ["UNITED      XXXXXXXXX8502",                        "Travel"],
    ["CROWNE PLAZA MIDTOWNNEW YORK NY",                  "Travel"],
    ["AVIS RENT-A-CAR",                                  "Travel"],   // not Rent/Mortgage
    ["ATT PAYMENT PPD ID: XXXXXX1004",                   "Utilities"],
    ["NTTA AUTOCHARGE 972-818-6882 TX",                  "Gas/Transport"],
    ["QT 4135 OUTSIDE/QUIKROUND ROCK TX",                "Gas/Transport"],
    ["AplPay NJT RAIL MY-TNEWARK NJ",                    "Gas/Transport"],
    ["NATIONWIDE PET 800-540-2016 OH",                   "Insurance"],
    ["PREM CAR RENTAL PROTECTION 800-228-6855",          "Insurance"],
    ["CITI CARD ONLINE PAYMENT XXXXXXXXXXX3717",         "Credit Card Payment"],
    ["ONLINE PAYMENT, THANK YOU",                        "Credit Card Payment"],
  ];
  it.each(cases)("%s → %s", (description, expected) => {
    expect(inferCategory({ description, type: "EXPENSE", amount: -1 })).toBe(expected);
  });

  it("still reads a real rent payment as Rent/Mortgage", () => {
    expect(inferCategory({ description: "RENT PAYMENT APRIL", type: "EXPENSE", amount: -2000 })).toBe("Rent/Mortgage");
    expect(inferCategory({ description: "MONTHLY RENT", type: "EXPENSE", amount: -2000 })).toBe("Rent/Mortgage");
  });
});
