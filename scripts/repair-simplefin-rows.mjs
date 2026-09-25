/**
 * repair-simplefin-rows.mjs
 *
 * One-off repair for rows the SimpleFIN sync left frozen at their pending-time
 * state. Before the identity-based reconcile landed, the sync was create-only
 * and deduped on date+amount, so when a pending charge settled the settled copy
 * was discarded as a "duplicate" and the stored row kept its provisional
 * status, description and date forever.
 *
 * Every synced row carries SimpleFIN's transaction id (as `sfTransactionId`, or
 * legacy `sf:<id>` in `notes`), so the repair is exact — no fuzzy matching.
 *
 * Four phases, each reported and applied independently:
 *   A  epoch ghosts   — PENDING rows dated 1970-01-01 (a dateless pending row
 *                       materialised by the old scripts/_simplefin.mjs date
 *                       helper) that the windowed dedup could never see, so
 *                       every sync re-created them.
 *   B  stale twins    — a PENDING row whose settled copy also exists (the date
 *                       shifted, so it evaded the date+amount dedup). Delete
 *                       the pending one; the settled row is the real record.
 *   C  stale singles  — a PENDING row with no settled copy (the dedup dropped
 *                       it). Refresh status/description/date from the feed.
 *   D  id backfill    — copy the legacy `sf:<id>` note into sfTransactionId.
   E  exact clones    — several rows sharing one SimpleFIN id AND the same
                       date, amount and description: the same transaction
                       written more than once when it fell outside the dedup
                       window. Keep one, delete the rest. Rows that share an id
                       but differ in amount are NOT clones — a contribution and
                       its offsetting leg legitimately do that — so the match
                       is deliberately exact.
 *
 * Rows a human has touched (tagged to a spend group or a goal) are never
 * deleted — they are reported and left for manual review.
 *
 * Usage:
 *   node --env-file=.env.local scripts/repair-simplefin-rows.mjs --dry
 *   node --env-file=.env.local scripts/repair-simplefin-rows.mjs --phase=A,B,C,D
 */
import { fetchAccounts } from "./_simplefin.mjs";
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? "true"] : [a, "true"];
}));
const DRY = !!args.dry;
const PHASES = new Set((args.phase ?? "A,B,C,D,E").split(",").map((x) => x.trim().toUpperCase()));
const cfg = getConfig();

const cognito = new CognitoIdentityProviderClient({ region: cfg.region });
const auth = await cognito.send(new InitiateAuthCommand({
  AuthFlow: "USER_PASSWORD_AUTH", ClientId: cfg.clientId,
  AuthParameters: { USERNAME: process.env.COGNITO_USER, PASSWORD: process.env.COGNITO_PASSWORD },
}));
const JWT = auth.AuthenticationResult?.IdToken;
if (!JWT) throw new Error("auth failed");

async function gql(query, variables = {}) {
  const r = await fetch(cfg.appsyncUrl, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: JWT },
    body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors?.length) throw new Error(JSON.stringify(j.errors));
  return j.data;
}
async function pageAll(name, q, v = {}) {
  const out = []; let nt = null;
  do { const d = await gql(q, { ...v, nextToken: nt }); out.push(...(d[name].items ?? [])); nt = d[name].nextToken; } while (nt);
  return out;
}

/**
 * `sfTransactionId` only exists in an environment after the schema deploys
 * there (CLAUDE.md §5). Probe once: against a stale environment the field is a
 * FieldUndefined validation error, and we fall back to the legacy `sf:<id>`
 * note — which every synced row already carries, so phases A–C work either way.
 * Phase D (populating the column) is simply skipped until the deploy lands.
 */
async function detectIdColumn() {
  try {
    await gql(`query{listFinanceTransactions(limit:1){items{id sfTransactionId}}}`);
    return true;
  } catch (e) {
    if (/FieldUndefined.*sfTransactionId/s.test(String(e.message))) return false;
    throw e;
  }
}
const HAS_ID_COLUMN = await detectIdColumn();
console.log(HAS_ID_COLUMN
  ? "sfTransactionId column: present"
  : "sfTransactionId column: NOT DEPLOYED YET — using the legacy sf: notes, phase D skipped");

const sfIdOf = (t) => t.sfTransactionId || ((t.notes ?? "").startsWith("sf:") ? t.notes.slice(3) : null);
const touched = (t) => !!(t.spendGroupId || t.goalId);
const money = (n) => `$${Number(n).toFixed(2).padStart(10)}`;

