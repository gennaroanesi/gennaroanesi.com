/**
 * financeSnapshots/handler.ts
 *
 * Captures a daily row of financeAccountSnapshot per account. Triggered by
 * an EventBridge cron (daily at 11:00 UTC ≈ 6 AM Central, tolerating the
 * 1-hour DST skew rather than maintaining two rules).
 *
 * Event payload shapes:
 *   {}                                           → captures yesterday
 *   { targetDate: "YYYY-MM-DD" }                 → single day
 *   { fromDate: "YYYY-MM-DD",
 *     toDate:   "YYYY-MM-DD" }                   → range, inclusive both ends
 *   { targetDate, accountId }                    → single account on a day
 *
 * Balances are authoritative from account.currentBalance at capture time.
 * For backfills on historical dates, balance is best-effort and may drift
 * from the "balance as of that day" (we only know the live balance). The
 * caller's choice: run the backfill now to seed shape + inflow/outflow
 * even if the balance column is approximate.
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

async function upsertSnapshotsForDate(
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

    // Pull all POSTED transactions on this account for this date.
    const { data: txs } = await c.models.financeTransaction.list({
      filter: {
        accountId: { eq: acc.id },
        date:      { eq: date },
        status:    { eq: "POSTED" as any },
      },
      limit: 500,
    });

    let inflow  = 0;
    let outflow = 0;
    let largest: { amount: number; description: string } | null = null;
    for (const t of txs ?? []) {
      const amt = t.amount ?? 0;
      if (amt > 0) inflow  += amt;
      if (amt < 0) outflow += -amt;
      if (!largest || Math.abs(amt) > Math.abs(largest.amount)) {
        largest = { amount: amt, description: t.description ?? "" };
      }
    }

    // Find existing snapshot for upsert semantics. We look up via the GSI so
    // the common "today only" case is a tight query.
    const existing = await listAll(
      c.models.financeAccountSnapshot,
      {
        and: [
          { accountId: { eq: acc.id } },
          { date:      { eq: date } },
        ],
      },
      1,
    );

    const payload = {
      accountId:            acc.id,
      date,
      balance:              acc.currentBalance ?? 0,
      inflow,
      outflow,
      txCount:              (txs ?? []).length,
      largestTxAmount:      largest?.amount ?? null,
      largestTxDescription: largest?.description ?? null,
      capturedAt,
    };

    try {
      if (existing[0]?.id) {
        await c.models.financeAccountSnapshot.update({ id: existing[0].id, ...payload });
      } else {
        await c.models.financeAccountSnapshot.create(payload);
      }
      count++;
    } catch (err) {
      console.error(`[financeSnapshots] upsert failed for account=${acc.id} date=${date}:`, err);
      skipped++;
    }
  }

  return { date, count, skipped };
}

// ── Handler ─────────────────────────────────────────────────────────────────

type Payload = {
  targetDate?: string;
  fromDate?:   string;
  toDate?:     string;
  accountId?:  string;
};

export const handler = async (event: Payload = {}) => {
  console.log("[financeSnapshots] event:", JSON.stringify(event));

  // Range
  if (event.fromDate && event.toDate) {
    const dates = enumerateDates(event.fromDate, event.toDate);
    const results = [];
    for (const d of dates) {
      results.push(await upsertSnapshotsForDate(d, { accountId: event.accountId }));
    }
    const totalCount   = results.reduce((s, r) => s + r.count,   0);
    const totalSkipped = results.reduce((s, r) => s + r.skipped, 0);
    console.log(`[financeSnapshots] backfill done: ${dates.length} days, ${totalCount} rows, ${totalSkipped} skipped`);
    return { ok: true, days: dates.length, count: totalCount, skipped: totalSkipped };
  }

  // Single target date (explicit or "yesterday" by default)
  const target = event.targetDate ?? yesterdayLocal();
  // Guardrail: don't capture dates in the future
  const today = todayLocal();
  if (target > today) {
    console.warn(`[financeSnapshots] target ${target} is in the future; skipping`);
    return { ok: false, reason: "target-in-future" };
  }
  const result = await upsertSnapshotsForDate(target, { accountId: event.accountId });
  console.log(`[financeSnapshots] ${result.date}: ${result.count} upserted, ${result.skipped} skipped`);
  return { ok: true, ...result };
};
