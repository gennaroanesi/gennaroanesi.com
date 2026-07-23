/**
 * simplefinSync/handler.ts
 *
 * Pulls balances + transactions + holdings from SimpleFIN for every
 * financeAccount with simplefinAccountId set, dedups + categorizes, upserts
 * transactions / balances / holdings, and writes one financeSyncLog audit row
 * per run. Triggered by an EventBridge cron 3×/day (see backend.ts); also
 * invokable ad-hoc.
 *
 * Event payload:
 *   {}                                  → 14-day window, writes (cron default)
 *   { days: 30 }                        → custom lookback
 *   { start: "YYYY-MM-DD", end: "..." } → explicit window
 *   { accountId: "<financeAccountId>" } → limit to one mapped account
 *   { dryRun: true }                    → compute + log, no writes
 *
 * Auth: IAM via schema-level allow.resource(simplefinSync). The SimpleFIN access
 * URL is injected as SIMPLEFIN_ACCESS_URL (Secrets Manager → backend.ts).
 */

import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/simplefinSync";
import type { Schema } from "../../data/resource";
import { fetchAccounts, maskAccessUrl } from "./simplefin";
import {
  sfTxToDraft,
  markSelfTransfers,
  isDuplicate,
  deriveTargetBalance,
  balanceNeedsUpdate,
  desiredHoldingsFromSf,
  diffHoldings,
  isInvested,
  type FinAccount,
  type TxDraft,
  type DedupIndex,
} from "./engine";

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
    const args: any = { limit: 200, nextToken };
    if (filter) args.filter = filter;
    const { data, nextToken: nt } = await model.list(args);
    out.push(...(data ?? []));
    nextToken = nt ?? null;
  } while (nextToken && out.length < cap);
  return out.slice(0, cap);
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

type Payload = {
  days?: number;
  start?: string;
  end?: string;
  accountId?: string;
  dryRun?: boolean;
  // EventBridge scheduled events carry these; used to detect the CRON trigger.
  source?: string;
  "detail-type"?: string;
};

type PerAccount = {
  accountId: string;
  name: string;
  txTotal: number;
  txNew: number;
  duplicates: number;
  balanceBefore: number;
  balanceAfter: number;
  balanceChanged: boolean;
  holdingCreates: number;
  holdingUpdates: number;
  holdingDeletes: number;
};

