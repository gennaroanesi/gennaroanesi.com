/**
 * _simplefin.mjs — thin SimpleFIN Bridge client.
 *
 * Concepts:
 *   - Setup token: one-time base64-encoded URL received when a user creates
 *     a SimpleFIN Bridge connection. POST once to exchange it for the
 *     access URL. The token is single-use.
 *   - Access URL: long-lived credentialed URL of the form
 *       https://<username>:<password>@bridge.simplefin.org/simplefin
 *     Stored in .env.local as SIMPLEFIN_ACCESS_URL. Treat as a secret —
 *     anyone with it can read transactions until you claim a new token.
 *   - Accounts endpoint: GET <accessUrl>/accounts returns every bank/card
 *     account exposed by the bridge, with balances + transactions in the
 *     requested date window. Amounts are decimal strings.
 *
 * Docs: https://beta-bridge.simplefin.org/info/developers
 */

/**
 * Exchange a one-time setup token for a persistent access URL.
 * @param {string} setupToken  Base64-encoded URL from the SimpleFIN Bridge UI.
 * @returns {Promise<string>}  The credentialed access URL. Save this.
 */
export async function claimAccessUrl(setupToken) {
  const decoded = Buffer.from(setupToken.trim(), "base64").toString("utf8").trim();
  if (!/^https?:\/\//.test(decoded)) {
    throw new Error(`Setup token did not decode to a URL (got: "${decoded.slice(0, 60)}…"). Verify you copied the whole token.`);
  }
  const res = await fetch(decoded, { method: "POST", headers: { "Content-Length": "0" } });
  if (!res.ok) {
    throw new Error(`Setup-token exchange failed: HTTP ${res.status} ${await res.text()}`);
  }
  const accessUrl = (await res.text()).trim();
  if (!accessUrl.startsWith("http")) {
    throw new Error(`Setup-token exchange returned unexpected body: ${accessUrl.slice(0, 200)}`);
  }
  return accessUrl;
}

/**
 * Fetch accounts (and their transactions) for a given time window.
 * @param {string} accessUrl  Credentialed access URL from claimAccessUrl().
 * @param {object} [opts]
 * @param {string|Date} [opts.start]   Inclusive lower bound. ISO date or Date.
 * @param {string|Date} [opts.end]     Exclusive upper bound. ISO date or Date.
 * @param {boolean}     [opts.pending] Include pending txs (default true).
 * @param {string[]}    [opts.accountIds] Restrict to these SimpleFIN account ids.
 * @returns {Promise<{ errors: string[], accounts: SfAccount[] }>}
 */
