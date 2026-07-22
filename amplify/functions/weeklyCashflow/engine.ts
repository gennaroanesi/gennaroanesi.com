/**
 * engine.ts — pure cashflow analysis for the weekly briefing.
 *
 * No AWS, no Amplify client, no wall-clock reads (todayIso is passed in) so it
 * can be unit-tested with plain objects. The handler maps Schema records onto
 * the loose interfaces below and formats/sends the result.
 *
 * Model notes:
 *  - Recurring `nextDate`s in the DB are often stale; we roll each rule forward
 *    by its cadence to the true occurrences inside the window.
 *  - A recurring EXPENSE hits whatever account it's booked to (accountId):
 *    checking rules are direct cash outflows; card rules just raise a card
 *    balance and are NOT projected against checking.
 *  - Card statement balances aren't stored, so current owed is used as a proxy,
 *    and payment due date ≈ last statement close + 21-day grace.
 */

// ── Loose input types ─────────────────────────────────────────────────────────

export interface Account {
  id: string;
  name: string;
  type: string;                 // CHECKING | SAVINGS | BROKERAGE | RETIREMENT | CREDIT | LOAN | CASH | OTHER
  currentBalance: number;       // credit: negative = owed
  creditLimit?: number | null;
  apr?: number | null;          // decimal, e.g. 0.2749
  statementClosingDay?: number | null;
}

export interface Recurring {
  id: string;
  description: string;
  amount: number;               // + income, − expense
  type: string;                 // INCOME | EXPENSE
  cadence: string;              // WEEKLY | BIWEEKLY | MONTHLY | QUARTERLY | SEMIANNUALLY | ANNUALLY
  nextDate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  active?: boolean | null;
  accountId?: string | null;
}

export interface AnalyzeOptions {
  todayIso: string;
  horizonDays?: number;         // default 14
  buffer?: number;              // min safe checking balance, default 750
  siteBase?: string;            // default https://gennaroanesi.com
}

// ── Date helpers (pure) ─────────────────────────────────────────────────────────

