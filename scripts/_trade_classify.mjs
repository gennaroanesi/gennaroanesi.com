/**
 * _trade_classify.mjs — shared security-trade classification for SimpleFIN rows.
 *
 * SimpleFIN brokerage transactions carry only a cash amount + the security NAME
 * (no ticker, shares, or price). This maps the name → ticker via
 * scripts/data/security_ticker_map.json (substring rules) so a row can be typed
 * as a cash-only BUY (amount < 0) / SELL (amount > 0). Rows whose name doesn't
 * map are left alone — never guessed — so transfers/interest aren't misread.
 *
 * Used by both simplefin_pull.mjs (going forward) and reclassify_sf_trades.mjs
 * (existing rows) so the two agree.
 */
import { readFileSync } from "fs";

/** Uppercase; collapse . , & ® ™ and runs of whitespace to single spaces. */
export function normalizeName(s) {
  return (s || "")
    .toUpperCase()
    .replace(/[.,&®™]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Load + normalize the substring→ticker rules once. */
export function loadTickerRules(path = "scripts/data/security_ticker_map.json") {
  const j = JSON.parse(readFileSync(path, "utf8"));
  return (j.rules ?? []).map((r) => ({ contains: normalizeName(r.contains), ticker: r.ticker }));
}

/**
 * Resolve a ticker from one or more candidate name strings (e.g. SF description
 * then payee). First rule that is a substring of any candidate wins.
 * Returns the ticker string, or null if nothing matches.
 */
export function resolveTicker(candidates, rules) {
  const texts = (Array.isArray(candidates) ? candidates : [candidates]).map(normalizeName).filter(Boolean);
  for (const r of rules) {
    if (texts.some((t) => t.includes(r.contains))) return r.ticker;
  }
  return null;
}

/**
 * Given a SimpleFIN-style row's raw name fields + signed amount, decide whether
 * it's a security trade and, if so, its side + ticker.
 *   { isTrade: true,  side: "BUY"|"SELL", ticker }   when a name maps
 *   { isTrade: false }                                otherwise
 * side is by cash direction: amount < 0 → BUY (cash out), amount > 0 → SELL.
 * A zero amount is not a trade.
 */
export function classifyTrade({ description, payee, amount }, rules) {
  if (!amount || amount === 0) return { isTrade: false };
  const ticker = resolveTicker([description, payee], rules);
  if (!ticker) return { isTrade: false };
  return { isTrade: true, side: amount < 0 ? "BUY" : "SELL", ticker };
}
