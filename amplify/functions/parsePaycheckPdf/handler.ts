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

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { extractPaycheckFields } from "./extract";

const BUCKET = process.env.PAYCHECK_BUCKET ?? "gennaroanesi.com";
const s3 = new S3Client({});

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
  // transformToByteArray sidesteps the @types/node 20.5 vs TS 5.8
  // Buffer-generics clash a hand-rolled stream concat trips.
  const bytes = await out.Body.transformToByteArray();
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
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

  const { draft, error } = await extractPaycheckFields(pdfBytes);
  if (error || !draft) {
    return { ok: false, draft: null, s3Key, error: error ?? "Extraction returned nothing" };
  }
  return { ok: true, draft, s3Key, error: null };
};
