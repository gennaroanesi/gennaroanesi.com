/**
 * parsePaycheckPdf/handler.ts
 *
 * Reads a paystub PDF from S3, sends it to Claude with a strict JSON-output
 * extraction prompt, returns a draft `financePaycheck` payload the frontend
 * pre-fills for human review. NEVER persists anything — the user reviews
 * and saves via the standard typed-client mutation.
 *
 * Why an LLM instead of a hand-written parser: pay stubs vary wildly
 * across payroll providers (ADP, Workday, Paychex, Gusto, …) and even
 * across employers on the same provider. A well-prompted vision LLM
 * handles every layout uniformly; per-provider parsers would explode.
 *
 * Cost: ~5–15 K input tokens per PDF (paystub is single-page, mostly
 * text + tables) + ~500–1000 output tokens. Sonnet 4.6 ≈ $0.02–$0.05 per
 * extraction. Cheap relative to the data-entry time saved.
 */

import Anthropic from "@anthropic-ai/sdk";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const MODEL_ID  = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.warn("[parsePaycheckPdf] ANTHROPIC_API_KEY missing — calls will fail.");
}
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const BUCKET = process.env.PAYCHECK_BUCKET ?? "gennaroanesi.com";
const s3 = new S3Client({});

// ── Prompt ──────────────────────────────────────────────────────────────────
// Schema kept as a JSON object (not a TS type) so the model echoes the same
// keys back. Numeric fields are dollars, no currency symbols. Missing values
// → null, never a guess. lineItems captures the long tail (HSA, parking,
// ESPP, group-term life buyback, RSU vest, prior-period adjustments, …).

const EXTRACTION_PROMPT = `You are extracting structured data from a US pay stub PDF. Read the document carefully and return ONLY a JSON object — no commentary, no markdown fences, no explanation.

Schema (all monetary fields are USD dollars, no symbols, no commas; null when not present on the stub):

{
  "payDate":              "YYYY-MM-DD",
  "periodStart":          "YYYY-MM-DD" | null,
  "periodEnd":            "YYYY-MM-DD" | null,
  "gross":                number,
  "taxableWage":          number | null,
  "net":                  number,
  "imputedGtl":           number | null,
  "fedWh":                number | null,
  "oasdi":                number | null,
  "medicare":             number | null,
  "contrib401k":          number | null,
  "contribAfterTax401k":  number | null,
  "hsa":                  number | null,
  "fsa":                  number | null,
  "medical":              number | null,
  "dental":               number | null,
  "vision":               number | null,
  "ytdGross":             number | null,
  "ytdTaxableWage":       number | null,
  "ytdFedWh":             number | null,
  "ytdOasdi":             number | null,
  "ytdMedicare":          number | null,
  "ytd401k":              number | null,
  "ytdAfterTax401k":      number | null,
  "ytdNet":               number | null,
  "lineItems": [
    {
      "name":   string,
      "amount": number,
      "ytd":    number | null,
      "type":   "PRETAX" | "POSTTAX" | "IMPUTED" | "EMPLOYER_PAID" | "EARNING" | "OTHER"
    }
  ]
}

Field guidance:
- "gross" is the sum of all earnings before any deductions for this pay period.
- "taxableWage" is the federal taxable wage for this period (gross minus pretax deductions plus imputed income). Look for "Taxable Wages", "Federal Taxable Wages", or compute if shown line-by-line.
- "net" is the take-home / direct-deposit total for this period.
- "fedWh" is federal income tax withheld (NOT FICA).
- "oasdi" is Social Security tax (sometimes labeled "OASDI", "Social Security", or "FICA-SS").
- "medicare" includes both regular Medicare (1.45%) and any Additional Medicare (0.9%) withheld.
- "imputedGtl" is imputed group-term life income (taxed but not paid in cash). Include only if labeled.
- "contrib401k" is the EMPLOYEE pre-tax 401k contribution this period. Do NOT include employer match.
- "contribAfterTax401k" is the employee after-tax / mega-backdoor 401k contribution.
- For YTD values, use the YTD column on the stub. If the stub only shows current-period values, leave YTD nulls.
- lineItems should capture every deduction or earning row that doesn't map to one of the explicit fields above. Examples: parking, ESPP contribution, RSU vest gross-up, supplemental life insurance, dependent care FSA, commuter benefits, prior-period adjustments. Set "type" based on tax treatment:
    PRETAX        — reduces taxable wages (e.g. HSA, traditional 401k via employer plan, certain transit)
    POSTTAX       — taken from net (e.g. ESPP, post-tax life insurance, garnishments)
    IMPUTED       — non-cash benefit added to taxable wages (e.g. GTL > $50k coverage)
    EMPLOYER_PAID — reported but not deducted (e.g. employer-paid medical)
    EARNING       — non-base earnings (e.g. overtime, bonus paid this period, RSU vest amount)
    OTHER         — anything that doesn't fit cleanly

If you can't read the document or it isn't a paystub, return {"error": "<short reason>"} and nothing else.

Return ONLY the JSON object.`;

