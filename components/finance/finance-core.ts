/**
 * components/finance/finance-core.ts
 *
 * Pure, dependency-free finance math: no React, no Amplify client, no I/O.
 * This is the lower layer that both the React UI (`_shared.tsx`, which
 * re-exports everything here) and headless consumers (the financeSnapshots
 * Lambda, the review page's computation module) can import without dragging in
 * the browser/client surface.
 *
 * Keep this file pure. If a helper needs `client`, React, or `Date.now()`-style
 * wall-clock reads, it belongs in `_shared.tsx`, not here.
 */

// Relative (not "@/") so this module resolves in the Amplify function build
// context too — amplify/tsconfig.json doesn't define the "@/" path alias. The
// import is type-only and erased at bundle time, so it adds no runtime weight.
import type { Schema } from "../../amplify/data/resource";

// ── Record types ────────────────────────────────────────────────────────────
// Mechanical Schema lookups — duplicated (not imported) from `_shared.tsx` on
// purpose so this module stays at the bottom of the dependency graph. They
// resolve to the same Schema types, so values are mutually assignable.

export type AccountRecord            = Schema["financeAccount"]["type"];
export type TransactionRecord        = Schema["financeTransaction"]["type"];
export type GoalRecord               = Schema["financeSavingsGoal"]["type"];
export type GoalFundingSourceRecord  = Schema["financeGoalFundingSource"]["type"];
export type HoldingLotRecord         = Schema["financeHoldingLot"]["type"];
export type HoldingRecord            = Schema["financeHolding"]["type"];
export type TickerQuoteRecord        = Schema["financeTickerQuote"]["type"];

/** Asset-class union for a holding lot. Mirrors ASSET_TYPES in `_shared.tsx`. */
export type AssetType = "STOCK" | "ETF" | "MUTUAL_FUND" | "CRYPTO" | "BOND" | "OTHER";

// ── Account classification ────────────────────────────────────────────────────

/** Does this account type hold holdings lots? (brokerage + retirement) */
export function isInvestedAccount(type: string | null | undefined): boolean {
  return type === "BROKERAGE" || type === "RETIREMENT";
}

/** A lot is "vested" by default — only false when the admin explicitly flips it. */
export function isLotVested(l: HoldingLotRecord): boolean {
  return l.isVested !== false;
}

// ── Holdings ──────────────────────────────────────────────────────────────────

/** Quote lookup by (UPPERCASE) ticker. */
export type QuoteMap = Map<string, TickerQuoteRecord>;

export function buildQuoteMap(quotes: TickerQuoteRecord[]): QuoteMap {
  const m: QuoteMap = new Map();
  for (const q of quotes) {
    if (q.ticker) m.set(q.ticker.toUpperCase(), q);
  }
  return m;
}

/**
 * Aggregated view of one ticker in an account.
 *
 * The CURRENT vested position (totalQty / totalCost / marketValue / gainLoss)
 * comes from the `financeHolding` row — the source of truth. Lots contribute
 * only the UNVESTED figures (RSUs, which have no holding row) and the per-lot
 * `lots` list used for the expandable tax-detail sub-rows.
 *
 * `lotQtyDrift` surfaces disagreement between the holding's vested quantity and
 * the sum of its vested lots — non-blocking; lots are allowed to drift now.
 *
 * - totalQty:     holding.quantity (vested); falls back to Σ vested-lot qty when
 *                 no holding row exists yet (pre-backfill / lot-only tickers)
 * - totalCost:    holding.costBasisTotal; falls back to Σ vested-lot costBasis
 * - marketValue:  quote.price * totalQty (null if no quote)
 * - gainLoss / gainLossPct: null unless both totalCost and marketValue are known
 */