const accounts = await pageAll("listFinanceAccounts",
  `query($nextToken:String){listFinanceAccounts(limit:200,nextToken:$nextToken){items{id name} nextToken}}`);
const accName = new Map(accounts.map((a) => [a.id, a.name]));

const txs = await pageAll("listFinanceTransactions",
  `query($nextToken:String){listFinanceTransactions(limit:1000,nextToken:$nextToken){items{
     id accountId amount date status description category notes spendGroupId goalId importHash
     ${HAS_ID_COLUMN ? "sfTransactionId" : ""}
   } nextToken}}`);

// Live feed, keyed by SimpleFIN transaction id.
const { accounts: sfAccounts } = await fetchAccounts(process.env.SIMPLEFIN_ACCESS_URL,
  { start: "2026-01-01", end: new Date(Date.now() + 864e5).toISOString().slice(0, 10) });
const feed = new Map();
for (const a of sfAccounts) for (const t of a.transactions) feed.set(t.id, t);
console.log(`loaded ${txs.length} stored rows, ${feed.size} feed rows, ${accounts.length} accounts\n`);

const deletes = [];   // { row, why }
const updates = [];   // { row, patch, why }
const skipped = [];

// Index stored rows by sf id so we can tell a lone pending row from one whose
// settled copy is already on file.
const byId = new Map();
for (const t of txs) { const k = sfIdOf(t); if (!k) continue; if (!byId.has(k)) byId.set(k, []); byId.get(k).push(t); }

// ── A. epoch ghosts ──────────────────────────────────────────────────────────
if (PHASES.has("A")) {
  for (const t of txs.filter((x) => x.date === "1970-01-01")) {
    if (touched(t)) { skipped.push({ row: t, why: "epoch ghost but user-tagged" }); continue; }
    deletes.push({ row: t, why: "epoch ghost (dateless pending row, re-created every sync)" });
  }
}

// ── B/C. stale PENDING rows with real dates ──────────────────────────────────
const realPending = txs.filter((t) => t.status === "PENDING" && t.date !== "1970-01-01");
for (const t of realPending) {
  const sfId = sfIdOf(t);
  const f = sfId ? feed.get(sfId) : null;
  const siblings = sfId ? (byId.get(sfId) ?? []).filter((x) => x.id !== t.id) : [];
  const settledTwin = siblings.find((x) => x.status === "POSTED");

  if (settledTwin) {
    if (!PHASES.has("B")) continue;
    if (touched(t)) { skipped.push({ row: t, why: "duplicate of a settled row but user-tagged" }); continue; }
    deletes.push({ row: t, why: `duplicate — settled copy already stored (${settledTwin.date})` });
    continue;
  }
  if (!PHASES.has("C")) continue;
  if (!f) { skipped.push({ row: t, why: "no longer in the SimpleFIN feed — left as-is" }); continue; }

  const patch = {};
  if (!f.pending && t.status !== "POSTED") patch.status = "POSTED";
  const payee = (f.payee || f.description || "").trim();
  const redacted = (d) => /x{4,}/i.test(d);
  // Same guards as engine.ts reconcileDraft: never blank a description, never
  // swap a real merchant name for a redaction, and never write a date back to
  // the epoch (a feed row that is still pending carries no posted date).
  if (payee && payee !== (t.description ?? "").trim()
      && !(redacted(payee) && !redacted(t.description ?? ""))) {
    patch.description = payee;
  }
  if (f.posted && f.posted > "2000-01-01" && f.posted !== t.date) patch.date = f.posted;
  if (HAS_ID_COLUMN && !t.sfTransactionId && sfId) patch.sfTransactionId = sfId;
  if (Object.keys(patch).length) updates.push({ row: t, patch, why: "settled / corrected by the feed" });
}

// ── D. id backfill ───────────────────────────────────────────────────────────
if (PHASES.has("D") && HAS_ID_COLUMN) {
  const already = new Set(updates.map((u) => u.row.id));
  const doomed  = new Set(deletes.map((d) => d.row.id));
  for (const t of txs) {
    if (t.sfTransactionId || already.has(t.id) || doomed.has(t.id)) continue;
    const sfId = sfIdOf(t);
    if (sfId) updates.push({ row: t, patch: { sfTransactionId: sfId }, why: "backfill id from notes" });
  }
}

