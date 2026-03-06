/**
 * pages/api/anthropic.ts
 *
 * Server-side proxy for Anthropic API calls.
 * Keeps ANTHROPIC_API_KEY off the client entirely.
 *
 * POST /api/anthropic
 * Body: { system, messages, model?, max_tokens? }
 * Response: raw Anthropic /v1/messages response
 */

import type { NextApiRequest, NextApiResponse } from "next";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_MAX_TOKENS = 8096;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const { system, messages, model, max_tokens } = req.body ?? {};

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array is required" });
  }

  try {
    const upstream = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model ?? DEFAULT_MODEL,
        max_tokens: max_tokens ?? DEFAULT_MAX_TOKENS,
        ...(system ? { system } : {}),
        messages,
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return res.status(upstream.status).json(data);
    }

    return res.status(200).json(data);
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Upstream request failed" });
  }
}
