/**
 * Schwab brokerage CSV parser.
 *
 * Input columns (observed):
 *   Date, Action, Symbol, Description, Quantity, Price, Fees & Comm, Amount
 *
 * Each row maps to one of a small set of action types. The importer
 * (SchwabImportPanel) translates these into our domain — trade rows for
 * Buy / Sell / Reinvest Shares, INCOME for dividends + Bank Interest,
 * EXPENSE for outbound transfers, and bare lot creation for Stock Plan
 * Activity (RSU vesting — no cash side).
 */

import {
  importHash, splitCsvRow, toIsoDate, parseCurrencyAmt,
} from "@/components/finance/_shared";

export type SchwabAction =
  | "BANK_INTEREST"
  | "BANK_TRANSFER"
  | "MONEYLINK_TRANSFER"
  | "BUY"
  | "SELL"
  | "REINVEST_SHARES"
  | "REINVEST_DIVIDEND"
  | "QUAL_DIV_REINVEST"
  | "QUALIFIED_DIVIDEND"
  | "STOCK_PLAN_ACTIVITY"
  | "UNKNOWN";

export type SchwabRow = {
  date:        string;        // YYYY-MM-DD (posting date when "as of" is present)
  asOfDate:    string | null; // optional original "as of" date, kept for reference
  action:      SchwabAction;
  rawAction:   string;        // verbatim action text — useful for UNKNOWN debugging
  symbol:      string;        // ticker, empty when N/A (Bank Interest etc.)
  description: string;
  quantity:    number | null;
  price:       number | null;
  fees:        number | null;
  amount:      number | null; // null when Schwab leaves it blank (Stock Plan Activity)
  hash:        string;        // dedup fingerprint
};

const ACTION_MAP: Record<string, SchwabAction> = {
  "bank interest":         "BANK_INTEREST",
  "bank transfer":         "BANK_TRANSFER",
  "moneylink transfer":    "MONEYLINK_TRANSFER",
  "buy":                   "BUY",
  "sell":                  "SELL",
  "reinvest shares":       "REINVEST_SHARES",
  "reinvest dividend":     "REINVEST_DIVIDEND",
  "qual div reinvest":     "QUAL_DIV_REINVEST",
  "qualified dividend":    "QUALIFIED_DIVIDEND",
  "stock plan activity":   "STOCK_PLAN_ACTIVITY",
};

const ACTION_LABELS: Record<SchwabAction, string> = {
  BANK_INTEREST:        "Bank Interest",
  BANK_TRANSFER:        "Bank Transfer",
  MONEYLINK_TRANSFER:   "MoneyLink Transfer",
  BUY:                  "Buy",
  SELL:                 "Sell",
  REINVEST_SHARES:      "Reinvest Shares",
  REINVEST_DIVIDEND:    "Reinvest Dividend",
  QUAL_DIV_REINVEST:    "Qual Div Reinvest",
  QUALIFIED_DIVIDEND:   "Qualified Dividend",
  STOCK_PLAN_ACTIVITY:  "Stock Plan Activity",
  UNKNOWN:              "Unknown",
};

export function labelForSchwabAction(a: SchwabAction): string {
  return ACTION_LABELS[a];
}

// Strip the optional "as of YYYY-MM-DD" suffix Schwab attaches when a
// transaction's posting date and trade/value date differ. We anchor on
// the first date (posting), and stash the second in asOfDate if present.
function parseSchwabDate(raw: string): { date: string; asOfDate: string | null } {
  const m = raw.match(/^(\S+)\s+as\s+of\s+(\S+)$/i);
  if (m) return { date: toIsoDate(m[1]), asOfDate: toIsoDate(m[2]) };
  return { date: toIsoDate(raw.trim()), asOfDate: null };
}

function numberOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // parseCurrencyAmt returns 0 for empty/garbage; explicitly check first so
  // we don't conflate "no value" with "$0".
  return parseCurrencyAmt(trimmed);
}

export function parseSchwabActivityCsv(csvText: string): { rows: SchwabRow[]; unknownActions: string[] } {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], unknownActions: [] };

  const headers = splitCsvRow(lines[0]).map((h) => h.replace(/^"|"$/g, "").trim());
  const idx = (name: string) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iDate    = idx("Date");
  const iAction  = idx("Action");
  const iSymbol  = idx("Symbol");
  const iDesc    = idx("Description");
  const iQty     = idx("Quantity");
  const iPrice   = idx("Price");
  const iFees    = idx("Fees & Comm");
  const iAmount  = idx("Amount");

  const rows: SchwabRow[] = [];
  const unknown = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvRow(lines[i]).map((c) => c.replace(/^"|"$/g, ""));
    if (cells.length === 0 || !cells[iDate]) continue;
    const { date, asOfDate } = parseSchwabDate(cells[iDate]);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const rawAction = (cells[iAction] ?? "").trim();
    const action    = ACTION_MAP[rawAction.toLowerCase()] ?? "UNKNOWN";
    if (action === "UNKNOWN" && rawAction) unknown.add(rawAction);
    const symbol      = (cells[iSymbol] ?? "").trim().toUpperCase();
    const description = (cells[iDesc] ?? "").trim();
    const quantity    = numberOrNull(cells[iQty] ?? "");
    const price       = numberOrNull(cells[iPrice] ?? "");
    const fees        = numberOrNull(cells[iFees] ?? "");
    const amount      = numberOrNull(cells[iAmount] ?? "");
    // Hash on enough fields to dedup Schwab's own quirks: same date + action
    // + symbol can repeat across multiple lots, so include amount + qty.
    const hashSeed = `${date}|${action}|${symbol}|${quantity ?? ""}|${amount ?? ""}|${description}`;
    rows.push({
      date, asOfDate, action, rawAction, symbol, description,
      quantity, price, fees, amount,
      hash: importHash(date, amount ?? 0, hashSeed),
    });
  }

  return { rows, unknownActions: Array.from(unknown) };
}
