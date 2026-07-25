/**
 * components/finance/csv-parsers.ts
 *
 * Bank-CSV import parsing for the Finance section.
 * Split out of `_shared.tsx` (which re-exports everything here).
 * Pure module: no React, no Amplify client.
 */

/** Simple fingerprint for CSV dedup: base64(date|amount|description) */
export function importHash(date: string, amount: number, description: string): string {
  return btoa([date, amount.toFixed(2), description.trim().toLowerCase()].join("|"))
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 32);
}

// ── CSV import ────────────────────────────────────────────────────────────────

export type ParsedTransaction = {
  date:        string;   // YYYY-MM-DD
  description: string;
  amount:      number;   // positive = credit/income, negative = debit/expense
  category:    string;
  hash:        string;
};

type BankFormat = {
  name:   string;
  detect: (headers: string[]) => boolean;
  parse:  (row: Record<string, string>) => ParsedTransaction | null;
};

export function toIsoDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parts = raw.split("/");
  if (parts.length === 3) {
    const [m, d, y] = parts;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return raw;
}

export function parseCurrencyAmt(raw: string): number {
  return parseFloat(raw.replace(/[$,\s]/g, "")) || 0;
}

// Local aliases so the existing parsers below don't need rewiring.
const toIso = toIsoDate;
const parseAmt = parseCurrencyAmt;

const BANK_FORMATS: BankFormat[] = [
  {
    name:   "Chase",
    detect: (h) => h.includes("Transaction Date") && h.includes("Post Date"),
    parse:  (row) => {
      const date = toIso(row["Transaction Date"] ?? "");
      if (!date) return null;
      // Chase CSV uses the same convention for checking and credit cards:
      // negative = money leaving you (debit/purchase), positive = money coming in (deposit/payment).
      // Matches our app convention, no flip needed.
      const amount      = parseAmt(row["Amount"] ?? "0");
      const description = row["Description"]?.trim() ?? "";
      return { date, description, amount, category: row["Category"]?.trim() ?? "", hash: importHash(date, amount, description) };
    },
  },
  {
    name:   "Bank of America",
    detect: (h) => h.includes("Posted Date") && h.includes("Reference Number"),
    parse:  (row) => {
      const date = toIso(row["Posted Date"] ?? "");
      if (!date) return null;
      const amount      = parseAmt(row["Amount"] ?? "0");
      const description = row["Payee"]?.trim() ?? "";
      return { date, description, amount, category: "", hash: importHash(date, amount, description) };
    },
  },
  {
    name:   "American Express",
    detect: (h) => h.includes("Date") && h.includes("Description") && h.includes("Amount") && !h.includes("Transaction Date"),
    parse:  (row) => {
      const date = toIso(row["Date"] ?? "");
      if (!date) return null;
      // NOTE: Amex historically exports charges as positive (opposite of Chase).
      // Flipping to match our convention (negative = money leaving). If import
      // produces opposite-signed results, remove the minus here — see TODO.
      const raw         = parseAmt(row["Amount"] ?? "0");
      const amount      = -raw;
      const description = row["Description"]?.trim() ?? "";
      return { date, description, amount, category: row["Category"]?.trim() ?? "", hash: importHash(date, raw, description) };
    },
  },
  {
    // H-E-B credit card "Activity" export. Header: Date,Amount,Type,Merchant,Category,Method
    name:   "H-E-B Card",
    detect: (h) => h.includes("Merchant") && h.includes("Method") && h.includes("Type"),
    parse:  (row) => {
      // Date field is `YYYY/MM/DD, HH:MM:SS` — Y/M/D order (not toIso's M/D/Y),
      // with a time suffix. Parse it directly rather than routing through toIso.
      const [y, m, d] = ((row["Date"] ?? "").split(",")[0].trim()).split("/");
      if (!y || !m || !d) return null;
      const date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
      // H-E-B exports purchases as POSITIVE and payments/refunds/rewards as
      // NEGATIVE (opposite of our convention). Negate so money-leaving is negative.
      const raw    = parseAmt(row["Amount"] ?? "0");
      const amount = -raw;
      const description = row["Merchant"]?.trim() || (row["Type"]?.trim() ?? "");
      // The Type column is authoritative for balance-sheet rows: card payments and
      // statement-credit rewards are debt paydown, not income — bucket them as
      // "Credit Card Payment" (excluded from P&L). Everything else falls through
      // to merchant-based inference (Groceries / Shopping / Fees / …).
      const type = (row["Type"] ?? "").trim().toUpperCase();
      const category = type === "PAYMENT" || type === "REWARD" ? "Credit Card Payment" : "";
      return { date, description, amount, category, hash: importHash(date, amount, description) };
    },
  },
  {
    // Generic fallback
    name:   "Generic CSV",
    detect: (h) => h.some((c) => /date/i.test(c)) && h.some((c) => /amount/i.test(c)),
    parse:  (row) => {
      const dateKey = Object.keys(row).find((k) => /date/i.test(k)) ?? "";
      const amtKey  = Object.keys(row).find((k) => /amount/i.test(k)) ?? "";
      const descKey = Object.keys(row).find((k) => /desc|payee|memo|name/i.test(k)) ?? "";
      const date    = toIso(row[dateKey] ?? "");
      if (!date) return null;
      const amount      = parseAmt(row[amtKey] ?? "0");
      const description = row[descKey]?.trim() ?? "";
      return { date, description, amount, category: "", hash: importHash(date, amount, description) };
    },
  },
];

export function splitCsvRow(row: string): string[] {
  const fields: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '"') { if (inQ && row[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (c === "," && !inQ) { fields.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  fields.push(cur.trim());
  return fields;
}

export function parseBankCsv(csvText: string): { format: string; rows: ParsedTransaction[] } {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { format: "Unknown", rows: [] };

  const headers = splitCsvRow(lines[0]).map((h) => h.replace(/^"|"$/g, "").trim());
  const fmt     = BANK_FORMATS.find((f) => f.detect(headers)) ?? BANK_FORMATS[BANK_FORMATS.length - 1];

  const rows: ParsedTransaction[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitCsvRow(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] ?? ""; });
    const parsed = fmt.parse(row);
    if (parsed) rows.push(parsed);
  }

  return { format: fmt.name, rows };
}