export type TickerAggregate = {
  ticker:       string;
  assetType:    AssetType | null;
  holding:      HoldingRecord | null; // the current-position row (null for lot-only/unvested-only tickers)
  lots:         HoldingLotRecord[];   // all lots (vested + unvested) — used for the expanded sub-rows
  totalQty:     number;               // vested — drives "Qty" column on the holdings table
  totalCost:    number | null;        // vested
  price:        number | null;
  fetchedAt:    string | null;
  marketValue:  number | null;        // vested — drives "Value" column
  gainLoss:     number | null;        // vested
  gainLossPct:  number | null;        // vested
  unvestedQty:  number;               // sum of unvested-lot quantities for this ticker
  unvestedValue: number | null;       // unvested qty × price (null if no quote)
  unvestedLotsCount: number;
  lotQtyDrift:  number;               // holding.quantity − Σ(vested lot qty); 0 when in sync or no holding
};

/**
 * Aggregate one ticker: the vested position from its `financeHolding` row, the
 * unvested position + per-lot detail from its lots, joined with a quote map.
 * Pass `holding = null` for tickers that only exist as lots (e.g. unvested RSUs,
 * or positions not yet backfilled).
 */
export function tickerAggregate(
  ticker: string,
  holding: HoldingRecord | null,
  lots: HoldingLotRecord[],
  quotes: QuoteMap,
): TickerAggregate {
  const tickerUpper = ticker.toUpperCase();
  const myLots       = lots
    .filter((l) => (l.ticker ?? "").toUpperCase() === tickerUpper)
    .sort((a, b) => {
      const ap = a.purchaseDate ?? "9999-12-31";
      const bp = b.purchaseDate ?? "9999-12-31";
      if (ap !== bp) return ap.localeCompare(bp);
      const av = a.vestDate ?? "9999-12-31";
      const bv = b.vestDate ?? "9999-12-31";
      return av.localeCompare(bv);
    });
  const vestedLots   = myLots.filter(isLotVested);
  const unvestedLots = myLots.filter((l) => !isLotVested(l));

  // Vested position: holding is authoritative. Fall back to vested lots only
  // when there's no holding row yet (pre-backfill or a lot-only ticker).
  const vestedLotQty = vestedLots.reduce((s, l) => s + (l.quantity ?? 0), 0);
  const anyMissingLotCost = vestedLots.some((l) => l.costBasis == null);
  const vestedLotCost = anyMissingLotCost
    ? null
    : vestedLots.reduce((s, l) => s + (l.costBasis ?? 0), 0);

  const totalQty = holding ? (holding.quantity ?? 0) : vestedLotQty;
  const totalCost = holding
    ? (holding.costBasisTotal ?? null)
    : vestedLotCost;

  const quote = quotes.get(tickerUpper) ?? null;
  const price = quote?.price ?? null;
  const fetchedAt = quote?.fetchedAt ?? null;
  const marketValue = price != null ? price * totalQty : null;
  const gainLoss = marketValue != null && totalCost != null ? marketValue - totalCost : null;
  const gainLossPct = gainLoss != null && totalCost != null && totalCost !== 0
    ? gainLoss / totalCost
    : null;
  // assetType: prefer the holding's; else the first lot's (first wins if lots disagree)
  const assetType = (holding?.assetType
    ?? myLots.find((l) => l.assetType)?.assetType
    ?? null) as AssetType | null;
  const unvestedQty = unvestedLots.reduce((s, l) => s + (l.quantity ?? 0), 0);
  const unvestedValue = price != null ? price * unvestedQty : null;
  // Drift only meaningful when a holding exists AND there are vested lots to compare.
  const lotQtyDrift = holding && vestedLots.length > 0
    ? (holding.quantity ?? 0) - vestedLotQty
    : 0;

  return {
    ticker: tickerUpper,
    assetType,
    holding,
    lots: myLots,
    totalQty,
    totalCost,
    price,
    fetchedAt,
    marketValue,
    gainLoss,
    gainLossPct,
    unvestedQty,
    unvestedValue,
    unvestedLotsCount: unvestedLots.length,
    lotQtyDrift,
  };
}

/**
 * Distinct tickers (uppercase) across current holdings ∪ lots. Holdings cover the
 * vested positions; lots add any ticker that only exists as a lot (unvested RSUs
 * or not-yet-backfilled positions). Pass lots `[]` to enumerate holdings alone.
 */