// ── Types ──────────────────────────────────────────────────────────────────

type Args = {
  s3Key: string;   // S3 key under the gennaroanesi.com bucket
  person: "ME" | "SPOUSE";
};

type Response = {
  ok:    boolean;
  draft: unknown | null;  // parsed JSON from Claude (or null on error)
  s3Key: string | null;   // echoed back so the frontend can attach it later
  error: string | null;
};

// ── Helpers ────────────────────────────────────────────────────────────────

async function readPdfFromS3(key: string): Promise<Buffer> {
  const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!out.Body) throw new Error(`S3 object has no body: ${key}`);
  // Body is a Readable in Node; concat to a single buffer.
  const chunks: Buffer[] = [];
  for await (const chunk of out.Body as NodeJS.ReadableStream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Pull the JSON object out of Claude's response. The prompt asks for raw JSON
// only, but models occasionally still wrap in ```json fences — strip those
// defensively so a small formatting slip doesn't fail the whole flow.
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenceMatch ? fenceMatch[1].trim() : trimmed;
  return JSON.parse(body);
}

// ── Handler ────────────────────────────────────────────────────────────────

export const handler = async (event: { arguments: Args }): Promise<Response> => {
  const { s3Key, person } = event.arguments;
  void person; // included so the frontend can pass it through; not used in extraction

  if (!s3Key) {
    return { ok: false, draft: null, s3Key: null, error: "s3Key is required" };
  }

  let pdfBytes: Buffer;
  try {
    pdfBytes = await readPdfFromS3(s3Key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, draft: null, s3Key, error: `S3 read failed: ${msg}` };
  }

  if (pdfBytes.byteLength === 0) {
    return { ok: false, draft: null, s3Key, error: "PDF is empty" };
  }

  let resp;
  try {
    resp = await anthropic.messages.create({
      model:      MODEL_ID,
      max_tokens: MAX_TOKENS,
      messages: [{
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type:       "base64",
              media_type: "application/pdf",
              data:       pdfBytes.toString("base64"),
            },
          },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      }],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, draft: null, s3Key, error: `Claude call failed: ${msg}` };
  }

  // Grab the first text block — for this prompt, Claude returns a single
  // text content part. Refuse silently on the unusual case where it doesn't.
  const textBlock = resp.content.find((b: any) => b.type === "text") as any;
  if (!textBlock) {
    return { ok: false, draft: null, s3Key, error: "No text in Claude response" };
  }

  let parsed: unknown;
  try {
    parsed = extractJson(textBlock.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, draft: null, s3Key, error: `Could not parse Claude JSON: ${msg}` };
  }

  // Honor the model's own error-channel: if it returned {error: "..."}, surface that.
  if (parsed && typeof parsed === "object" && "error" in (parsed as any)) {
    return { ok: false, draft: null, s3Key, error: String((parsed as any).error) };
  }

  return { ok: true, draft: parsed, s3Key, error: null };
};
