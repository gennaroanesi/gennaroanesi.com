/**
 * engine.ts — pure SimpleFIN → finance sync logic (no I/O).
 *
 * Ported from scripts/simplefin_pull.mjs so the scheduled Lambda and the local
 * script agree. Everything here is deterministic given its inputs; the handler
 * supplies the I/O (SimpleFIN fetch, model reads/writes).
 */
import { inferCategory, INVESTMENT_CATEGORY } from "../../../components/finance/categories";
import tickerMap from "../../../scripts/data/security_ticker_map.json";
import type { SfAccount, SfTransaction } from "./simplefin";

export const INVESTED_TYPES = new Set(["BROKERAGE", "RETIREMENT"]);
export function isInvested(type: string | null | undefined): boolean {
  return INVESTED_TYPES.has(type ?? "");
}

export type FinAccount = {
  id: string;
  name: string;
  type: string;
  currentBalance: number | null;
  simplefinAccountId?: string | null;
};

export type TxType = "INCOME" | "EXPENSE" | "TRANSFER" | "BUY" | "SELL";

export type TxDraft = {
  accountId: string;
  date: string;
  amount: number;
  description: string;
  type: TxType;
  status: "POSTED" | "PENDING";
  category: string | null;
  ticker: string | null;
  toAccountId?: string | null;
  importHash: string;
  notes: string;
};

// ── Security-name → ticker classification ─────────────────────────────────────

type TickerRule = { contains: string; ticker: string };

