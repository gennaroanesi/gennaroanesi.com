/**
 * components/finance/recurring-match.ts
 *
 * Transaction ↔ recurring-rule fuzzy matching for the Finance section.
 * Split out of `_shared.tsx` (which re-exports everything here).
 * Scoring is pure; `applyRecurringMatch` writes via the data client its
 * caller passes in.
 */

import { advanceByCadence, isRecurrenceLive } from "./format";
import type { Cadence } from "./constants";
import type { RecurringRecord, TransactionRecord } from "./data";

// ── Tx → Recurring matching ────────────────────────────────────────────────

/** Auto-match threshold. Scores ≥ AUTO are applied without asking. */
export const RECURRING_MATCH_AUTO_THRESHOLD = 65;
/** Suggestion threshold. Scores in [SUGGEST, AUTO) show up as candidates. */
export const RECURRING_MATCH_SUGGEST_THRESHOLD = 45;

export type RecurringMatchCandidate = {
  rule:   RecurringRecord;
  score:  number;
  reasons: string[];   // human-readable scoring breakdown for "why this match?"
};

/** Tokenize a description for overlap scoring. Lowercase, strip non-alnum,
 * drop short/common tokens. Keep it cheap — called once per (tx, rule) pair. */
function descriptionTokens(s: string | null | undefined): Set<string> {
  if (!s) return new Set();
  const tokens = s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !COMMON_STOPWORDS.has(t));
  return new Set(tokens);
}

const COMMON_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "pmt", "pay", "payment", "usd",
  "ach", "ppd", "dep", "tfr", "ref", "ref#", "debit", "credit",
]);

/**
 * Score a transaction against a candidate recurring rule. Inputs are pure —
 * no DB access. The scoring weights match the TODO plan.
 *
 * Hard requirements:
 * - Same accountId
 * - Same sign (income tx can't match an expense rule)
 *
 * Returns 0 when hard requirements fail — callers filter out zeroes.
 */
export function scoreTransactionAgainstRecurring(
  tx:   TransactionRecord,
  rule: RecurringRecord,
): { score: number; reasons: string[] } {
  const txAmt   = tx.amount ?? 0;
  const ruleAmt = rule.amount ?? 0;
  if (tx.accountId !== rule.accountId) return { score: 0, reasons: [] };
  if (Math.sign(txAmt) !== Math.sign(ruleAmt)) return { score: 0, reasons: [] };
  if (!isRecurrenceLive(rule)) return { score: 0, reasons: [] };

  const reasons: string[] = [];
  let score = 0;

  // ── Match pattern (user-provided) ────────────────────────────────────
  // When set, the pattern is a strong signal. A hit gives a big score
  // bump; a miss disqualifies the tx entirely (the user is explicitly
  // telling the system how this rule's tx looks).
  if (rule.matchPattern && rule.matchPattern.trim()) {
    const hit = matchesUserPattern(rule.matchPattern, tx.description ?? "");
    if (!hit) return { score: 0, reasons: [] };
    score += 50;
    reasons.push("matches user pattern");
  }

  // ── Amount ───────────────────────────────────────────────────────────
  // For rules WITHOUT a match pattern, amount is the primary "same bill"
  // signal — enforce strictly (±5%) or the rule matches half the ledger.
  // For rules WITH a pattern, the pattern already scoped which txs we're
  // considering, so tolerate variable amounts (utilities / gas / water bills
  // routinely swing 20-50% cycle-to-cycle). Reject only wild outliers.
  const absTx   = Math.abs(txAmt);
  const absRule = Math.abs(ruleAmt);
  const amtDelta = Math.abs(absTx - absRule);
  const amtPct   = absRule > 0 ? amtDelta / absRule : 1;
  const hasPattern = !!(rule.matchPattern && rule.matchPattern.trim());
  if (amtPct < 0.01) { score += 35; reasons.push("amount exact (≤1%)"); }
  else if (amtPct < 0.05) { score += 20; reasons.push("amount close (≤5%)"); }
  else if (hasPattern && amtPct < 0.25) { score += 15; reasons.push("amount within ±25% (variable bill)"); }
  else if (hasPattern && amtPct < 0.75) { score += 5;  reasons.push("amount within ±75% (variable bill)"); }
  else { return { score: 0, reasons: [] }; } // amount too far off to be the same bill

  // ── Date proximity ───────────────────────────────────────────────────
  const ruleNext = rule.nextDate ?? rule.startDate ?? "";
  if (tx.date && ruleNext) {
    const days = Math.abs(daysBetween(tx.date, ruleNext));
    if (days === 0)       { score += 25; reasons.push("same date"); }
    else if (days <= 3)   { score += 20; reasons.push(`${days}d from next date`); }
    else if (days <= 7)   { score += 15; reasons.push(`${days}d from next date`); }
    // Beyond 7 days: no penalty, no bonus
  }

  // ── Description overlap ──────────────────────────────────────────────
  const txTokens   = descriptionTokens(tx.description);
  const ruleTokens = descriptionTokens(rule.description);
  if (txTokens.size && ruleTokens.size) {
    const shared = [...ruleTokens].filter((t) => txTokens.has(t)).length;
    const overlap = shared / ruleTokens.size;
    const ruleStr = (rule.description ?? "").toLowerCase();
    const txStr   = (tx.description ?? "").toLowerCase();
    if (ruleStr && txStr.includes(ruleStr)) {
      score += 25; reasons.push("tx description contains rule description");
    } else if (overlap >= 0.6) {
      score += 20; reasons.push(`${Math.round(overlap * 100)}% token overlap`);
    } else if (overlap >= 0.3) {
      score += 10; reasons.push(`${Math.round(overlap * 100)}% token overlap`);
    }
  }

  // ── Category ─────────────────────────────────────────────────────────
  if (rule.category && tx.category && rule.category === tx.category) {
    score += 10;
    reasons.push("category matches");
  }

  return { score, reasons };
}

