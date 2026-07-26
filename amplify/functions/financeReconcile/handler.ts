/**
 * financeReconcile/handler.ts
 *
 * Daily balance-drift detector. currentBalance is a hand-maintained cache
 * (UI deltas, SimpleFIN sync, loan posting, scripts all write it); this cron
 * is the invariant check that catches a write path desyncing it from the
 * transaction ledger.
 *
 * Model:
 *   ledgerSum(account) = Σ amount over POSTED rows where accountId = account
 *                      + Σ |amount| over POSTED single-row transfer in-legs
 *                        (rows on OTHER accounts with toAccountId = account
 *                         and no mirror row — see below)
 *   offset(account)    = currentBalance − ledgerSum
 *
 * A non-zero offset is NORMAL — accounts imported mid-life have no
 * starting-balance row, so their offset is a stable constant. The signal is
 * the offset CHANGING between runs (|offset − reconcileOffset| > ε): that
 * means balance and ledger moved by different amounts since the last check.
 *
 * Transfer in-legs: UI-created transfers are ONE row (accountId = source,
 * toAccountId = dest, negative amount) whose save path bumps the dest
 * balance by |amount| without writing a dest row. SimpleFIN self-transfers
 * are TWO mirrored rows (each side has its own row; toAccountId cross-refs).
 * Counting every toAccountId leg would double-count the SF pairs, so an
 * in-leg only counts when no mirror row exists on the receiving account
 * (same date, opposite amount, accountId/toAccountId crossed).
 *
 * The cron never mutates currentBalance. It stamps reconcileOffset +
 * lastReconcileAt on each account and writes one financeReconcileLog row
 * per run (status DRIFT when any account moved).
 */

import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/financeReconcile";
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

type AccountRecord     = Schema["financeAccount"]["type"];
type TransactionRecord = Schema["financeTransaction"]["type"];

const EPSILON = 0.005; // half a cent — float-noise tolerance

async function listAll<T>(
  model: { list: (args?: any) => Promise<{ data: T[]; nextToken?: string | null }> },
  filter?: any,
  cap = 50_000,
): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | null | undefined;
  do {
    const args: any = { limit: 1000, nextToken };
    if (filter) args.filter = filter;
    const { data, nextToken: nt } = await model.list(args);
    out.push(...(data ?? []));
    nextToken = nt ?? null;
  } while (nextToken && out.length < cap);
  return out.slice(0, cap);
}

/** POSTED-or-legacy rows count toward balance; only explicit PENDING doesn't. */
function isPosted(t: TransactionRecord): boolean {
  return t.status !== "PENDING";
}

type PerAccount = {
  accountId:      string;
  name:           string;
  currentBalance: number;
  ledgerSum:      number;
  inLegs:         number;  // single-row transfer in-leg total included in ledgerSum
  txCount:        number;
  offset:         number;
  prevOffset:     number | null;
  delta:          number | null; // offset − prevOffset (null on first run)
  drifted:        boolean;
};

