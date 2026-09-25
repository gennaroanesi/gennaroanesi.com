/**
 * engine.ts — pure SimpleFIN → finance sync logic (no I/O).
 *
 * Ported from scripts/simplefin_pull.mjs so the scheduled Lambda and the local
 * script agree. Everything here is deterministic given its inputs; the handler
 * supplies the I/O (SimpleFIN fetch, model reads/writes).
 */
import { inferCategory, INVESTMENT_CATEGORY, type CategoryRule } from "../../../components/finance/categories";
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
  /** SimpleFIN's transaction id — the row's stable identity across pending → posted. */
  sfTransactionId: string;
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

export function sfTxToDraft(sfTx: SfTransaction, finAccount: FinAccount, rules?: CategoryRule[]): TxDraft | null {
  // No usable date (SimpleFIN gave neither posted nor transacted_at) → skip.
  // Materializing it would store a 1970 epoch row the windowed dedup can never
  // see, so every sync would re-create it (the "8 ghost rows" bug).
  if (!sfTx.posted) return null;
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
    // amount is passed alongside type so inferCategory's direction check (which
    // turns a money-IN merchant match into a Refund) doesn't have to rely on the
    // type we just derived from that same sign.
    category = inferCategory({ type, description, amount: sfTx.amount }, rules);
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
    sfTransactionId: sfTx.id,
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

// ── Dedup / reconciliation ────────────────────────────────────────────────────

/** The subset of a stored row the sync needs in order to reconcile against it. */
export type ExistingTx = {
  id: string;
  date?: string | null;
  amount?: number | null;
  description?: string | null;
  status?: string | null;
  category?: string | null;
  importHash?: string | null;
  sfTransactionId?: string | null;
  notes?: string | null;
};

export type DedupIndex = {
  /** Fingerprint → a stored row matching it. Values matter: a collision only
   *  means "already imported" when the row it hit has no identity of its own. */
  hashes:  Map<string, ExistingTx>;
  dateAmt: Map<string, ExistingTx>;
  /** SimpleFIN transaction id → the stored row carrying it. */
  bySfId:  Map<string, ExistingTx>;
};

/**
 * SimpleFIN's transaction id for a stored row. Prefers the dedicated column;
 * falls back to the legacy `sf:<id>` notes convention so rows written before
 * `sfTransactionId` existed still reconcile instead of duplicating.
 */
export function storedSfId(row: ExistingTx): string | null {
  if (row.sfTransactionId) return row.sfTransactionId;
  const n = row.notes ?? "";
  return n.startsWith("sf:") ? n.slice(3) : null;
}

export function buildDedupIndex(rows: ExistingTx[]): DedupIndex {
  const idx: DedupIndex = { hashes: new Map(), dateAmt: new Map(), bySfId: new Map() };
  for (const r of rows) {
    if (r.importHash && !idx.hashes.has(r.importHash)) idx.hashes.set(r.importHash, r);
    if (r.date != null && r.amount != null) {
      const k = `${r.date}|${Number(r.amount).toFixed(2)}`;
      // Prefer an id-less row as the representative: it is the only kind the
      // fingerprint fallback is allowed to match against.
      if (!idx.dateAmt.has(k) || (storedSfId(idx.dateAmt.get(k)!) && !storedSfId(r))) {
        idx.dateAmt.set(k, r);
      }
    }
    const sfId = storedSfId(r);
    // First writer wins: on the duplicate rows this bug already created, we
    // reconcile against one of them and leave the rest to the backfill.
    if (sfId && !idx.bySfId.has(sfId)) idx.bySfId.set(sfId, r);
  }
  return idx;
}

/** A masked descriptor such as "ACCT XXXXXX" — less informative than what it replaces. */
export function isRedacted(description: string): boolean {
  return /x{4,}/i.test(description);
}

/** Fields a settled transaction can legitimately change after it was first seen. */
export type TxPatch = {
  date?: string;
  description?: string;
  status?: "POSTED" | "PENDING";
  importHash?: string;
  category?: string | null;
  sfTransactionId?: string;
};

export type Reconciliation =
  | { action: "create"; draft: TxDraft }
  | { action: "update"; id: string; patch: TxPatch; draft: TxDraft }
  | { action: "skip";   draft: TxDraft };

/**
 * Decide what a freshly-pulled draft should do to the stored ledger.
 *
 * Identity first: when SimpleFIN's transaction id is already on a stored row,
 * that row IS this transaction — whatever changed (a pending charge settling,
 * its description filling out, its date shifting) is an update, never a new
 * row and never a "duplicate" to drop. Only when the id is unknown do we fall
 * back to the old fingerprint heuristics, which exist for pre-id rows.
 *
 * `inferForDescription` lets the caller re-categorize a row whose description
 * changed. It is applied conservatively — see shouldRecategorize.
 */
export function reconcileDraft(
  draft: TxDraft,
  idx: DedupIndex | undefined,
  inferForDescription?: (description: string) => string | null,
): Reconciliation {
  const existing = idx?.bySfId.get(draft.sfTransactionId);

  if (existing) {
    const patch: TxPatch = {};
    if (!existing.sfTransactionId) patch.sfTransactionId = draft.sfTransactionId;
    if (draft.date && existing.date !== draft.date) patch.date = draft.date;

    // A pending row's payee is often a truncated prefix of the settled one, so
    // the settled text normally wins — but never accept an empty one, and never
    // trade a real merchant name for a redacted placeholder ("Feedamerica
    // Chicago Usa" → "Feedamerica Xxxxxx"), which some institutions start
    // returning once a charge clears.
    const newDesc = (draft.description ?? "").trim();
    const oldDesc = (existing.description ?? "").trim();
    if (newDesc && newDesc !== oldDesc && !(isRedacted(newDesc) && !isRedacted(oldDesc))) {
      patch.description = newDesc;
    }

    const newStatus = draft.status;
    if ((existing.status ?? "") !== newStatus) patch.status = newStatus;

    if (patch.date || patch.description) patch.importHash = draft.importHash;

    if (patch.description && inferForDescription) {
      const next = shouldRecategorize(oldDesc, newDesc, existing.category ?? null, inferForDescription);
      if (next !== undefined) patch.category = next;
    }

    return Object.keys(patch).length > 0
      ? { action: "update", id: existing.id, patch, draft }
      : { action: "skip", draft };
  }

  // No stored row carries this id. The fingerprint heuristics are the only
  // thing left, and they are deliberately weak: they may only suppress a draft
  // when the row they collide with has NO identity of its own — i.e. it could
  // plausibly BE this transaction, imported before ids were kept. A collision
  // against a row that already belongs to some other SimpleFIN transaction is
  // just two genuinely separate charges that share a date and amount (two $3
  // subway taps, two identical tolls), and must still be created.
  if (idx) {
    const byHash = idx.hashes.get(draft.importHash);
    if (byHash && !storedSfId(byHash)) return { action: "skip", draft };
    const byDateAmt = idx.dateAmt.get(`${draft.date}|${draft.amount.toFixed(2)}`);
    if (byDateAmt && !storedSfId(byDateAmt)) return { action: "skip", draft };
  }
  return { action: "create", draft };
}

/**
 * The new category for a row whose description changed, or undefined to leave
 * it alone.
 *
 * A stored category is only overwritten when it still equals what the OLD
 * description would have inferred — i.e. it looks machine-assigned. Anything
 * else (a hand-picked category, an LLM fallback that no rule reproduces) is
 * treated as deliberate and preserved. This matters because the descriptions
 * being repaired are exactly the ones that were classified from truncated text:
 * "Certificate of Origin Meta" becoming "Meta Payroll" should re-file as
 * payroll, but a row the user manually moved to "Dolce" should stay there.
 */
export function shouldRecategorize(
  oldDescription: string,
  newDescription: string,
  storedCategory: string | null,
  infer: (description: string) => string | null,
): string | null | undefined {
  const fromOld = infer(oldDescription);
  const fromNew = infer(newDescription);
  if (fromNew === null || fromNew === fromOld) return undefined;      // nothing better to say
  const stored = (storedCategory ?? "").trim();
  if (stored === "" ) return fromNew;                                  // never categorized
  if (stored === (fromOld ?? "")) return fromNew;                      // machine-assigned → refresh
  return undefined;                                                    // user-owned → leave alone
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