export const handler = async (event: Payload = {}) => {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const trigger: "CRON" | "MANUAL" =
    event.source === "aws.events" || event["detail-type"] === "Scheduled Event" ? "CRON" : "MANUAL";
  const dryRun = event.dryRun === true;

  const accessUrl = process.env.SIMPLEFIN_ACCESS_URL;
  const days = event.days ?? 14;
  const windowFrom = event.start ?? isoDaysAgo(days);
  const windowTo = event.end ?? isoToday();

  console.log(
    `[simplefinSync] trigger=${trigger} dryRun=${dryRun} window=${windowFrom}→${windowTo} ` +
      `access=${accessUrl ? maskAccessUrl(accessUrl) : "(missing)"}`,
  );

  const errors: string[] = [];
  const bridgeErrors: string[] = [];

  // Fail fast (but still log) when the secret isn't wired.
  if (!accessUrl) {
    errors.push("SIMPLEFIN_ACCESS_URL not set");
    await writeSyncLog({
      startedAt,
      trigger,
      status: "ERROR",
      windowFrom,
      windowTo,
      accountsChecked: 0,
      txPulled: 0,
      txInserted: 0,
      txDuplicate: 0,
      txFailed: 0,
      balancesUpdated: 0,
      holdingsChanged: 0,
      perAccount: [],
      pulled: [],
      errors,
      bridgeErrors,
      durationMs: Date.now() - t0,
    });
    return { ok: false, reason: "no-access-url" };
  }

  const c = await getClient();

  // ── Mapped accounts ─────────────────────────────────────────────────────
  const allAccounts = (await listAll(c.models.financeAccount)) as unknown as FinAccount[];
  let mapped = allAccounts.filter((a) => a.simplefinAccountId && a.simplefinAccountId.trim());
  if (event.accountId) mapped = mapped.filter((a) => a.id === event.accountId);

  if (mapped.length === 0) {
    console.warn("[simplefinSync] no mapped accounts (simplefinAccountId unset); nothing to do");
    await writeSyncLog({
      startedAt,
      trigger,
      status: "OK",
      windowFrom,
      windowTo,
      accountsChecked: 0,
      txPulled: 0,
      txInserted: 0,
      txDuplicate: 0,
      txFailed: 0,
      balancesUpdated: 0,
      holdingsChanged: 0,
      perAccount: [],
      pulled: [],
      errors,
      bridgeErrors,
      durationMs: Date.now() - t0,
    });
    return { ok: true, accountsChecked: 0 };
  }

  const sfIds = mapped.map((a) => a.simplefinAccountId!.trim());
  const byId = new Map(mapped.map((a) => [a.simplefinAccountId!.trim(), a]));

  // ── Pull from SimpleFIN ───────────────────────────────────────────────────
  let sfResult: Awaited<ReturnType<typeof fetchAccounts>>;
  try {
    sfResult = await fetchAccounts(accessUrl, {
      start: windowFrom,
      end: windowTo,
      pending: true,
      accountIds: sfIds,
    });
  } catch (e: any) {
    errors.push(`SimpleFIN fetch failed: ${e?.message ?? String(e)}`);
    await writeSyncLog({
      startedAt,
      trigger,
      status: "ERROR",
      windowFrom,
      windowTo,
      accountsChecked: mapped.length,
      txPulled: 0,
      txInserted: 0,
      txDuplicate: 0,
      txFailed: 0,
      balancesUpdated: 0,
      holdingsChanged: 0,
      perAccount: [],
      pulled: [],
      errors,
      bridgeErrors,
      durationMs: Date.now() - t0,
    });
    return { ok: false, reason: "sf-fetch-failed" };
  }
  bridgeErrors.push(...(sfResult.errors ?? []));
  const sfAccounts = sfResult.accounts;

  const pulled = sfAccounts.map((s) => ({
    sfId: s.id,
    name: s.name,
    balance: s.balance,
    txCount: s.transactions.length,
    holdingCount: s.holdings.length,
  }));
  const txPulled = sfAccounts.reduce((n, s) => n + s.transactions.length, 0);
  console.log(`[simplefinSync] pulled ${sfAccounts.length} account(s), ${txPulled} tx from SimpleFIN`);

  // ── Build + classify drafts ────────────────────────────────────────────────
  const drafts: TxDraft[] = [];
  for (const sfAcc of sfAccounts) {
    const finAcc = byId.get(sfAcc.id);
    if (!finAcc) continue;
    for (const t of sfAcc.transactions) drafts.push(sfTxToDraft(t, finAcc));
  }
  const pairs = markSelfTransfers(drafts);
  if (pairs > 0) console.log(`[simplefinSync] marked ${pairs} self-transfer pair(s)`);

  // ── Dedup index per account ────────────────────────────────────────────────
  const dedupByAccount = new Map<string, DedupIndex>();
  for (const a of mapped) {
    const existing = await listAll(
      c.models.financeTransaction,
      { and: [{ accountId: { eq: a.id } }, { date: { ge: windowFrom } }] },
      5_000,
    );
    const idx: DedupIndex = { hashes: new Set(), dateAmt: new Set() };
    for (const it of existing as any[]) {
      if (it.importHash) idx.hashes.add(it.importHash);
      if (it.date != null && it.amount != null) {
        idx.dateAmt.add(`${it.date}|${Number(it.amount).toFixed(2)}`);
      }
    }
    dedupByAccount.set(a.id, idx);
  }
  const fresh = drafts.filter((d) => !isDuplicate(d, dedupByAccount.get(d.accountId)));
  const dupCount = drafts.length - fresh.length;
  console.log(`[simplefinSync] ${fresh.length} new, ${dupCount} duplicate`);

  // ── Balance + holding diffs ────────────────────────────────────────────────
  const balanceTargetById = new Map<string, { target: number; derived: boolean }>();
  for (const sfAcc of sfAccounts) {
    const finAcc = byId.get(sfAcc.id);
    if (!finAcc) continue;
    const { target, derived } = deriveTargetBalance(finAcc, sfAcc);
    if (balanceNeedsUpdate(finAcc.currentBalance ?? 0, target)) {
      balanceTargetById.set(finAcc.id, { target, derived });
    }
  }

  const holdingCreates: any[] = [];
  const holdingUpdates: any[] = [];
  const holdingDeletes: any[] = [];
  for (const sfAcc of sfAccounts) {
    const finAcc = byId.get(sfAcc.id);
    if (!finAcc || !isInvested(finAcc.type)) continue;
    const desired = desiredHoldingsFromSf(sfAcc);
    const existing = (await listAll(c.models.financeHolding, {
      accountId: { eq: finAcc.id },
    })) as any[];
    const diff = diffHoldings(finAcc.id, desired, existing);
    holdingCreates.push(...diff.creates);
    holdingUpdates.push(...diff.updates);
    holdingDeletes.push(...diff.deletes);
  }
  const holdingsChanged = holdingCreates.length + holdingUpdates.length + holdingDeletes.length;

  // ── Per-account summary ────────────────────────────────────────────────────
  const perAccount = new Map<string, PerAccount>();
  for (const a of mapped) {
    perAccount.set(a.id, {
      accountId: a.id,
      name: a.name,
      txTotal: 0,
      txNew: 0,
      duplicates: 0,
      balanceBefore: a.currentBalance ?? 0,
      balanceAfter: balanceTargetById.get(a.id)?.target ?? (a.currentBalance ?? 0),
      balanceChanged: balanceTargetById.has(a.id),
      holdingCreates: 0,
      holdingUpdates: 0,
      holdingDeletes: 0,
    });
  }
  for (const d of drafts) perAccount.get(d.accountId)!.txTotal++;
  for (const f of fresh) perAccount.get(f.accountId)!.txNew++;
  for (const [, s] of perAccount) s.duplicates = s.txTotal - s.txNew;
  for (const hc of holdingCreates) perAccount.get(hc.accountId)!.holdingCreates++;
  for (const hu of holdingUpdates) perAccount.get(hu.accountId)!.holdingUpdates++;
  for (const hd of holdingDeletes) perAccount.get(hd.accountId)!.holdingDeletes++;

  const perAccountArr = [...perAccount.values()];

  // ── Dry run: log the plan, no writes ───────────────────────────────────────
  if (dryRun) {
    console.log("[simplefinSync] DRY RUN — no writes");
    await writeSyncLog({
      startedAt,
      trigger,
      status: "DRY_RUN",
      windowFrom,
      windowTo,
      accountsChecked: mapped.length,
      txPulled,
      txInserted: 0,
      txDuplicate: dupCount,
      txFailed: 0,
      balancesUpdated: balanceTargetById.size,
      holdingsChanged,
      perAccount: perAccountArr,
      pulled,
      errors,
      bridgeErrors,
      durationMs: Date.now() - t0,
    });
    return {
      ok: true,
      dryRun: true,
      accountsChecked: mapped.length,
      txNew: fresh.length,
      balancesToUpdate: balanceTargetById.size,
      holdingsChanged,
    };
  }

  // ── Writes ─────────────────────────────────────────────────────────────────
  const nowIso = new Date().toISOString();
  let txInserted = 0;
  let txFailed = 0;
  for (const d of fresh) {
    const { errors: e } = await c.models.financeTransaction.create({
      accountId: d.accountId,
      amount: d.amount,
      type: d.type as any,
      category: d.category,
      description: d.description,
      date: d.date,
      status: d.status as any,
      toAccountId: d.toAccountId ?? null,
      ticker: d.ticker,
      importHash: d.importHash,
      notes: d.notes,
    });
    if (e?.length) {
      txFailed++;
      errors.push(`tx create ${d.date} ${d.description.slice(0, 40)}: ${e[0].message}`);
    } else {
      txInserted++;
    }
  }

  // One update() per mapped account: balance (when changed) + sync stamps.
  let balancesUpdated = 0;
  for (const a of mapped) {
    const s = perAccount.get(a.id)!;
    const bal = balanceTargetById.get(a.id);
    const details = {
      fromIso: windowFrom,
      toIso: windowTo,
      txTotal: s.txTotal,
      txNew: s.txNew,
      duplicates: s.duplicates,
      balanceUpdated: !!bal,
      balanceDerived: isInvested(a.type),
    };
    const { errors: e } = await c.models.financeAccount.update({
      id: a.id,
      lastSimplefinSyncAt: nowIso,
      lastSimplefinSyncDetails: JSON.stringify(details),
      ...(bal ? { currentBalance: bal.target, balanceUpdatedAt: nowIso } : {}),
    });
    if (e?.length) {
      errors.push(`account stamp ${a.name}: ${e[0].message}`);
    } else if (bal) {
      balancesUpdated++;
    }
  }

  // Holdings.
  let holdingsWritten = 0;
  for (const hc of holdingCreates) {
    const { errors: e } = await c.models.financeHolding.create({
      accountId: hc.accountId,
      ticker: hc.ticker,
      updatedAt: nowIso,
      ...hc.fields,
    });
    if (e?.length) errors.push(`holding create ${hc.ticker}: ${e[0].message}`);
    else holdingsWritten++;
  }
  for (const hu of holdingUpdates) {
    const { errors: e } = await c.models.financeHolding.update({
      id: hu.id,
      updatedAt: nowIso,
      ...hu.fields,
    });
    if (e?.length) errors.push(`holding update ${hu.ticker}: ${e[0].message}`);
    else holdingsWritten++;
  }
  for (const hd of holdingDeletes) {
    const { errors: e } = await c.models.financeHolding.delete({ id: hd.id });
    if (e?.length) errors.push(`holding delete ${hd.ticker}: ${e[0].message}`);
    else holdingsWritten++;
  }

  const status: "OK" | "PARTIAL" =
    txFailed > 0 || errors.length > 0 ? "PARTIAL" : "OK";
  console.log(
    `[simplefinSync] done: ${txInserted} tx (${txFailed} failed), ${balancesUpdated} balances, ` +
      `${holdingsWritten}/${holdingsChanged} holdings, ${errors.length} errors`,
  );

  await writeSyncLog({
    startedAt,
    trigger,
    status,
    windowFrom,
    windowTo,
    accountsChecked: mapped.length,
    txPulled,
    txInserted,
    txDuplicate: dupCount,
    txFailed,
    balancesUpdated,
    holdingsChanged,
    perAccount: perAccountArr,
    pulled,
    errors,
    bridgeErrors,
    durationMs: Date.now() - t0,
  });

  return {
    ok: true,
    accountsChecked: mapped.length,
    txInserted,
    txFailed,
    balancesUpdated,
    holdingsChanged,
    errorCount: errors.length,
  };
};