export function uniqueTickers(
  holdings: HoldingRecord[],
  lots: HoldingLotRecord[] = [],
): string[] {
  const s = new Set<string>();
  for (const h of holdings) {
    if (h.ticker) s.add(h.ticker.toUpperCase());
  }
  for (const l of lots) {
    if (l.ticker) s.add(l.ticker.toUpperCase());
  }
  return Array.from(s).sort();
}

/**
 * Total value of an account including holdings.
 * For non-invested accounts this is just `currentBalance`.
 * For brokerage/retirement accounts it's `currentBalance` (cash) + Σ(holding qty * quote price).
 * Holdings are vested/liquid by definition — unvested RSUs live in lots and are
 * excluded here; see `unvestedValueByHorizon` for forward-looking projections.
 * Holdings with no quote contribute 0 — UI should surface unpriced tickers.
 */
export function accountTotalValue(
  acc: AccountRecord,
  holdings: HoldingRecord[] = [],
  quotes: QuoteMap = new Map(),
): number {
  const cash = acc.currentBalance ?? 0;
  if (!isInvestedAccount(acc.type)) return cash;
  const myHoldings = holdings.filter((h) => h.accountId === acc.id);
  const holdingsValue = myHoldings.reduce((s, h) => {
    const q = quotes.get((h.ticker ?? "").toUpperCase());
    if (!q?.price) return s;
    return s + (h.quantity ?? 0) * q.price;
  }, 0);
  return cash + holdingsValue;
}

// ── Goal allocation ─────────────────────────────────────────────────────────
// See computeGoalAllocations doc for the algorithm and design decisions.

export type GoalAllocationResult = {
  allocatedByGoal:     Map<string, number>;
  surplusByAccount:    Map<string, number>;
  allocatedByMapping:  Map<string, number>;
};

/**
 * Allocate account balances to savings goals given a mapping table.
 *
 * Pure function — no side effects, no I/O. Safe to call on every render; the
 * dashboard already holds all inputs in state. Sub-millisecond for realistic sizes.
 *
 * Algorithm (per account, independent):
 *   remaining = account total value (cash + positions for brokerage/retirement)
 *   for each mapping sorted by priority asc (tiebreak: mapping.id for stable order):
 *     need = max(0, goal.targetAmount - goal.allocatedSoFar)
 *     take = min(remaining, need)
 *     goal.allocatedSoFar += take
 *     remaining -= take
 *   surplus = remaining
 *
 * Design decisions:
 * - **Credit accounts excluded**: negative balances would subtract from goals.
 * - **LOAN accounts excluded**: debt, not an asset.
 * - **Inactive accounts excluded**: mappings stay in the DB for reactivation.
 * - **Negative-balance non-credit accounts excluded**: treat as zero.
 * - **Goals cap at target**: excess on the account becomes surplus (a signal).
 * - **Multi-account goals**: allocated amount accumulates across accounts; cap is global.
 * - **Holdings ARE included**: BROKERAGE/RETIREMENT use accountTotalValue (market-volatile).
 *   Degrades to cash-only when holdings/quotes are empty.
 */