// ── E. exact clones ──────────────────────────────────────────────────────────
if (PHASES.has("E")) {
  const doomed = new Set(deletes.map((d) => d.row.id));
  for (const [, rows] of byId) {
    const alive = rows.filter((r) => !doomed.has(r.id));
    if (alive.length < 2) continue;
    const groups = new Map();
    for (const r of alive) {
      const k = `${r.date}|${Number(r.amount).toFixed(2)}|${(r.description ?? "").trim()}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    for (const clones of groups.values()) {
      if (clones.length < 2) continue;
      // Keep a user-tagged row if there is one, else the first.
      const keep = clones.find(touched) ?? clones[0];
      for (const r of clones) {
        if (r.id === keep.id) continue;
        if (touched(r)) { skipped.push({ row: r, why: "exact clone but user-tagged" }); continue; }
        deletes.push({ row: r, why: "exact clone — same SimpleFIN id, date, amount and description" });
      }
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────
const idOnly = updates.filter((u) => Object.keys(u.patch).length === 1 && u.patch.sfTransactionId);
const real   = updates.filter((u) => !idOnly.includes(u));

console.log(`=== A+B  DELETE ${deletes.length} rows ===`);
const byWhy = new Map();
for (const d of deletes) byWhy.set(d.why.split(" —")[0], (byWhy.get(d.why.split(" —")[0]) ?? 0) + 1);
for (const [w, n] of byWhy) console.log(`  ${String(n).padStart(4)}  ${w}`);
const delPending = deletes.filter((d) => d.row.status === "PENDING");
console.log(`  net amount removed: $${deletes.reduce((s, d) => s + d.row.amount, 0).toFixed(2)}`);
console.log(`  of these ${delPending.length} are PENDING (already excluded from every posted-only total); ` +
            `${deletes.length - delPending.length} are POSTED clones worth $${deletes.filter((d) => d.row.status !== "PENDING").reduce((s, d) => s + d.row.amount, 0).toFixed(2)}`);

console.log(`\n=== C  UPDATE ${real.length} rows in place ===`);
for (const u of real.sort((a, b) => (a.row.date ?? "").localeCompare(b.row.date ?? ""))) {
  const p = u.patch;
  console.log(`  ${u.row.date} ${money(u.row.amount)}  ${(accName.get(u.row.accountId) ?? "?").padEnd(18)} "${u.row.description}"`);
  const bits = [];
  if (p.status) bits.push(`status → ${p.status}`);
  if (p.date) bits.push(`date → ${p.date}`);
  if (p.description) bits.push(`desc → "${p.description}"`);
  console.log(`        ${bits.join("  ·  ")}`);
}
console.log(`\n=== D  BACKFILL sfTransactionId on ${idOnly.length} rows ===`);
console.log(`\n=== SKIPPED ${skipped.length} (need a human) ===`);
for (const s of skipped.slice(0, 20)) console.log(`  ${s.row.date} ${money(s.row.amount)} "${s.row.description}" — ${s.why}`);

if (DRY) { console.log("\n(dry run — nothing written)"); process.exit(0); }

// ── apply ────────────────────────────────────────────────────────────────────
const M_DEL = `mutation($input:DeleteFinanceTransactionInput!){deleteFinanceTransaction(input:$input){id}}`;
const M_UPD = `mutation($input:UpdateFinanceTransactionInput!){updateFinanceTransaction(input:$input){id}}`;
let nd = 0, nu = 0;
for (const d of deletes) { await gql(M_DEL, { input: { id: d.row.id } }); nd++; }
console.log(`deleted ${nd}`);
for (const u of updates) { await gql(M_UPD, { input: { id: u.row.id, ...u.patch } }); nu++; }
console.log(`updated ${nu}`);

// ── verify ───────────────────────────────────────────────────────────────────
const after = await pageAll("listFinanceTransactions",
  `query($nextToken:String){listFinanceTransactions(limit:1000,nextToken:$nextToken){items{id date status notes ${HAS_ID_COLUMN ? "sfTransactionId" : ""}} nextToken}}`);
const stillEpoch = after.filter((t) => t.date === "1970-01-01").length;
const stillPending = after.filter((t) => t.status === "PENDING").length;
const missingId = HAS_ID_COLUMN ? after.filter((t) => !t.sfTransactionId && (t.notes ?? "").startsWith("sf:")).length : "n/a (column not deployed)";
console.log(`\nVERIFY: ${after.length} rows · epoch-dated ${stillEpoch} · PENDING ${stillPending} · sf-noted rows still missing the id column ${missingId}`);