export const handler = async (): Promise<{ ok: boolean; driftCount: number; accountsChecked: number }> => {
  const started = Date.now();
  const client = await getClient();
  const errors: string[] = [];

  // One full-table read, grouped in memory. The whole ledger is needed anyway
  // (every account + cross-account transfer legs), so per-account GSI queries
  // would just re-read the same rows N times.
  const [accounts, txs] = await Promise.all([
    listAll<AccountRecord>(client.models.financeAccount),
    listAll<TransactionRecord>(client.models.financeTransaction),
  ]);

  const posted = txs.filter(isPosted);
  const byAccount = new Map<string, TransactionRecord[]>();
  const inLegsByAccount = new Map<string, TransactionRecord[]>();
  for (const t of posted) {
    if (t.accountId) {
      const b = byAccount.get(t.accountId) ?? [];
      b.push(t);
      byAccount.set(t.accountId, b);
    }
    if (t.type === "TRANSFER" && t.toAccountId && t.toAccountId !== t.accountId) {
      const b = inLegsByAccount.get(t.toAccountId) ?? [];
      b.push(t);
      inLegsByAccount.set(t.toAccountId, b);
    }
  }

  /** True when the receiving account already has its own row for this leg's
   *  money. Mirrors are matched loosely — first run showed strict matching
   *  double-counts real pairs: cross-bank transfers settle days apart, and
   *  imports often type the receiving side INCOME rather than TRANSFER. So:
   *  any dest row of +|leg amount| within ±5 days counts, and each dest row
   *  can mirror at most one leg (consumed). A false match is stable
   *  run-over-run, so drift detection (which alarms on the CHANGE in offset)
   *  is unaffected either way. */
  const consumedMirrors = new Set<string>();
  function hasMirror(leg: TransactionRecord): boolean {
    const destRows = byAccount.get(leg.toAccountId!) ?? [];
    const want = Math.abs(leg.amount ?? 0);
    const legDay = dayNumber(leg.date);
    const m = destRows.find(
      (r) =>
        !consumedMirrors.has(r.id) &&
        Math.abs((r.amount ?? 0) - want) < EPSILON &&
        Math.abs(dayNumber(r.date) - legDay) <= 5,
    );
    if (!m) return false;
    consumedMirrors.add(m.id);
    return true;
  }

  const perAccount: PerAccount[] = [];
  let driftCount = 0;

  for (const acc of accounts) {
    if (acc.active === false) continue;

    const own = byAccount.get(acc.id) ?? [];
    const ownSum = own.reduce((s, t) => s + (t.amount ?? 0), 0);
    // Dest side of a single-row transfer gets +|amount| (matches the UI's
    // adjustBalance semantics), regardless of the source row's sign.
    const inLegs = (inLegsByAccount.get(acc.id) ?? [])
      .filter((leg) => !hasMirror(leg))
      .reduce((s, t) => s + Math.abs(t.amount ?? 0), 0);

    const ledgerSum  = ownSum + inLegs;
    const balance    = acc.currentBalance ?? 0;
    const offset     = balance - ledgerSum;
    const prevOffset = acc.reconcileOffset ?? null;
    const delta      = prevOffset == null ? null : offset - prevOffset;
    const drifted    = delta != null && Math.abs(delta) > EPSILON;
    if (drifted) driftCount++;

    perAccount.push({
      accountId: acc.id,
      name: acc.name ?? "(unnamed)",
      currentBalance: round2(balance),
      ledgerSum: round2(ledgerSum),
      inLegs: round2(inLegs),
      txCount: own.length,
      offset: round2(offset),
      prevOffset: prevOffset == null ? null : round2(prevOffset),
      delta: delta == null ? null : round2(delta),
      drifted,
    });

    try {
      await client.models.financeAccount.update({
        id: acc.id,
        reconcileOffset: offset,
        lastReconcileAt: new Date().toISOString(),
      });
    } catch (e: any) {
      errors.push(`stamp ${acc.name}: ${e?.message ?? e}`);
    }
  }

  const status = errors.length > 0 ? "ERROR" : driftCount > 0 ? "DRIFT" : "OK";
  try {
    await client.models.financeReconcileLog.create({
      runAt: new Date().toISOString(),
      status,
      accountsChecked: perAccount.length,
      driftCount,
      perAccountJson: JSON.stringify(perAccount),
      errorsJson: JSON.stringify(errors),
      durationMs: Date.now() - started,
    });
  } catch (e: any) {
    console.error("[financeReconcile] failed to write log row:", e?.message ?? e);
  }

  if (driftCount > 0) {
    console.warn(
      `[financeReconcile] DRIFT on ${driftCount} account(s): ` +
      perAccount.filter((p) => p.drifted).map((p) => `${p.name} Δ${p.delta}`).join(", "),
    );
  }
  console.log(`[financeReconcile] ${status}: ${perAccount.length} accounts, ${posted.length} posted rows, ${Date.now() - started}ms`);
  return { ok: status !== "ERROR", driftCount, accountsChecked: perAccount.length };
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** YYYY-MM-DD → integer day count (UTC) for cheap date-distance checks. */
function dayNumber(iso: string | null | undefined): number {
  if (!iso) return 0;
  return Math.floor(new Date(iso + "T00:00:00Z").getTime() / 86400000);
}