export function computeGoalAllocations(
  accounts: AccountRecord[],
  goals:    GoalRecord[],
  mappings: GoalFundingSourceRecord[],
  holdings: HoldingRecord[] = [],
  quotes:   TickerQuoteRecord[] = [],
): GoalAllocationResult {
  const allocatedByGoal    = new Map<string, number>();
  const surplusByAccount   = new Map<string, number>();
  const allocatedByMapping = new Map<string, number>();

  // Build fast lookups
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const goalById    = new Map(goals.map((g) => [g.id, g]));
  const quoteMap    = buildQuoteMap(quotes);

  // Group mappings by account so each account's fill order is independent
  const mappingsByAccount = new Map<string, GoalFundingSourceRecord[]>();
  for (const m of mappings) {
    if (!m.accountId) continue;
    const bucket = mappingsByAccount.get(m.accountId) ?? [];
    bucket.push(m);
    mappingsByAccount.set(m.accountId, bucket);
  }

  for (const [accountId, accMappings] of [...mappingsByAccount.entries()]
    // Process accounts with fewer mapped goals first: a dedicated account (1 mapping)
    // should fill its goal before a general pool (many mappings) absorbs everything.
    // Tiebreak by account name for stable render order.
    .sort((a, b) => {
      const countDiff = a[1].length - b[1].length;
      if (countDiff !== 0) return countDiff;
      const accA = accountById.get(a[0]);
      const accB = accountById.get(b[0]);
      return (accA?.name ?? "").localeCompare(accB?.name ?? "");
    })
  ) {
    const acc = accountById.get(accountId);
    if (!acc) continue;

    // Skip accounts that can't legitimately fund a goal
    if (acc.active === false) continue;
    if (acc.type === "CREDIT") continue;      // debt account; negative balance
    if (acc.type === "LOAN") continue;        // debt account

    // For brokerage/retirement accounts this includes positions at current market
    // price. For cash-only accounts it's just currentBalance. Clamp to 0 — a
    // negative total (overdrawn) can't fund anything.
    let remaining = Math.max(0, accountTotalValue(acc, holdings, quoteMap));

    // Sort by priority asc, stable tiebreak by mapping id so re-renders are deterministic
    const sorted = [...accMappings].sort((a, b) => {
      const pa = a.priority ?? 100;
      const pb = b.priority ?? 100;
      if (pa !== pb) return pa - pb;
      return (a.id ?? "").localeCompare(b.id ?? "");
    });

    for (const m of sorted) {
      const goal = goalById.get(m.goalId ?? "");
      if (!goal) continue;

      const alreadyAllocated = allocatedByGoal.get(goal.id) ?? 0;
      const need = Math.max(0, (goal.targetAmount ?? 0) - alreadyAllocated);
      const take = Math.min(remaining, need);

      if (take > 0) {
        allocatedByGoal.set(goal.id, alreadyAllocated + take);
        allocatedByMapping.set(m.id, take);
        remaining -= take;
      } else {
        // Record zero allocations so the UI can still show the mapping exists
        allocatedByMapping.set(m.id, 0);
      }
    }

    surplusByAccount.set(accountId, remaining);
  }

  return { allocatedByGoal, surplusByAccount, allocatedByMapping };
}

/**
 * Effective current amount for a goal, preferring computed allocation when the goal
 * has at least one mapping; falling back to the stored (manual) currentAmount otherwise.
 *
 * This is the read path the UI should use everywhere that currently reads goal.currentAmount.
 */
export function effectiveGoalAmount(
  goal: GoalRecord,
  allocations: GoalAllocationResult,
  mappings: GoalFundingSourceRecord[],
): number {
  const hasMapping = mappings.some((m) => m.goalId === goal.id);
  if (hasMapping) {
    return allocations.allocatedByGoal.get(goal.id) ?? 0;
  }
  return goal.currentAmount ?? 0;
}

/** True if any mapping on this goal points at a brokerage or retirement account.
 *  UI uses this to show a "market-volatile funding" hint on the goal card, since
 *  the allocated amount will fluctuate with quotes. */
export function goalHasVolatileFunding(
  goal: GoalRecord,
  mappings: GoalFundingSourceRecord[],
  accounts: AccountRecord[],
): boolean {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  return mappings.some((m) => {
    if (m.goalId !== goal.id) return false;
    const acc = accountById.get(m.accountId ?? "");
    return acc ? isInvestedAccount(acc.type) : false;
  });
}

/** True if the goal has at least one funding-source mapping — used to decide between
 *  computed allocation and manual currentAmount in the UI. */
export function goalHasFundingSource(
  goal: GoalRecord,
  mappings: GoalFundingSourceRecord[],
): boolean {
  return mappings.some((m) => m.goalId === goal.id);
}
