import { describe, it, expect } from "vitest";
import {
  buildDedupIndex, reconcileDraft, storedSfId, shouldRecategorize, sfTxToDraft,
  type ExistingTx, type TxDraft,
} from "../engine";

const draft = (over: Partial<TxDraft> = {}): TxDraft => ({
  accountId: "acc1", date: "2026-09-11", amount: 5156.46, description: "Meta Payroll",
  type: "INCOME", status: "POSTED", category: "Income", categorySource: "RULE", ticker: null,
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

  // ── Authorship (categorySource) ──────────────────────────────────────────
  // The legacy cases above are the null-source fallback; these pin what the
  // stored source changes.

  it("never overwrites MANUAL, even when the stored category looks machine-assigned", () => {
    // "Golf" is exactly what the old description infers, so the legacy proxy
    // would have called this machine-assigned and clobbered it. This is the
    // case the field exists to fix.
    expect(shouldRecategorize("Golf Galaxy", "Meta Payroll", "Golf", infer, "MANUAL")).toBeUndefined();
  });

  it("refreshes a RULE category even when it does NOT match the old description", () => {
    // Legacy would preserve "Dolce" here on the guess that a human chose it.
    // With the source known to be RULE, there is nothing to protect.
    expect(shouldRecategorize("Golf Galaxy", "Meta Payroll", "Dolce", infer, "RULE")).toBe("Income");
  });

  it("refreshes an LLM guess once a rule can speak to the row", () => {
    expect(shouldRecategorize("Golf Galaxy", "Meta Payroll", "Shopping", infer, "LLM")).toBe("Income");
  });

  it("falls back to the legacy heuristic when the source is unknown", () => {
    expect(shouldRecategorize("Golf Galaxy", "Meta Payroll", "Golf", infer, null)).toBe("Income");
    expect(shouldRecategorize("Golf Galaxy", "Meta Payroll", "Dolce", infer, null)).toBeUndefined();
  });

  it("MANUAL outranks even an empty stored category", () => {
    // A user who deliberately cleared a category has said something too.
    expect(shouldRecategorize("mystery", "Meta Payroll", "", infer, "MANUAL")).toBeUndefined();
  });
});

describe("reconcileDraft — category authorship", () => {
  const infer = (d: string) => (/payroll/i.test(d) ? "Income" : /golf/i.test(d) ? "Golf" : null);
  const d = (over: any = {}) => draft({ description: "Meta Payroll", ...over });

  const stored = (over: any = {}) => ({
    id: "t1", sfTransactionId: "TRN-1", date: "2026-09-20",
    description: "Golf Galaxy", status: "PENDING", amount: -10,
    category: "Golf", importHash: "h", notes: null, ...over,
  });

  it("stamps RULE when it rewrites a category", () => {
    const r = reconcileDraft(d(), buildDedupIndex([stored() as any]), infer);
    expect(r.action === "update" && r.patch.category).toBe("Income");
    expect(r.action === "update" && r.patch.categorySource).toBe("RULE");
  });

  it("leaves both category and source untouched on a MANUAL row", () => {
    const r = reconcileDraft(d(), buildDedupIndex([stored({ categorySource: "MANUAL" }) as any]), infer);
    expect(r.action === "update" && r.patch.category).toBeUndefined();
    expect(r.action === "update" && r.patch.categorySource).toBeUndefined();
    // …but the description still gets repaired. MANUAL pins the category only.
    expect(r.action === "update" && r.patch.description).toBe("Meta Payroll");
  });
});

describe("sfTxToDraft — category authorship", () => {
  const acct = { id: "acc1", name: "AMEX", type: "CREDIT", currentBalance: 0 };
  const sf = (over: any = {}) => ({
    id: "TRN-9", posted: "2026-09-21", transactedAt: null, amount: -42,
    description: "NETFLIX.COM", payee: "Netflix", pending: false, ...over,
  });

  it("marks a rule-matched draft RULE", () => {
    const out = sfTxToDraft(sf() as any, acct as any);
    expect(out?.category).toBeTruthy();
    expect(out?.categorySource).toBe("RULE");
  });

  it("leaves the source null when nothing matched, so the LLM pass can claim it", () => {
    const out = sfTxToDraft(sf({ description: "ZZQX UNKNOWABLE 99", payee: "" }) as any, acct as any);
    expect(out?.category).toBeNull();
    expect(out?.categorySource).toBeNull();
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