// ── Audit log writer ──────────────────────────────────────────────────────────

async function writeSyncLog(row: {
  startedAt: string;
  trigger: "CRON" | "MANUAL";
  status: "OK" | "PARTIAL" | "ERROR" | "DRY_RUN";
  windowFrom: string;
  windowTo: string;
  accountsChecked: number;
  txPulled: number;
  txInserted: number;
  txDuplicate: number;
  txFailed: number;
  balancesUpdated: number;
  holdingsChanged: number;
  perAccount: PerAccount[];
  pulled: unknown[];
  errors: string[];
  bridgeErrors: string[];
  durationMs: number;
}): Promise<void> {
  try {
    const c = await getClient();
    const { errors } = await c.models.financeSyncLog.create({
      startedAt: row.startedAt,
      finishedAt: new Date().toISOString(),
      trigger: row.trigger as any,
      status: row.status as any,
      windowFrom: row.windowFrom,
      windowTo: row.windowTo,
      accountsChecked: row.accountsChecked,
      txPulled: row.txPulled,
      txInserted: row.txInserted,
      txDuplicate: row.txDuplicate,
      txFailed: row.txFailed,
      balancesUpdated: row.balancesUpdated,
      holdingsChanged: row.holdingsChanged,
      errorCount: row.errors.length,
      durationMs: row.durationMs,
      perAccountJson: JSON.stringify(row.perAccount),
      pulledJson: JSON.stringify(row.pulled),
      errorsJson: JSON.stringify(row.errors),
      bridgeErrorsJson: JSON.stringify(row.bridgeErrors),
    });
    if (errors?.length) {
      console.error("[simplefinSync] failed to write financeSyncLog:", errors);
    }
  } catch (e) {
    // Never let logging failure mask the sync result.
    console.error("[simplefinSync] financeSyncLog write threw:", e);
  }
}
