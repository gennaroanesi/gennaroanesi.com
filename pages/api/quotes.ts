/**
 * pages/api/quotes.ts
 *
 * Server-side proxy for Yahoo Finance quotes via the `yahoo-finance2` package.
 * Fetches current prices for an array of tickers in a single batched call.
 *
 * POST /api/quotes
 * Body: { tickers: string[] }
 * Response: { quotes: { [ticker: string]: { price: number | null; currency: string | null; error?: string } } }
 *
 * Yahoo's data is unofficial and occasionally rate-limits; we request a single
 * quote batch per call and degrade gracefully when individual tickers fail.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance();

type QuoteResult = {
  price: number | null;
  currency: string | null;
  error?: string;
};

type Response = {
  quotes: Record<string, QuoteResult>;
  error?: string;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<Response>) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ quotes: {}, error: "Method not allowed" });
  }

  const { tickers } = (req.body ?? {}) as { tickers?: unknown };

  if (!Array.isArray(tickers) || tickers.length === 0) {
    return res.status(400).json({ quotes: {}, error: "tickers (non-empty array) is required" });
  }

  // Normalize + dedupe + basic sanity (tickers are usually 1-10 chars, uppercase, no spaces)
  const clean = Array.from(
    new Set(
      tickers
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim().toUpperCase())
        .filter((t) => t.length > 0 && t.length <= 15 && /^[A-Z0-9.\-^=]+$/.test(t)),
    ),
  );

  if (clean.length === 0) {
    return res.status(400).json({ quotes: {}, error: "no valid tickers after normalization" });
  }

  const quotes: Record<string, QuoteResult> = {};

  try {
    // yahoo-finance2 accepts an array and returns one object per symbol
    const results = await yahooFinance.quote(clean);
    const arr = Array.isArray(results) ? results : [results];

    for (const q of arr) {
      const sym = (q?.symbol ?? "").toUpperCase();
      if (!sym) continue;
      quotes[sym] = {
        price:
          q.regularMarketPrice ??
          q.postMarketPrice ??
          q.preMarketPrice ??
          null,
        currency: q.currency ?? null,
      };
    }
  } catch (err: any) {
    // Batch call failed — try per-ticker so one bad symbol doesn't break everything
    for (const ticker of clean) {
      try {
        const q = await yahooFinance.quote(ticker);
        quotes[ticker] = {
          price:
            (q as any)?.regularMarketPrice ??
            (q as any)?.postMarketPrice ??
            (q as any)?.preMarketPrice ??
            null,
          currency: (q as any)?.currency ?? null,
        };
      } catch (e: any) {
        quotes[ticker] = { price: null, currency: null, error: e?.message ?? "fetch failed" };
      }
    }
  }

  // Ensure every requested ticker has an entry (even if unresolved)
  for (const t of clean) {
    if (!(t in quotes)) {
      quotes[t] = { price: null, currency: null, error: "not found" };
    }
  }

  return res.status(200).json({ quotes });
}