export async function fetchAccounts(accessUrl, opts = {}) {
  // Node's undici-based fetch refuses URLs with inline user:password.
  // Split the credentials out and pass them via Authorization: Basic instead.
  const { url: cleanBase, auth } = splitCredentials(accessUrl);
  const url = new URL(`${cleanBase.replace(/\/$/, "")}/accounts`);
  if (opts.start) url.searchParams.set("start-date", String(toUnixSeconds(opts.start)));
  if (opts.end)   url.searchParams.set("end-date",   String(toUnixSeconds(opts.end)));
  if (opts.pending !== false) url.searchParams.set("pending", "1");
  if (opts.accountIds?.length) {
    for (const id of opts.accountIds) url.searchParams.append("account", id);
  }

  const headers = auth ? { Authorization: `Basic ${auth}` } : {};
  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) {
    throw new Error(`SimpleFIN /accounts failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return {
    errors:   body.errors ?? [],
    accounts: (body.accounts ?? []).map(normalizeAccount),
  };
}

/**
 * Strip user:password out of a URL, returning the credential-less URL plus
 * a base64-encoded `user:password` string suitable for Basic auth.
 */
function splitCredentials(fullUrl) {
  const u = new URL(fullUrl);
  const user = u.username;
  const pass = u.password;
  u.username = "";
  u.password = "";
  const auth = user || pass
    ? Buffer.from(`${decodeURIComponent(user)}:${decodeURIComponent(pass)}`, "utf8").toString("base64")
    : null;
  return { url: u.toString(), auth };
}

/** Convert an ISO date string or Date to unix seconds. */
function toUnixSeconds(v) {
  const d = v instanceof Date ? v : new Date(`${v}T00:00:00Z`);
  if (isNaN(d.getTime())) throw new Error(`Bad date: ${v}`);
  return Math.floor(d.getTime() / 1000);
}

/**
 * Normalize the raw SimpleFIN account payload:
 *   - amounts + balances parsed to numbers
 *   - timestamps parsed to Date + ISO date
 *   - transactions sorted newest-first
 * @typedef {{
 *   id: string,
 *   orgName: string,
 *   name: string,
 *   currency: string,
 *   balance: number,
 *   availableBalance: number|null,
 *   balanceDate: string,   // YYYY-MM-DD in UTC
 *   transactions: SfTransaction[]
 * }} SfAccount
 * @typedef {{
 *   id: string,
 *   posted: string,        // YYYY-MM-DD in UTC (the effective/posted date)
 *   transactedAt: string|null,
 *   amount: number,        // signed decimal (positive = credit)
 *   description: string,
 *   payee: string,
 *   memo: string,
 *   pending: boolean
 * }} SfTransaction
 */
function normalizeAccount(a) {
  const txs = (a.transactions ?? []).map((t) => ({
    id:           t.id,
    posted:       unixToIsoDate(t.posted),
    transactedAt: t.transacted_at ? unixToIsoDate(t.transacted_at) : null,
    amount:       parseFloat(t.amount ?? "0"),
    description:  (t.description ?? "").trim(),
    payee:        (t.payee ?? "").trim(),
    memo:         (t.memo ?? "").trim(),
    pending:      !!t.pending,
  }));
  txs.sort((x, y) => (y.posted ?? "").localeCompare(x.posted ?? ""));

  // Holdings — brokerage/retirement accounts sometimes carry a per-position
  // array. Fields vary by institution; keep the shape close to what SF sends
  // so downstream code can decide what to do with each.
  const holdings = (a.holdings ?? []).map((h) => ({
    id:            h.id ?? "",
    symbol:        (h.symbol ?? "").trim(),
    description:   (h.description ?? "").trim(),
    shares:        h.shares != null ? parseFloat(h.shares) : null,
    marketValue:   h["market-value"] != null ? parseFloat(h["market-value"]) : null,
    purchasePrice: h["purchase-price"] != null ? parseFloat(h["purchase-price"]) : null,
    costBasis:     h["cost-basis"] != null ? parseFloat(h["cost-basis"]) : null,
    currency:      h.currency ?? a.currency ?? "USD",
    createdAt:     h.created ? unixToIsoDate(h.created) : null,
  }));

  return {
    id:               a.id,
    orgName:          a["org"]?.name ?? a.org_name ?? "",
    name:             a.name ?? "",
    currency:         a.currency ?? "USD",
    balance:          parseFloat(a.balance ?? "0"),
    availableBalance: a["available-balance"] != null ? parseFloat(a["available-balance"]) : null,
    balanceDate:      a["balance-date"] ? unixToIsoDate(a["balance-date"]) : "",
    transactions:     txs,
    holdings,
  };
}

function unixToIsoDate(unixSec) {
  return new Date(Number(unixSec) * 1000).toISOString().slice(0, 10);
}

/**
 * Mask an access URL for logging: replaces user:pass with u***:p***.
 */
export function maskAccessUrl(accessUrl) {
  try {
    const u = new URL(accessUrl);
    if (u.username || u.password) {
      const user = u.username ? u.username[0] + "***" : "";
      const pass = u.password ? "***" : "";
      u.username = user;
      u.password = pass;
    }
    return u.toString();
  } catch { return "(unparseable)"; }
}