/** Uppercase; collapse . , & ® ™ and whitespace runs to single spaces. */
export function normalizeName(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    .replace(/[.,&®™]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TICKER_RULES: TickerRule[] = (((tickerMap as any).rules ?? []) as any[]).map((r) => ({
  contains: normalizeName(r.contains),
  ticker: r.ticker as string,
}));

function resolveTicker(candidates: Array<string | null | undefined>): string | null {
  const texts = candidates.map((c) => normalizeName(c)).filter(Boolean);
  for (const r of TICKER_RULES) {
    if (texts.some((t) => t.includes(r.contains))) return r.ticker;
  }
  return null;
}

/**
 * Classify a brokerage cash row as a security trade. SimpleFIN gives no
 * shares/price, so BUY = cash out (amount < 0), SELL = cash in (amount > 0).
 * Unmapped names are never guessed.
 */
function classifyTrade(tx: {
  description: string;
  payee: string;
  amount: number;
}): { isTrade: boolean; side?: "BUY" | "SELL"; ticker?: string } {
  if (!tx.amount || tx.amount === 0) return { isTrade: false };
  const ticker = resolveTicker([tx.description, tx.payee]);
  if (!ticker) return { isTrade: false };
  return { isTrade: true, side: tx.amount < 0 ? "BUY" : "SELL", ticker };
}

// ── Dedup hash (matches CSV importer + script) ────────────────────────────────

export function importHash(date: string, amount: number, description: string): string {
  const raw = [date, Number(amount).toFixed(2), (description ?? "").trim().toLowerCase()].join("|");
  return Buffer.from(raw, "utf8").toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}

// ── Draft building ────────────────────────────────────────────────────────────

export function sfTxToDraft(sfTx: SfTransaction, finAccount: FinAccount): TxDraft {
  const invested = isInvested(finAccount.type);
  const trade = invested
    ? classifyTrade({ description: sfTx.description, payee: sfTx.payee, amount: sfTx.amount })
    : { isTrade: false as const };

  let type: TxType;
  let category: string | null;
  let ticker: string | null = null;

  // For trades, prefer the security name (SF description) over the generic
  // payee ("Charles Schwab") so the ledger row is self-describing.
  const description =
    (trade.isTrade ? sfTx.description || sfTx.payee : sfTx.payee || sfTx.description) || "(no description)";

  if (trade.isTrade) {
    type = trade.side as TxType;
    ticker = trade.ticker ?? null;
    category = INVESTMENT_CATEGORY;
  } else {
    type = sfTx.amount >= 0 ? "INCOME" : "EXPENSE";
    category = inferCategory({ type, description });
    // On investment accounts, never let an uncategorized row — or the generic
    // INCOME→"Income" fallback — pollute real income. Default to Investments so
    // brokerage cash movements drop out of the review's P&L.
    if (invested && (!category || category === "Income")) {
      category = INVESTMENT_CATEGORY;
    }
  }

  return {
    accountId: finAccount.id,
    date: sfTx.posted,
    amount: sfTx.amount,
    description,
    type,
    status: sfTx.pending ? "PENDING" : "POSTED",
    category: category ?? null,
    ticker,
    importHash: importHash(sfTx.posted, sfTx.amount, description),
    notes: `sf:${sfTx.id}`,
  };
}

/**
 * Mark pairs of drafts that look like a self-transfer (same date, exact-opposite
 * amounts, different mapped accounts) as TRANSFER with toAccountId cross-refs.
 * Greedy: first match wins; each row pairs at most once. Returns the pair count.
 */
export function markSelfTransfers(drafts: TxDraft[]): number {
  const used = new Set<number>();
  let paired = 0;
  for (let i = 0; i < drafts.length; i++) {
    if (used.has(i)) continue;
    const a = drafts[i];
    for (let j = i + 1; j < drafts.length; j++) {
      if (used.has(j)) continue;
      const b = drafts[j];
      if (a.date !== b.date) continue;
      if (a.accountId === b.accountId) continue;
      if (Math.abs(a.amount + b.amount) > 0.005) continue;
      a.type = "TRANSFER";
      a.toAccountId = b.accountId;
      a.category = "Transfers";
      b.type = "TRANSFER";
      b.toAccountId = a.accountId;
      b.category = "Transfers";
      used.add(i);
      used.add(j);
      paired++;
      break;
    }
  }
  return paired;
}

// ── Dedup ─────────────────────────────────────────────────────────────────────

export type DedupIndex = { hashes: Set<string>; dateAmt: Set<string> };

export function isDuplicate(draft: TxDraft, idx: DedupIndex | undefined): boolean {
  if (!idx) return false;
  if (idx.hashes.has(draft.importHash)) return true;
  if (idx.dateAmt.has(`${draft.date}|${draft.amount.toFixed(2)}`)) return true;
  return false;
}

// ── Balance derivation ────────────────────────────────────────────────────────
// SimpleFIN's `balance` is the TOTAL account value. Plain cash/debt accounts
// store that directly. For BROKERAGE/RETIREMENT the model keeps currentBalance
// as CASH ONLY (positions live in financeHolding), so cash = SF total − Σ(SF
// holding market values) to avoid double-counting.

export function deriveTargetBalance(
  finAcc: FinAccount,
  sfAcc: SfAccount,
): { target: number; derived: boolean } {
  if (isInvested(finAcc.type)) {
    const posSum = (sfAcc.holdings || []).reduce((s, h) => s + (h.marketValue || 0), 0);
    return { target: sfAcc.balance - posSum, derived: true };
  }
  return { target: sfAcc.balance, derived: false };
}

/** True when the SF-derived target differs from the stored balance by ≥ $0.005. */
export function balanceNeedsUpdate(current: number, target: number): boolean {
  return Math.abs(current - target) >= 0.005;
}

// ── Holdings ──────────────────────────────────────────────────────────────────

export type DesiredHolding = {
  ticker: string;
  shares: number;
  costBasis: number;
  marketValue: number;
  hasCost: boolean;
};

/**
 * Collapse a SimpleFIN account's raw holdings into one desired holding per
 * ticker. SF sometimes emits duplicate/garbage rows (e.g. the same position at
 * shares=0 many times); aggregating by symbol and dropping ~zero-share results
 * filters those out. Keyed by UPPERCASE ticker.
 */
export function desiredHoldingsFromSf(sfAcc: SfAccount): Map<string, DesiredHolding> {
  const byTicker = new Map<string, DesiredHolding>();
  for (const h of sfAcc.holdings ?? []) {
    const ticker = (h.symbol ?? "").trim().toUpperCase();
    if (!ticker) continue;
    const agg =
      byTicker.get(ticker) ?? { ticker, shares: 0, costBasis: 0, marketValue: 0, hasCost: false };
    agg.shares += h.shares ?? 0;
    // SF reports 0.00 cost_basis when basis is unknown (e.g. 401k funds). Treat
    // only a positive basis as real so we don't manufacture a full-gain row.
    if (h.costBasis != null && h.costBasis > 0) {
      agg.costBasis += h.costBasis;
      agg.hasCost = true;
    }
    if (h.marketValue != null) agg.marketValue += h.marketValue;
    byTicker.set(ticker, agg);
  }
  for (const [k, v] of [...byTicker]) {
    if (Math.abs(v.shares) < 1e-9) byTicker.delete(k);
  }
  return byTicker;
}

export type ExistingHolding = {
  id: string;
  ticker?: string | null;
  quantity?: number | null;
  source?: string | null;
};

export type HoldingCreate = {
  accountId: string;
  ticker: string;
  fields: {
    quantity: number;
    costBasisTotal: number | null;
    avgCostBasis: number | null;
    source: "SIMPLEFIN";
    marketValueReported: number;
  };
};
export type HoldingUpdate = HoldingCreate & { id: string; prevQuantity: number };
export type HoldingDelete = { accountId: string; ticker: string; id: string };

/**
 * Diff SF-desired holdings against the existing financeHolding rows for one
 * invested account. SF is authoritative for its own rows: match by ticker,
 * write source=SIMPLEFIN, and delete SF-owned rows for positions that vanished
 * (sold out). MANUAL rows are never touched.
 */
export function diffHoldings(
  accountId: string,
  desired: Map<string, DesiredHolding>,
  existing: ExistingHolding[],
): { creates: HoldingCreate[]; updates: HoldingUpdate[]; deletes: HoldingDelete[] } {
  const creates: HoldingCreate[] = [];
  const updates: HoldingUpdate[] = [];
  const deletes: HoldingDelete[] = [];
  const existingByTicker = new Map(existing.map((h) => [(h.ticker ?? "").toUpperCase(), h]));

  for (const [ticker, d] of desired) {
    const avg = d.hasCost && Math.abs(d.shares) > 1e-9 ? d.costBasis / d.shares : null;
    const fields = {
      quantity: d.shares,
      costBasisTotal: d.hasCost ? d.costBasis : null,
      avgCostBasis: avg,
      source: "SIMPLEFIN" as const,
      marketValueReported: d.marketValue,
    };
    const ex = existingByTicker.get(ticker);
    if (ex) updates.push({ accountId, ticker, id: ex.id, fields, prevQuantity: ex.quantity ?? 0 });
    else creates.push({ accountId, ticker, fields });
  }
  for (const [ticker, ex] of existingByTicker) {
    if (desired.has(ticker)) continue;
    if (ex.source !== "SIMPLEFIN") continue; // don't touch manual rows
    deletes.push({ accountId, ticker, id: ex.id });
  }
  return { creates, updates, deletes };
}
