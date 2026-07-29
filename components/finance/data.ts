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
import type { TransactionRecord } from "./finance-core";

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

// ── Transaction reads ─────────────────────────────────────────────────────────

export type TransactionQuery = {
  accountId?: string;
  from?: string;      // YYYY-MM-DD inclusive
  to?: string;        // YYYY-MM-DD inclusive
};

/** All transaction reads in the app go through this seam.
 *
 *  Query strategy:
 *  - accountId present → the accountId+date GSI Query
 *    (listFinanceTransactionByAccountIdAndDate): reads only that account's
 *    rows in date order instead of scanning the whole table. Falls back to
 *    the scan path if the environment hasn't deployed the GSI yet
 *    (FieldUndefined — see CLAUDE.md §5).
 *  - otherwise → scan (+ server-side date filter when from/to given). The
 *    full-ledger surfaces (transactions table, dashboard, review) genuinely
 *    need all accounts; trimming those is a windowing/snapshot problem, not
 *    a query-shape one. */
export async function fetchTransactions(q: TransactionQuery = {}): Promise<TransactionRecord[]> {
  const dateCond =
    q.from && q.to ? { between: [q.from, q.to] as [string, string] } :
    q.from         ? { ge: q.from } :
    q.to           ? { le: q.to } :
    undefined;

  if (q.accountId) {
    try {
      // Raw GraphQL, not the typed client: typed index queries declare their
      // filter variable as Model<PascalCase>FilterInput, but this schema's
      // lowercase model names generate Model<camelCase>FilterInput — AppSync
      // rejects the whole query with VariableTypeMismatch. Same client-codegen
      // bug family as CLAUDE.md §4; raw queries sidestep it.
      return await listAllRawIndex<TransactionRecord>(
        "listFinanceTransactionByAccountIdAndDate",
        `query ByAccount($accountId: ID!, $date: ModelStringKeyConditionInput, $limit: Int, $nextToken: String) {
          listFinanceTransactionByAccountIdAndDate(accountId: $accountId, date: $date, limit: $limit, nextToken: $nextToken) {
            items { ${TX_FIELDS} }
            nextToken
          }
        }`,
        { accountId: q.accountId, date: dateCond ?? null },
      );
    } catch (e: any) {
      // Environment without the GSI deployed rejects with FieldUndefined —
      // fall back to the scan so the page still works (CLAUDE.md §5).
      const msg = String(e?.message ?? e);
      if (msg.includes("FieldUndefined")) {
        console.warn("[fetchTransactions] accountId+date GSI not available here yet — falling back to scan");
      } else {
        throw e;
      }
    }
  }

  const filter: any = {};
  if (q.accountId) filter.accountId = { eq: q.accountId };
  if (dateCond)    filter.date = dateCond;

  if (Object.keys(filter).length === 0) {
    return listAll<TransactionRecord>(client.models.financeTransaction);
  }
  return listAll<TransactionRecord>(client.models.financeTransaction, { filter });
}

// Selection sets for raw index queries. Typed-client index queries are
// unusable against this schema (VariableTypeMismatch — see fetchTransactions),
// so the raw queries need explicit field lists. Keep in sync with the models.
const TX_FIELDS = `id accountId amount type category description date status
  goalId spendGroupId toAccountId importHash recurringId ticker quantity price
  fees lotId consumedCostBasis lotConsumptions notes lineItems createdAt updatedAt`;

const INVOICE_LINK_FIELDS = `id invoiceId transactionId amount createdAt updatedAt`;

/** Paginate a raw-GraphQL index Query to exhaustion. Same page-size /
 *  safety-cap semantics as listAll. `queryName` is the field to unwrap from
 *  the response; `query` must declare $limit and $nextToken. */
async function listAllRawIndex<T>(
  queryName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | null | undefined = null;
  let pages = 0;
  do {
    let res: any;
    try {
      res = await client.graphql({
        query,
        variables: { ...variables, limit: 1000, nextToken },
        authMode: "userPool",
      });
    } catch (e: any) {
      // client.graphql throws a GraphQLResult-shaped error; normalize to a
      // plain Error carrying the first GraphQL message so callers can match.
      const msg = e?.errors?.[0]?.message ?? e?.message ?? String(e);
      throw new Error(msg);
    }
    if (res?.errors?.length) throw new Error(res.errors[0]?.message ?? "index query failed");
    const page = res?.data?.[queryName];
    if (page?.items?.length) out.push(...page.items);
    nextToken = page?.nextToken ?? null;
    pages++;
    if (pages >= 50) {
      console.warn(`[${queryName}] hit safety cap of 50 pages — result may be truncated`);
      break;
    }
  } while (nextToken);
  return out;
}

