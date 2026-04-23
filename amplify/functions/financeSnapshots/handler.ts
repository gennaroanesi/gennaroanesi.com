/**
 * financeSnapshots/handler.ts
 *
 * Captures a daily row of financeAccountSnapshot per account. Triggered by
 * an EventBridge cron (daily at 11:00 UTC ≈ 6 AM Central, tolerating the
 * 1-hour DST skew rather than maintaining two rules).
 *
 * Event payload shapes:
 *   {}                                            → captures yesterday
 *   { targetDate: "YYYY-MM-DD" }                  → single day
 *   { fromDate, toDate }                          → range, inclusive both ends
 *   { targetDate, accountId }                     → single account on a day
 *   { fromDate, toDate, backfillMode: "reconstructed" }
 *                                                 → range, computes each day's
 *                                                   balance by walking back from
 *                                                   today's live balance minus
 *                                                   future POSTED transactions
 *
 * Modes:
 *   - "naive" (default): balance column = account.currentBalance at capture
 *     time. Correct for "yesterday at 6 AM" (the cron case); for historical
 *     backfills every row gets today's balance, which makes the balance
 *     column misleading but keeps the flow/txCount columns meaningful.
 *   - "reconstructed": for each target date, balance =
 *     currentBalance − Σ(POSTED tx.amount where tx.date > targetDate). Walks
 *     newest → oldest maintaining a running balance, so it's O(days) writes
 *     plus one tx scan per account. Use this when you care about historical
 *     sparklines reflecting real past balances.
 *
 * Reconstructed mode is *only* applied to range invocations (fromDate+toDate).
 * Daily cron and single-target invocations always use naive — they capture
 * within a few hours of the date in question, so account.currentBalance is a
 * good proxy for end-of-day balance.
 */

import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/financeSnapshots";
import type { Schema } from "../../data/resource";

type DataClient = ReturnType<typeof generateClient<Schema>>;
let _client: DataClient | null = null;

async function getClient(): Promise<DataClient> {
  if (_client) return _client;
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  _client = generateClient<Schema>();
  return _client;
}

async function listAll<T>(
  model: { list: (args?: any) => Promise<{ data: T[]; nextToken?: string | null }> },
  filter?: any,
  cap = 10_000,
): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | null | undefined;
  do {
    const args: any = { limit: 100, nextToken };
    if (filter) args.filter = filter;
    const { data, nextToken: nt } = await model.list(args);
    out.push(...(data ?? []));
    nextToken = nt ?? null;
  } while (nextToken && out.length < cap);
  return out.slice(0, cap);
}

// ── Date helpers (America/Chicago local civil date) ─────────────────────────
// Daily cron fires at 11:00 UTC. That's 6 AM CST / 5 AM CDT. Either way,
// "yesterday local" is safely settled by then.

const TZ = "America/Chicago";

