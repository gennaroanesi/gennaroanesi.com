import { describe, it, expect } from "vitest";
import {
  buildDedupIndex, reconcileDraft, storedSfId, shouldRecategorize, sfTxToDraft,
  type ExistingTx, type TxDraft,
} from "../engine";

const draft = (over: Partial<TxDraft> = {}): TxDraft => ({
  accountId: "acc1", date: "2026-09-11", amount: 5156.46, description: "Meta Payroll",
  type: "INCOME", status: "POSTED", category: "Income", ticker: null,
  importHash: "hash-new", notes: "sf:TRN-1", sfTransactionId: "TRN-1", ...over,
});

describe("storedSfId", () => {
  it("prefers the column and falls back to the legacy sf: note", () => {
    expect(storedSfId({ id: "x", sfTransactionId: "TRN-9" })).toBe("TRN-9");
    expect(storedSfId({ id: "x", notes: "sf:TRN-7" })).toBe("TRN-7");
    expect(storedSfId({ id: "x", notes: "tradeTxId:123" })).toBeNull();
    expect(storedSfId({ id: "x" })).toBeNull();
  });
});

describe("reconcileDraft — the pending→posted bug", () => {
  const pendingRow: ExistingTx = {
    id: "row1", date: "2026-09-11", amount: 5156.46,
    description: "Certificate of Origin Meta", status: "PENDING",
    category: "Income", importHash: "hash-old", notes: "sf:TRN-1",
  };

  it("updates the stored row instead of dropping the settled version", () => {
    const r = reconcileDraft(draft(), buildDedupIndex([pendingRow]));
    expect(r.action).toBe("update");
    if (r.action !== "update") return;
    expect(r.id).toBe("row1");
    expect(r.patch.status).toBe("POSTED");
    expect(r.patch.description).toBe("Meta Payroll");
    expect(r.patch.importHash).toBe("hash-new");
    expect(r.patch.sfTransactionId).toBe("TRN-1");
  });

  it("corrects a date that shifted while pending", () => {
    const r = reconcileDraft(draft({ date: "2026-09-14" }), buildDedupIndex([pendingRow]));
    expect(r.action === "update" && r.patch.date).toBe("2026-09-14");
  });

  it("identity beats the date+amount fingerprint — the old dedup would have skipped this", () => {
    // Same date and amount as the stored row: the pre-fix isDuplicate returned
    // true here, which is exactly how settled rows were being thrown away.
    const idx = buildDedupIndex([pendingRow]);
    expect(idx.dateAmt.has("2026-09-11|5156.46")).toBe(true);
    expect(reconcileDraft(draft(), idx).action).toBe("update");
  });

  it("does not merge two separate charges that share a date and amount", () => {
    // Two $3.00 subway taps on one day. The colliding stored row already
    // belongs to another SimpleFIN transaction, so the fingerprint must not
    // suppress this one.
    const tap1: ExistingTx = {
      id: "tap1", date: "2026-09-16", amount: -3, description: "MTA OMNY",
      status: "POSTED", notes: "sf:TRN-tap-1",
    };
    const tap2 = draft({
      sfTransactionId: "TRN-tap-2", notes: "sf:TRN-tap-2", date: "2026-09-16",
      amount: -3, description: "MTA OMNY", type: "EXPENSE", importHash: "h2",
    });
    expect(reconcileDraft(tap2, buildDedupIndex([tap1])).action).toBe("create");
  });

  it("skips when nothing actually changed", () => {
    const settled: ExistingTx = { ...pendingRow, status: "POSTED", description: "Meta Payroll", sfTransactionId: "TRN-1" };
    expect(reconcileDraft(draft(), buildDedupIndex([settled])).action).toBe("skip");
  });

  it("creates when the id is genuinely new", () => {
    expect(reconcileDraft(draft({ sfTransactionId: "TRN-999" }), buildDedupIndex([pendingRow])).action).toBe("create");
  });

  it("still honours the legacy fingerprints for rows with no id", () => {
    const legacy: ExistingTx = { id: "old", date: "2026-09-11", amount: 5156.46, importHash: "hash-new" };
    expect(reconcileDraft(draft({ sfTransactionId: "TRN-new" }), buildDedupIndex([legacy])).action).toBe("skip");
  });

  it("never trades a real merchant name for a redacted one", () => {
    const real: ExistingTx = {
      id: "r", date: "2026-09-03", amount: -20, description: "Feedamerica Chicago Usa",
      status: "PENDING", notes: "sf:TRN-1",
    };
    const r = reconcileDraft(draft({ description: "Feedamerica Xxxxxx", amount: -20, date: "2026-09-03" }), buildDedupIndex([real]));
    expect(r.action === "update" && r.patch.description).toBeUndefined();
    expect(r.action === "update" && r.patch.status).toBe("POSTED");   // still settles it
  });

  it("does accept a redacted description when the old one was redacted too", () => {
    const masked: ExistingTx = { id: "r", description: "ACCT XXXXXX 1", status: "PENDING", notes: "sf:TRN-1" };
    const r = reconcileDraft(draft({ description: "ACCT XXXXXX 2" }), buildDedupIndex([masked]));
    expect(r.action === "update" && r.patch.description).toBe("ACCT XXXXXX 2");
  });

  it("never blanks a description with an empty one", () => {
    const r = reconcileDraft(draft({ description: "" }), buildDedupIndex([pendingRow]));
    expect(r.action === "update" && r.patch.description).toBeUndefined();
  });
});

describe("shouldRecategorize", () => {
  const infer = (d: string) => (/payroll/i.test(d) ? "Income" : /golf/i.test(d) ? "Golf" : null);

  it("refreshes a machine-assigned category when the description improves", () => {
    expect(shouldRecategorize("Golf Galaxy", "Meta Payroll", "Golf", infer)).toBe("Income");
  });
  it("fills in a category that was never set", () => {
    expect(shouldRecategorize("mystery", "Meta Payroll", "", infer)).toBe("Income");
  });
  it("leaves a hand-picked category alone", () => {
    expect(shouldRecategorize("Golf Galaxy", "Meta Payroll", "Dolce", infer)).toBeUndefined();
  });
  it("says nothing when the new description infers nothing", () => {
    expect(shouldRecategorize("Meta Payroll", "mystery", "Income", infer)).toBeUndefined();
  });
});

describe("sfTxToDraft — description source", () => {
  const acct = { id: "acc1", name: "AMEX", type: "CREDIT", currentBalance: 0 };
  const tx = (over: any = {}) => ({
    id: "TRN-1", posted: "2026-09-21", transactedAt: null, amount: -66.95,
    description: "AplPay SANT AMBROEUSSOUTHAMPTON NY", payee: "Aplpay Sant",
    memo: "", pending: false, ...over,
  });

  it("stores the raw bank descriptor, not SimpleFIN's cleaned payee", () => {
    const d = sfTxToDraft(tx() as any, acct as any, []);
    expect(d?.description).toBe("AplPay SANT AMBROEUSSOUTHAMPTON NY");
  });

  it("keeps the city glued to a truncated merchant rather than losing it", () => {
    const d = sfTxToDraft(
      tx({ description: "IN *TEXAS TOP AVIATINEW BRAUNFELS TX", payee: "Texas Top Aviatinew" }) as any,
      acct as any, [],
    );
    expect(d?.description).toContain("NEW BRAUNFELS TX");
  });

  it("falls back to payee when the feed sends no descriptor", () => {
    const d = sfTxToDraft(tx({ description: "" }) as any, acct as any, []);
    expect(d?.description).toBe("Aplpay Sant");
  });
});