/**
 * Test whether a transaction description satisfies a user-provided match
 * pattern. The pattern is either:
 * - a /regex/flags form — parsed as a RegExp (supported flags: i, m, s, u)
 * - anything else — case-insensitive substring match
 *
 * Invalid regexes fall back to substring match so a typo in the rule
 * doesn't disqualify every transaction.
 */
export function matchesUserPattern(pattern: string, description: string): boolean {
  const p = pattern.trim();
  if (!p) return true;
  const regexForm = p.match(/^\/(.+)\/([imsu]*)$/);
  if (regexForm) {
    try {
      return new RegExp(regexForm[1], regexForm[2]).test(description);
    } catch {
      /* fall through to substring */
    }
  }
  return description.toLowerCase().includes(p.toLowerCase());
}

/** Days between two ISO dates. Result is signed (positive = first is later). */
function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T12:00:00Z`).getTime();
  const db = new Date(`${b}T12:00:00Z`).getTime();
  return Math.round((da - db) / (24 * 3600 * 1000));
}

/**
 * Return candidate recurring rules that might match a transaction, sorted by
 * score desc. Scores below the SUGGEST threshold are dropped; callers can
 * decide whether to auto-apply (≥ AUTO) or surface as a suggestion (between).
 */
export function findRecurringMatches(
  tx:       TransactionRecord,
  rules:    RecurringRecord[],
  minScore: number = RECURRING_MATCH_SUGGEST_THRESHOLD,
): RecurringMatchCandidate[] {
  const out: RecurringMatchCandidate[] = [];
  for (const rule of rules) {
    const { score, reasons } = scoreTransactionAgainstRecurring(tx, rule);
    if (score >= minScore) out.push({ rule, score, reasons });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Inverse of findRecurringMatches — given a rule, which unlinked transactions
 * might realize it? Used by the per-rule "candidates" modal on the Recurring
 * page. Callers pass pre-filtered `transactions` (typically the last ~90
 * days, not yet linked to anything).
 */
export type TransactionMatchCandidate = {
  tx:     TransactionRecord;
  score:  number;
  reasons: string[];
};

export function findMatchingTransactionsForRule(
  rule:         RecurringRecord,
  transactions: TransactionRecord[],
  minScore:     number = RECURRING_MATCH_SUGGEST_THRESHOLD,
): TransactionMatchCandidate[] {
  const out: TransactionMatchCandidate[] = [];
  for (const tx of transactions) {
    if (tx.recurringId) continue;   // already claimed by some rule
    const { score, reasons } = scoreTransactionAgainstRecurring(tx, rule);
    if (score >= minScore) out.push({ tx, score, reasons });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Side-effecting helper: set the transaction's `recurringId`, advance the
 * rule's `nextDate` past the tx date (never rewinds), and deactivate the
 * rule if it crossed its `endDate`. Callers should await this before
 * showing success — it performs two writes.
 *
 * Idempotent in practice: if `tx.recurringId` is already set to the same
 * rule we skip the FK write; we always check whether the rule's nextDate
 * needs advancing.
 */
export async function applyRecurringMatch(
  dataClient: any,
  tx:         TransactionRecord,
  rule:       RecurringRecord,
): Promise<void> {
  if (!tx.id || !rule.id || !tx.date) return;

  if (tx.recurringId !== rule.id) {
    await dataClient.models.financeTransaction.update({
      id:          tx.id,
      recurringId: rule.id,
    });
  }

  const cadence = rule.cadence as Cadence | null;
  const seed    = rule.nextDate ?? rule.startDate ?? tx.date;
  // Never rewind — only advance if tx.date is on or after the rule's nextDate.
  // Anchor follows the current value's day-of-month (not startDate), so user
  // edits to nextDate carry forward through subsequent advances.
  if (cadence && tx.date >= seed) {
    let next = seed;
    let guard = 0;
    // Walk forward until we're strictly after tx.date
    while (next <= tx.date && guard++ < 240) {
      next = advanceByCadence(next, cadence);
    }
    const patch: Partial<RecurringRecord> = { nextDate: next };
    if (rule.endDate && next > rule.endDate) patch.active = false;
    await dataClient.models.financeRecurring.update({
      id: rule.id,
      ...patch,
    });
  }
}