function todayLocal(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

function yesterdayLocal(): string {
  const now = new Date();
  const yest = new Date(now.getTime() - 24 * 3600 * 1000);
  return yest.toLocaleDateString("en-CA", { timeZone: TZ });
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function enumerateDates(from: string, to: string): string[] {
  if (from > to) return [];
  const out: string[] = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

// ── Snapshot computation ────────────────────────────────────────────────────

type TxRow = { date?: string | null; amount?: number | null; description?: string | null };

/**
 * Inflow/outflow/largest from a list of same-day transactions.
 */
function summarizeDay(txs: TxRow[]): {
  inflow: number;
  outflow: number;
  largest: { amount: number; description: string } | null;
} {
  let inflow = 0;
  let outflow = 0;
  let largest: { amount: number; description: string } | null = null;
  for (const t of txs) {
    const amt = t.amount ?? 0;
    if (amt > 0) inflow  += amt;
    if (amt < 0) outflow += -amt;
    if (!largest || Math.abs(amt) > Math.abs(largest.amount)) {
      largest = { amount: amt, description: t.description ?? "" };
    }
  }
  return { inflow, outflow, largest };
}

/**
 * Upsert a snapshot row for a given (accountId, date). Idempotent.
 */
async function upsertSnapshot(
  c: DataClient,
  row: {
    accountId: string;
    date: string;
    balance: number;
    inflow: number;
    outflow: number;
    txCount: number;
    largest: { amount: number; description: string } | null;
    capturedAt: string;
  },
): Promise<boolean> {
  const existing = await listAll(
    c.models.financeAccountSnapshot,
    {
      and: [
        { accountId: { eq: row.accountId } },
        { date:      { eq: row.date } },
      ],
    },
    1,
  );
  const payload = {
    accountId:            row.accountId,
    date:                 row.date,
    balance:              row.balance,
    inflow:               row.inflow,
    outflow:              row.outflow,
    txCount:              row.txCount,
    largestTxAmount:      row.largest?.amount ?? null,
    largestTxDescription: row.largest?.description ?? null,
    capturedAt:           row.capturedAt,
  };
  try {
    if (existing[0]?.id) {
      await c.models.financeAccountSnapshot.update({ id: existing[0].id, ...payload });
    } else {
      await c.models.financeAccountSnapshot.create(payload);
    }
    return true;
  } catch (err) {
    console.error(`[financeSnapshots] upsert failed for account=${row.accountId} date=${row.date}:`, err);
    return false;
  }
}

/**
 * Naive single-date capture: balance = account.currentBalance as of now.
 */
async function upsertNaiveForDate(
  date: string,
  opts?: { accountId?: string },
): Promise<{ date: string; count: number; skipped: number }> {
  const c = await getClient();
  const accounts = await listAll(c.models.financeAccount);
  const filtered = opts?.accountId
    ? accounts.filter((a) => a.id === opts.accountId)
    : accounts;

  let count = 0;
  let skipped = 0;
  const capturedAt = new Date().toISOString();

  for (const acc of filtered) {
    if (!acc.id) { skipped++; continue; }

    const { data: txs } = await c.models.financeTransaction.list({
      filter: {
        accountId: { eq: acc.id },
        date:      { eq: date },
        status:    { eq: "POSTED" as any },
      },
      limit: 500,
    });
    const summary = summarizeDay(txs ?? []);

    const ok = await upsertSnapshot(c, {
      accountId: acc.id,
      date,
      balance: acc.currentBalance ?? 0,
      inflow:  summary.inflow,
      outflow: summary.outflow,
      txCount: (txs ?? []).length,
      largest: summary.largest,
      capturedAt,
    });
    if (ok) count++; else skipped++;
  }

  return { date, count, skipped };
}

/**
 * Reconstructed range backfill. For each account, fetches all POSTED
 * transactions from fromDate → today once, then walks dates backward while
 * maintaining a running balance. Writes N days × N accounts snapshots.
 */
async function upsertReconstructedRange(
  fromDate: string,
  toDate:   string,
  opts?:    { accountId?: string },
): Promise<{ days: number; count: number; skipped: number }> {
  const c = await getClient();
  const accounts = await listAll(c.models.financeAccount);
  const filtered = opts?.accountId
    ? accounts.filter((a) => a.id === opts.accountId)
    : accounts;

  const today = todayLocal();
  const capturedAt = new Date().toISOString();
  const dates = enumerateDates(fromDate, toDate);

  let count = 0;
  let skipped = 0;

  for (const acc of filtered) {
    if (!acc.id) { skipped++; continue; }

    // Pull every POSTED tx from fromDate through today — we need "future of
    // each target date" to derive each day's end-of-day balance. Capped at
    // 10k per account, which is generous for personal use.
    const allTxs = await listAll(
      c.models.financeTransaction,
      {
        and: [
          { accountId: { eq: acc.id } },
          { status:    { eq: "POSTED" as any } },
          { date:      { between: [fromDate, today] } },
        ],
      },
      10_000,
    );

    // Group by date for O(1) per-day lookups.
    const byDate = new Map<string, TxRow[]>();
    for (const t of allTxs) {
      if (!t.date) continue;
      if (!byDate.has(t.date)) byDate.set(t.date, []);
      byDate.get(t.date)!.push(t);
    }

    // Running balance:  balAtEndOf(D) = currentBalance − Σ(tx.date > D).
    // Seed at toDate by subtracting everything strictly after toDate, then
    // walk newest → oldest subtracting each day's flow as we step back.
    const currentBal = acc.currentBalance ?? 0;
    const sumAfterToDate = allTxs
      .filter((t) => t.date && t.date > toDate)
      .reduce((s, t) => s + (t.amount ?? 0), 0);
    let balAtEndOfDate = currentBal - sumAfterToDate;

    // Walk dates descending so we can subtract as we step back one day.
    for (let i = dates.length - 1; i >= 0; i--) {
      const date = dates[i];
      const dayTxs = byDate.get(date) ?? [];
      const summary = summarizeDay(dayTxs);

      const ok = await upsertSnapshot(c, {
        accountId: acc.id,
        date,
        balance: balAtEndOfDate,
        inflow:  summary.inflow,
        outflow: summary.outflow,
        txCount: dayTxs.length,
        largest: summary.largest,
        capturedAt,
      });
      if (ok) count++; else skipped++;

      // Step back: yesterday's end-of-day balance = today's end-of-day − today's flow.
      const dayFlow = dayTxs.reduce((s, t) => s + (t.amount ?? 0), 0);
      balAtEndOfDate -= dayFlow;
    }
  }

  return { days: dates.length, count, skipped };
}

// ── Handler ─────────────────────────────────────────────────────────────────

type Payload = {
  targetDate?:   string;
  fromDate?:     string;
  toDate?:       string;
  accountId?:    string;
  backfillMode?: "naive" | "reconstructed";
};

export const handler = async (event: Payload = {}) => {
  console.log("[financeSnapshots] event:", JSON.stringify(event));

  // Range
  if (event.fromDate && event.toDate) {
    const mode = event.backfillMode ?? "naive";
    if (mode === "reconstructed") {
      const result = await upsertReconstructedRange(event.fromDate, event.toDate, {
        accountId: event.accountId,
      });
      console.log(`[financeSnapshots] reconstructed backfill done: ${result.days} days, ${result.count} rows, ${result.skipped} skipped`);
      return { ok: true, mode, ...result };
    }
    const dates = enumerateDates(event.fromDate, event.toDate);
    const results = [];
    for (const d of dates) {
      results.push(await upsertNaiveForDate(d, { accountId: event.accountId }));
    }
    const totalCount   = results.reduce((s, r) => s + r.count,   0);
    const totalSkipped = results.reduce((s, r) => s + r.skipped, 0);
    console.log(`[financeSnapshots] naive backfill done: ${dates.length} days, ${totalCount} rows, ${totalSkipped} skipped`);
    return { ok: true, mode, days: dates.length, count: totalCount, skipped: totalSkipped };
  }

  // Single target date (explicit or "yesterday" by default)
  const target = event.targetDate ?? yesterdayLocal();
  const today = todayLocal();
  if (target > today) {
    console.warn(`[financeSnapshots] target ${target} is in the future; skipping`);
    return { ok: false, reason: "target-in-future" };
  }
  const result = await upsertNaiveForDate(target, { accountId: event.accountId });
  console.log(`[financeSnapshots] ${result.date}: ${result.count} upserted, ${result.skipped} skipped`);
  return { ok: true, ...result };
};
