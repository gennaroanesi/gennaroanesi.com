/**
 * simplefin.ts — thin SimpleFIN Bridge client (TS port of scripts/_simplefin.mjs).
 *
 * The access URL is a long-lived credentialed URL of the form
 *   https://<user>:<pass>@bridge.simplefin.org/simplefin
 * Treat it as a secret. GET <accessUrl>/accounts returns every account with
 * balances + transactions (+ holdings for brokerage) in the requested window.
 *
 * Docs: https://beta-bridge.simplefin.org/info/developers
 */

export type SfTransaction = {
  id: string;
  posted: string;              // YYYY-MM-DD (UTC) — effective/posted date
  transactedAt: string | null;
  amount: number;              // signed; positive = credit
  description: string;
  payee: string;
  memo: string;
  pending: boolean;
};

export type SfHolding = {
  id: string;
  symbol: string;
  description: string;
  shares: number | null;
  marketValue: number | null;
  purchasePrice: number | null;
  costBasis: number | null;
  currency: string;
  createdAt: string | null;
};

export type SfAccount = {
  id: string;
  orgName: string;
  name: string;
  currency: string;
  balance: number;
  availableBalance: number | null;
  balanceDate: string;         // YYYY-MM-DD (UTC)
  transactions: SfTransaction[];
  holdings: SfHolding[];
};

/**
 * Fetch accounts (with transactions + holdings) for a time window.
 */
export async function fetchAccounts(
  accessUrl: string,
  opts: {
    start?: string | Date;
    end?: string | Date;
    pending?: boolean;
    accountIds?: string[];
  } = {},
): Promise<{ errors: string[]; accounts: SfAccount[] }> {
  // Node's undici fetch refuses URLs with inline user:password — split the
  // credentials out into an Authorization: Basic header instead.
  const { url: cleanBase, auth } = splitCredentials(accessUrl);
  const url = new URL(`${cleanBase.replace(/\/$/, "")}/accounts`);
  if (opts.start) url.searchParams.set("start-date", String(toUnixSeconds(opts.start)));
  if (opts.end) url.searchParams.set("end-date", String(toUnixSeconds(opts.end)));
  if (opts.pending !== false) url.searchParams.set("pending", "1");
  if (opts.accountIds?.length) {
    for (const id of opts.accountIds) url.searchParams.append("account", id);
  }

  const headers: Record<string, string> = auth ? { Authorization: `Basic ${auth}` } : {};
  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) {
    throw new Error(`SimpleFIN /accounts failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body: any = await res.json();
  return {
    errors: body.errors ?? [],
    accounts: (body.accounts ?? []).map(normalizeAccount),
  };
}

function splitCredentials(fullUrl: string): { url: string; auth: string | null } {
  const u = new URL(fullUrl);
  const user = u.username;
  const pass = u.password;
  u.username = "";
  u.password = "";
  const auth =
    user || pass
      ? Buffer.from(`${decodeURIComponent(user)}:${decodeURIComponent(pass)}`, "utf8").toString("base64")
      : null;
  return { url: u.toString(), auth };
}

function toUnixSeconds(v: string | Date): number {
  const d = v instanceof Date ? v : new Date(`${v}T00:00:00Z`);
  if (isNaN(d.getTime())) throw new Error(`Bad date: ${String(v)}`);
  return Math.floor(d.getTime() / 1000);
}

function pickNum(obj: any, ...keys: string[]): number | null {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== "") return parseFloat(obj[k]);
  }
  return null;
}

function normalizeAccount(a: any): SfAccount {
  const txs: SfTransaction[] = (a.transactions ?? []).map((t: any) => ({
    id: t.id,
    posted: unixToIsoDate(t.posted),
    transactedAt: t.transacted_at ? unixToIsoDate(t.transacted_at) : null,
    amount: parseFloat(t.amount ?? "0"),
    description: (t.description ?? "").trim(),
    payee: (t.payee ?? "").trim(),
    memo: (t.memo ?? "").trim(),
    pending: !!t.pending,
  }));
  txs.sort((x, y) => (y.posted ?? "").localeCompare(x.posted ?? ""));

  // SimpleFIN sends holding money fields with UNDERSCORES (market_value,
  // cost_basis, purchase_price); account-level fields use hyphens. Read
  // underscore first, fall back to hyphen.
  const holdings: SfHolding[] = (a.holdings ?? []).map((h: any) => ({
    id: h.id ?? "",
    symbol: (h.symbol ?? "").trim(),
    description: (h.description ?? "").trim(),
    shares: h.shares != null ? parseFloat(h.shares) : null,
    marketValue: pickNum(h, "market_value", "market-value"),
    purchasePrice: pickNum(h, "purchase_price", "purchase-price"),
    costBasis: pickNum(h, "cost_basis", "cost-basis"),
    currency: h.currency ?? a.currency ?? "USD",
    createdAt: h.created ? unixToIsoDate(h.created) : null,
  }));

  return {
    id: a.id,
    orgName: a["org"]?.name ?? a.org_name ?? "",
    name: a.name ?? "",
    currency: a.currency ?? "USD",
    balance: parseFloat(a.balance ?? "0"),
    availableBalance: a["available-balance"] != null ? parseFloat(a["available-balance"]) : null,
    balanceDate: a["balance-date"] ? unixToIsoDate(a["balance-date"]) : "",
    transactions: txs,
    holdings,
  };
}

function unixToIsoDate(unixSec: string | number): string {
  return new Date(Number(unixSec) * 1000).toISOString().slice(0, 10);
}

/** Mask an access URL for logging: replaces user:pass with u***:***. */
export function maskAccessUrl(accessUrl: string): string {
  try {
    const u = new URL(accessUrl);
    if (u.username || u.password) {
      u.username = u.username ? u.username[0] + "***" : "";
      u.password = u.password ? "***" : "";
    }
    return u.toString();
  } catch {
    return "(unparseable)";
  }
}