/** Transactions realizing a recurring rule (already GSI-backed via the
 *  recurringId secondary index — keep using the same filter listAll for now). */
export async function fetchTransactionsByRecurring(recurringId: string): Promise<TransactionRecord[]> {
  return listAll<TransactionRecord>(client.models.financeTransaction, {
    filter: { recurringId: { eq: recurringId } },
  });
}

/** Distinct years present in the ledger, descending. Used by period pickers
 *  so windowed pages don't need the full row set just to know which years
 *  exist. Raw GraphQL selecting ONLY the date field — the server still scans,
 *  but the payload is a few bytes per row instead of full records. */
export async function fetchTransactionYears(): Promise<number[]> {
  const years = new Set<number>();
  let nextToken: string | null = null;
  let pages = 0;
  do {
    const res: any = await client.graphql({
      query: `query TxYears($next: String) {
        listFinanceTransactions(limit: 1000, nextToken: $next) { items { date } nextToken }
      }`,
      variables: { next: nextToken },
      authMode: "userPool",
    });
    const page = res?.data?.listFinanceTransactions;
    for (const it of page?.items ?? []) {
      const y = Number((it?.date ?? "").slice(0, 4));
      if (Number.isFinite(y) && y > 1970) years.add(y);
    }
    nextToken = page?.nextToken ?? null;
    pages++;
  } while (nextToken && pages < 100);
  return [...years].sort((a, b) => b - a);
}

// ── Invoice reads ─────────────────────────────────────────────────────────────

export type InvoiceQuery = { invoiceId?: string; transactionId?: string };

/** All financeInvoice rows. Volume is human-scale (one row per bill), so a
 *  paginated scan is the right shape for the list page. */
export async function fetchInvoices(): Promise<InvoiceRecord[]> {
  // `as any` erases the deep typed-model generic (TS2589 guard, CLAUDE.md §4
  // pattern); the result is re-typed via the explicit listAll<T> parameter.
  return listAll<InvoiceRecord>(client.models.financeInvoice as any);
}

/** Invoice ↔ transaction links, optionally scoped by either FK.
 *
 *  Query strategy mirrors fetchTransactions: raw-GraphQL GSI query when a key
 *  is given (typed index queries are broken by the filter-input casing bug —
 *  see listAllRawIndex), falling back to the filter scan when the environment
 *  hasn't deployed the GSI yet (FieldUndefined). */
export async function fetchInvoiceLinks(q: InvoiceQuery = {}): Promise<InvoiceLinkRecord[]> {
  const indexCall =
    q.invoiceId     ? { name: "listFinanceInvoiceLinkByInvoiceId",     arg: "invoiceId",     value: q.invoiceId } :
    q.transactionId ? { name: "listFinanceInvoiceLinkByTransactionId", arg: "transactionId", value: q.transactionId } :
    null;

  if (indexCall) {
    try {
      return await listAllRawIndex<InvoiceLinkRecord>(
        indexCall.name,
        `query Links($${indexCall.arg}: ID!, $limit: Int, $nextToken: String) {
          ${indexCall.name}(${indexCall.arg}: $${indexCall.arg}, limit: $limit, nextToken: $nextToken) {
            items { ${INVOICE_LINK_FIELDS} }
            nextToken
          }
        }`,
        { [indexCall.arg]: indexCall.value },
      );
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("FieldUndefined")) {
        console.warn("[fetchInvoiceLinks] link GSI not available here yet — falling back to scan");
      } else {
        throw e;
      }
    }
  }

  const filter: any = {};
  if (q.invoiceId)     filter.invoiceId = { eq: q.invoiceId };
  if (q.transactionId) filter.transactionId = { eq: q.transactionId };

  if (Object.keys(filter).length === 0) {
    return listAll<InvoiceLinkRecord>(client.models.financeInvoiceLink as any);
  }
  return listAll<InvoiceLinkRecord>(client.models.financeInvoiceLink as any, { filter });
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
export type InvoiceRecord        = Schema["financeInvoice"]["type"];
export type InvoiceLinkRecord    = Schema["financeInvoiceLink"]["type"];
