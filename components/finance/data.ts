/**
 * components/finance/data.ts
 *
 * Amplify data client singleton, pagination helper, and record-type aliases
 * for the Finance section. Split out of `_shared.tsx` (which re-exports
 * everything here, so existing `@/components/finance/_shared` imports keep
 * working). This is the only finance module that owns the client.
 */

import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";

export const client = generateClient<Schema>();

// ── Pagination helper ────────────────────────────────────────────────────

/**
 * Page through an Amplify `list()` call until all records are retrieved.
 *
 * Amplify's `list()` returns a `nextToken` when more records exist beyond the
 * requested `limit` (default 100 server-side per page). A single call with
 * `limit: 5000` does NOT return the newest 5000 — DynamoDB returns records in
 * internal storage order (hash-distributed), so you'd get an arbitrary subset
 * and any records past that page would silently disappear from the UI.
 *
 * This helper paginates through every page and returns the full list. Client-
 * side sort + filter then operates on the complete set.
 *
 * Safety cap: stops at 50 pages (~5000 records @ 100/page) to prevent runaway
 * loops if something goes wrong server-side. For personal-finance scale this is
 * multiple years of runway; if you ever hit it, time to migrate to a GSI-backed
 * query.
 *
 * Usage:
 *   const txs = await listAll(client.models.financeTransaction);
 *   const accs = await listAll(client.models.financeAccount);
 */
export async function listAll<T>(
  model: {
    list: (args: { limit?: number; nextToken?: string | null; filter?: any }) => Promise<{
      data: T[] | null;
      nextToken?: string | null;
      errors?: any[];
    }>;
  },
  optsOrFilter: { pageSize?: number; maxPages?: number; filter?: any } | any = {},
): Promise<T[]> {
  // Positional-arg quality-of-life: `listAll(model, { date: { ge: "2026-01-01" } })`
  // is accepted as a filter shorthand, alongside the original
  // `listAll(model, { pageSize: 500 })` options shape. We detect by looking
  // for the pagination-control keys.
  const looksLikeOpts =
    optsOrFilter &&
    typeof optsOrFilter === "object" &&
    ("pageSize" in optsOrFilter || "maxPages" in optsOrFilter || "filter" in optsOrFilter);
  const opts: { pageSize?: number; maxPages?: number; filter?: any } =
    looksLikeOpts ? optsOrFilter : { filter: optsOrFilter };

  const pageSize = opts.pageSize ?? 1000;
  const maxPages = opts.maxPages ?? 50;
  const filter   = opts.filter;

  const out: T[] = [];
  let nextToken: string | null | undefined = null;
  let pages = 0;

  do {
    const args: any = { limit: pageSize, nextToken };
    if (filter) args.filter = filter;
    const res: any = await model.list(args);
    if (res?.errors?.length) {
      console.error("[listAll] errors:", res.errors);
      throw new Error(res.errors[0]?.message ?? "list failed");
    }
    if (res?.data?.length) out.push(...res.data);
    nextToken = res?.nextToken ?? null;
    pages++;
    if (pages >= maxPages) {
      console.warn(`[listAll] hit safety cap of ${maxPages} pages — result may be truncated`);
      break;
    }
  } while (nextToken);

  return out;
}

// ── Record types ──────────────────────────────────────────────────────────────

// These aliases already exist in finance-core (the pure bottom layer) — re-export
// them rather than duplicating the definitions.
export type {
  AccountRecord,
  TransactionRecord,
  GoalRecord,
  GoalFundingSourceRecord,
  HoldingLotRecord,
  HoldingRecord,
  TickerQuoteRecord,
} from "./finance-core";

export type RecurringRecord   = Schema["financeRecurring"]["type"];
export type SpendGroupRecord  = Schema["financeSpendGroup"]["type"];
export type AssetRecord       = Schema["financeAsset"]["type"];
export type MilestoneRecord   = Schema["financeGoalMilestone"]["type"];
export type LoanRecord        = Schema["financeLoan"]["type"];
export type LoanPaymentRecord = Schema["financeLoanPayment"]["type"];
export type AccountSnapshotRecord = Schema["financeAccountSnapshot"]["type"];
export type HoldingSnapshotRecord = Schema["financeHoldingSnapshot"]["type"];
export type GoalSnapshotRecord    = Schema["financeGoalSnapshot"]["type"];
export type PaycheckRecord       = Schema["financePaycheck"]["type"];
export type AttachmentRecord     = Schema["attachment"]["type"];