function daysInMonth(y: number, m: number): number { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function addMonthsAnchored(iso: string, months: number, anchorDay: number): string {
  const [y, m] = iso.split("-").map(Number);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;                     // 0-based
  const day = Math.min(anchorDay, daysInMonth(ny, nm + 1));
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const MONTH_STEP: Record<string, number> = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUALLY: 6, ANNUALLY: 12 };

function advance(iso: string, cadence: string, anchorDay: number): string {
  const step = MONTH_STEP[cadence];
  if (step != null) return addMonthsAnchored(iso, step, anchorDay);
  if (cadence === "WEEKLY") return addDaysIso(iso, 7);
  if (cadence === "BIWEEKLY") return addDaysIso(iso, 14);
  return iso;
}

interface Occurrence { id: string; date: string; amount: number; type: string; description: string; accountId: string | null }

/** Occurrences of a recurring rule with date in [fromIso, toIso], rolled forward from its (possibly stale) anchor. */
export function occurrencesInWindow(rec: Recurring, fromIso: string, toIso: string): Occurrence[] {
  if (rec.active === false) return [];
  const anchor = rec.nextDate || rec.startDate;
  if (!anchor) return [];
  const anchorDay = parseInt(anchor.split("-")[2], 10);
  let cur = anchor;
  let guard = 0;
  while (cur < fromIso && guard++ < 2000) cur = advance(cur, rec.cadence, anchorDay);
  const out: Occurrence[] = [];
  guard = 0;
  while (cur <= toIso && guard++ < 400) {
    if (rec.endDate && cur > rec.endDate) break;
    out.push({ id: rec.id, date: cur, amount: rec.amount, type: rec.type, description: rec.description, accountId: rec.accountId ?? null });
    cur = advance(cur, rec.cadence, anchorDay);
  }
  return out;
}

const STOP_WORDS = new Set(["from", "with", "into", "your", "this", "that", "payment", "monthly", "auto"]);
function meaningfulWords(s: string): string[] {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

/**
 * Recurring IDs that form an internal-transfer pair — an INCOME rule and an
 * EXPENSE rule of equal magnitude + same cadence that share a meaningful
 * description word (e.g. "Savings" ↔ "Savings from Salary"). These move money
 * between the user's own accounts and should not count as income OR bills.
 */
export function transferRuleIds(recs: Recurring[]): Set<string> {
  const ids = new Set<string>();
  // Explicit transfer type (if/when the recurring model gains one) — always wins.
  for (const r of recs) {
    if (r.active !== false && (r.type === "TRANSFER" || r.type === "INTERNAL_TRANSFER")) ids.add(r.id);
  }
  // Heuristic pairing fallback for the two-rule INCOME/EXPENSE convention.
  const incomes = recs.filter((r) => r.type === "INCOME" && r.active !== false);
  const expenses = recs.filter((r) => r.type === "EXPENSE" && r.active !== false);
  for (const inc of incomes) {
    const incWords = new Set(meaningfulWords(inc.description));
    if (incWords.size === 0) continue;
    for (const exp of expenses) {
      if (Math.abs(Math.abs(inc.amount) - Math.abs(exp.amount)) > 0.005) continue;
      if (inc.cadence !== exp.cadence) continue;
      if (meaningfulWords(exp.description).some((w) => incWords.has(w))) {
        ids.add(inc.id); ids.add(exp.id);
        break;
      }
    }
  }
  return ids;
}

// ── Result types ────────────────────────────────────────────────────────────────

export interface CashflowResult {
  todayIso: string;
  horizonIso: string;
  buffer: number;
  salaryWeek: boolean;
  nextPaycheck: string | null;   // date of the next paycheck in the window, if any
  incomeEvents: Array<{ date: string; amount: number; description: string }>;
  bills: Array<{ date: string; amount: number; description: string; accountName: string; onCard: boolean }>;
  transfers: Array<{ date: string; amount: number; description: string; accountName: string }>;
  balances: {
    checking: Array<{ id: string; name: string; balance: number }>;
    savings: Array<{ id: string; name: string; balance: number }>;
    cards: Array<{ id: string; name: string; owed: number; apr: number | null; utilization: number | null }>;
  };
  projections: Array<{
    id: string; name: string; start: number; minBalance: number; minDate: string; end: number;
    dips: Array<{ date: string; balance: number; description: string }>;
  }>;
  surplus: number;
  moves: string[];                      // "Move $X from … to … before …"
  actions: Array<{ card: string; amount: number; reason: string }>;
  statementsDue: Array<{ card: string; dueDate: string; approxAmount: number }>;
}

// ── Main ──────────────────────────────────────────────────────────────────────────

export function analyzeCashflow(accounts: Account[], recurrings: Recurring[], opts: AnalyzeOptions): CashflowResult {
  const today = opts.todayIso;
  const horizonDays = opts.horizonDays ?? 14;
  const buffer = opts.buffer ?? 750;
  const horizonIso = addDaysIso(today, horizonDays);

  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const checking = accounts.filter((a) => a.type === "CHECKING");
  const savings = accounts.filter((a) => a.type === "SAVINGS");
  const cards = accounts.filter((a) => a.type === "CREDIT");

  // All recurring occurrences in the window.
  const occ = recurrings.flatMap((r) => occurrencesInWindow(r, today, horizonIso));

  // Internal transfers (e.g. "Savings" ↔ "Savings from Salary") are booked as
  // INCOME/EXPENSE recurring but move money between the user's own accounts —
  // exclude them from income AND bills, and surface them separately. They still
  // affect the per-account projection below (a savings sweep really does leave
  // checking), so the projection stays accurate.
  const xferIds = transferRuleIds(recurrings);

  // Income + salary detection. `salaryWeek` means a paycheck lands in the next
  // 7 days (THIS week) — not merely somewhere in the 2-week projection window.
  // With a biweekly salary this correctly alternates week to week. The 07-31
  // paycheck still shows under income + feeds the projection; it just doesn't
  // make the *current* week a salary week.
  const weekEndIso = addDaysIso(today, 7);
  const incomeEvents = occ
    .filter((o) => (o.amount > 0 || o.type === "INCOME") && !xferIds.has(o.id))
    .map((o) => ({ date: o.date, amount: o.amount, description: o.description }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const isSalary = (desc: string) => /salary|paycheck|payroll|meta/i.test(desc);
  const salaryEvents = incomeEvents.filter((e) => isSalary(e.description));
  const salaryWeek = salaryEvents.some((e) => e.date < weekEndIso);
  const nextPaycheck = salaryEvents[0]?.date ?? null;

  // Bills = expense occurrences in window (excluding transfers), tagged with account.
  const bills = occ
    .filter((o) => (o.amount < 0 || o.type === "EXPENSE") && !xferIds.has(o.id))
    .map((o) => {
      const acc = o.accountId ? acctById.get(o.accountId) : undefined;
      return {
        date: o.date, amount: o.amount, description: o.description,
        accountName: acc?.name ?? "—",
        onCard: acc?.type === "CREDIT",
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // Transfers between own accounts — shown for transparency, one row per outflow.
  const transfers = occ
    .filter((o) => xferIds.has(o.id) && o.amount < 0)
    .map((o) => {
      const acc = o.accountId ? acctById.get(o.accountId) : undefined;
      return { date: o.date, amount: o.amount, description: o.description, accountName: acc?.name ?? "—" };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // Per-checking-account projection over the window.
  const projections = checking.map((acc) => {
    const events = occ
      .filter((o) => o.accountId === acc.id)
      .sort((a, b) => a.date.localeCompare(b.date));
    let running = acc.currentBalance ?? 0;
    let minBalance = running;
    let minDate = today;
    const dips: Array<{ date: string; balance: number; description: string }> = [];
    for (const e of events) {
      running += e.amount;
      if (running < minBalance) { minBalance = running; minDate = e.date; }
      if (running < 0) dips.push({ date: e.date, balance: running, description: e.description });
    }
    return { id: acc.id, name: acc.name, start: acc.currentBalance ?? 0, minBalance, minDate, end: running, dips };
  });

  // Surplus above buffer, using the MINIMUM projected balance so we never sweep
  // cash an upcoming bill will need.
  const surplus = projections.reduce((s, p) => s + Math.max(0, p.minBalance - buffer), 0);

  // Money-move suggestions when a checking account dips below the buffer / zero.
  const moves: string[] = [];
  for (const p of projections) {
    if (p.minBalance < buffer) {
      const need = buffer - p.minBalance;
      const label = p.minBalance < 0 ? "goes negative" : "dips below buffer";
      moves.push(
        `${p.name} ${label} to ${fmt(p.minBalance)} on ${p.minDate} — move ~${fmt(Math.ceil(need / 50) * 50)} in before then (e.g. from Schwab brokerage or savings).`,
      );
    }
  }

  // Card statements due in the window (approx: last close + 21-day grace).
  const statementsDue: Array<{ card: string; dueDate: string; approxAmount: number; id: string; apr: number | null }> = [];
  for (const c of cards) {
    const owed = Math.abs(Math.min(0, c.currentBalance ?? 0));
    if (owed <= 0) continue;
    if (c.statementClosingDay) {
      const dueDate = statementDueDate(today, c.statementClosingDay);
      if (dueDate >= today && dueDate <= horizonIso) {
        statementsDue.push({ card: c.name, dueDate, approxAmount: owed, id: c.id, apr: c.apr ?? null });
      }
    }
  }

  // Allocation: statement-due-first, then avalanche (highest APR).
  const actions: Array<{ card: string; amount: number; reason: string }> = [];
  let remaining = surplus;
  const paidByCard = new Map<string, number>();
  // 1) Cover statements due in window (soonest first) to dodge interest.
  for (const s of [...statementsDue].sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
    if (remaining <= 0) break;
    const pay = Math.min(remaining, s.approxAmount);
    if (pay <= 0.5) continue;
    paidByCard.set(s.id, (paidByCard.get(s.id) ?? 0) + pay);
    actions.push({ card: s.card, amount: round2(pay), reason: `statement due ${s.dueDate}` });
    remaining -= pay;
  }
  // 2) Remaining surplus → highest-APR card with balance left. Unknown APR sorts last.
  const byApr = [...cards]
    .filter((c) => Math.abs(Math.min(0, c.currentBalance ?? 0)) - (paidByCard.get(c.id) ?? 0) > 0.5)
    .sort((a, b) => (b.apr ?? -1) - (a.apr ?? -1));
  for (const c of byApr) {
    if (remaining <= 0.5) break;
    const owedLeft = Math.abs(Math.min(0, c.currentBalance ?? 0)) - (paidByCard.get(c.id) ?? 0);
    const pay = Math.min(remaining, owedLeft);
    if (pay <= 0.5) continue;
    paidByCard.set(c.id, (paidByCard.get(c.id) ?? 0) + pay);
    actions.push({ card: c.name, amount: round2(pay), reason: c.apr != null ? `highest APR ${(c.apr * 100).toFixed(1)}%` : "paydown" });
    remaining -= pay;
  }

  return {
    todayIso: today, horizonIso, buffer, salaryWeek, nextPaycheck, incomeEvents, bills, transfers,
    balances: {
      checking: checking.map((a) => ({ id: a.id, name: a.name, balance: a.currentBalance ?? 0 })),
      savings: savings.map((a) => ({ id: a.id, name: a.name, balance: a.currentBalance ?? 0 })),
      cards: cards.map((a) => ({
        id: a.id, name: a.name, owed: Math.abs(Math.min(0, a.currentBalance ?? 0)),
        apr: a.apr ?? null,
        utilization: a.creditLimit ? Math.abs(Math.min(0, a.currentBalance ?? 0)) / a.creditLimit : null,
      })),
    },
    projections,
    surplus: round2(surplus),
    moves,
    actions,
    statementsDue: statementsDue.map((s) => ({ card: s.card, dueDate: s.dueDate, approxAmount: round2(s.approxAmount) })),
  };
}

// Payment due ≈ the statement close on `closingDay` that most recently passed,
// plus a 21-day grace period (conservative / earliest typical due date).
function statementDueDate(todayIso: string, closingDay: number): string {
  const [y, m] = todayIso.split("-").map(Number);
  const day = Math.min(closingDay, daysInMonth(y, m));
  let close = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (close > todayIso) {
    // this month's close hasn't happened yet → use last month's close
    close = addMonthsAnchored(close, -1, closingDay);
  }
  return addDaysIso(close, 21);
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function fmt(n: number): string {
  const s = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return n < 0 ? `-${s}` : s;
}
