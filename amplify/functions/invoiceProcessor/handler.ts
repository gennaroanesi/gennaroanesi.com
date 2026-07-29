/**
 * invoiceProcessor/handler.ts
 *
 * Triggered by S3 PutObject when SES drops a raw inbound email into
 * s3://gennaroanesi.com/private/invoice-inbound/ (invoices@gennaroanesi.com —
 * see scripts/setup-ses-inbound.sh).
 *
 * Pipeline per email:
 *   1. Fetch raw email from S3; parse MIME (mailparser). Gmail
 *      "forward as attachment" nests the real email as message/rfc822 —
 *      recurse into it.
 *   2. PDF attachments are the invoice facsimiles, stored verbatim (one
 *      financeInvoice per PDF). No PDFs → render the email body itself to
 *      PDF with puppeteer-core + @sparticuz/chromium (one invoice).
 *   3. Store private/invoices/{invoiceId}/invoice.pdf + original.eml,
 *      sha256 the PDF and skip duplicates (same contentHash already
 *      ingested — re-forwarded email).
 *   4. Claude extracts { vendor, invoiceNumber, dates, amounts, items }.
 *   5. Create the financeInvoice row (PARSED when a total was read,
 *      NEEDS_REVIEW otherwise, ERROR when extraction itself failed).
 *   6. Auto-match: exactly one POSTED-ish financeTransaction in
 *      [issueDate−2d, issueDate+10d] whose |amount| is within $0.01 of the
 *      total → create a financeInvoiceLink. Zero or many → leave unlinked
 *      (the review UI will offer candidates).
 *
 * One bad email never poisons the batch — every record is processed inside
 * its own try/catch with contextual console.error.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { simpleParser, type ParsedMail } from "mailparser";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import Anthropic from "@anthropic-ai/sdk";
import { createHash, randomUUID } from "node:crypto";
import type { S3Event } from "aws-lambda";

import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/invoiceProcessor";
import type { Schema } from "../../data/resource";

const s3 = new S3Client({ region: "us-east-1" });

const MODEL_ID   = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.warn("[invoiceProcessor] ANTHROPIC_API_KEY missing — extraction will fail.");
}
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Data client (mirrors financeReconcile) ──────────────────────────────────

type DataClient = ReturnType<typeof generateClient<Schema>>;
let _client: DataClient | null = null;

async function getClient(): Promise<DataClient> {
  if (_client) return _client;
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  _client = generateClient<Schema>();
  return _client;
}

type TransactionRecord = Schema["financeTransaction"]["type"];
type InvoiceRecord     = Schema["financeInvoice"]["type"];

async function listAll<T>(
  model: { list: (args?: any) => Promise<{ data: T[]; nextToken?: string | null }> },
  filter?: any,
  cap = 50_000,
): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | null | undefined;
  do {
    const args: any = { limit: 1000, nextToken };
    if (filter) args.filter = filter;
    const { data, nextToken: nt } = await model.list(args);
    out.push(...(data ?? []));
    nextToken = nt ?? null;
  } while (nextToken && out.length < cap);
  return out.slice(0, cap);
}

// ── S3 helpers ──────────────────────────────────────────────────────────────

async function readObject(bucket: string, key: string): Promise<Buffer> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!out.Body) throw new Error(`S3 object has no body: ${key}`);
  // transformToByteArray sidesteps the stream-chunk Buffer.concat dance (and
  // the @types/node 20.5 vs TS 5.8 Buffer-generics clash that plagues
  // parsePaycheckPdf's hand-rolled version).
  const bytes = await out.Body.transformToByteArray();
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

// ── Email parsing ───────────────────────────────────────────────────────────

/**
 * Parse the raw email into one or more invoice SOURCES. Gmail's "forward as
 * attachment" nests originals as message/rfc822 — and multi-selecting emails
 * attaches SEVERAL of them to one wrapper. Every nested email is its own
 * source (recursively, depth-capped); the wrapper itself only counts as a
 * source when it carries its own direct PDF attachments (mixed forwards).
 * A plain email with no nested messages is simply its own single source.
 */
async function collectEmailSources(raw: Buffer): Promise<ParsedMail[]> {
  const sources: ParsedMail[] = [];
  async function walk(mail: ParsedMail, depth: number): Promise<void> {
    const nested = (mail.attachments ?? []).filter(
      (a) => (a.contentType ?? "").toLowerCase() === "message/rfc822",
    );
    if (nested.length === 0 || depth >= 3) {
      sources.push(mail);
      return;
    }
    if ((mail.attachments ?? []).some(isPdfAttachment)) sources.push(mail);
    for (const n of nested) {
      await walk(await simpleParser(n.content), depth + 1);
    }
  }
  await walk(await simpleParser(raw), 0);
  return sources;
}

function isPdfAttachment(a: { contentType?: string; filename?: string }): boolean {
  if ((a.contentType ?? "").toLowerCase() === "application/pdf") return true;
  return (a.filename ?? "").toLowerCase().endsWith(".pdf");
}

// ── HTML → PDF (no-attachment fallback) ─────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function renderBodyToPdf(mail: ParsedMail): Promise<Buffer> {
  const html =
    typeof mail.html === "string" && mail.html.trim()
      ? mail.html
      : `<html><body><pre style="font-family: monospace; white-space: pre-wrap;">${escapeHtml(mail.text ?? "")}</pre></body></html>`;

  // @sparticuz/chromium v149 dropped the old defaultViewport/headless
  // exports — args + executablePath are the whole contract now, and
  // puppeteer-core's default headless mode is correct for Lambda.
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
  });
  try {
    const page = await browser.newPage();
    // networkidle0 would hang on dead tracking pixels; domcontentloaded +
    // a short settle is enough for a static facsimile.
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const pdf = await page.pdf({ format: "letter", printBackground: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// ── Claude extraction ───────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are extracting structured data from an invoice (or receipt/bill) PDF. Read the document carefully and return ONLY a JSON object — no commentary, no markdown fences, no explanation.

Schema (monetary fields are plain numbers in the invoice's currency, no symbols, no thousands separators; null when not present — never guess):

{
  "vendor":        string | null,   // issuing company/person, as printed
  "invoiceNumber": string | null,   // invoice/receipt/order number
  "issueDate":     "YYYY-MM-DD" | null,
  "dueDate":       "YYYY-MM-DD" | null,
  "currency":      string | null,   // ISO 4217 code, e.g. "USD", "BRL"
  "subtotal":      number | null,   // pre-tax total
  "tax":           number | null,   // total tax
  "total":         number | null,   // grand total actually owed/paid
  "items": [
    { "description": string, "qty": number | null, "unitPrice": number | null, "amount": number | null }
  ]
}

Field guidance:
- "total" is the headline amount due (or paid). If the document shows both an amount due and an amount paid, prefer the grand total of this invoice.
- "issueDate" is the invoice/receipt date; "dueDate" only when explicitly stated.
- "items" is the line-item table when one exists; [] when the document has no itemization.
- Dates must be converted to YYYY-MM-DD regardless of the printed format.

If you can't read the document or it isn't an invoice/receipt/bill, return {"error": "<short reason>"} and nothing else.

Return ONLY the JSON object.`;

// Pull the JSON object out of Claude's response. The prompt asks for raw JSON
// only, but models occasionally still wrap in ```json fences — strip those
// defensively so a small formatting slip doesn't fail the whole flow.
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenceMatch ? fenceMatch[1].trim() : trimmed;
  return JSON.parse(body);
}

type Extraction = {
  vendor:        string | null;
  invoiceNumber: string | null;
  issueDate:     string | null;
  dueDate:       string | null;
  currency:      string | null;
  subtotal:      number | null;
  tax:           number | null;
  total:         number | null;
  items:         unknown[];
};

async function extractInvoiceFields(pdf: Buffer): Promise<{ fields: Extraction | null; error: string | null }> {
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
              data:       pdf.toString("base64"),
            },
          },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      }],
    });
  } catch (err) {
    return { fields: null, error: `Claude call failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const textBlock = resp.content.find((b: any) => b.type === "text") as any;
  if (!textBlock) return { fields: null, error: "No text in Claude response" };

  let parsed: any;
  try {
    parsed = extractJson(textBlock.text);
  } catch (err) {
    return { fields: null, error: `Could not parse Claude JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Honor the model's own error-channel.
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    return { fields: null, error: String(parsed.error) };
  }

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const isoDate = (v: unknown) =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

  return {
    fields: {
      vendor:        str(parsed?.vendor),
      invoiceNumber: str(parsed?.invoiceNumber),
      issueDate:     isoDate(parsed?.issueDate),
      dueDate:       isoDate(parsed?.dueDate),
      currency:      str(parsed?.currency),
      subtotal:      num(parsed?.subtotal),
      tax:           num(parsed?.tax),
      total:         num(parsed?.total),
      items:         Array.isArray(parsed?.items) ? parsed.items : [],
    },
    error: null,
  };
}

// ── Auto-match ──────────────────────────────────────────────────────────────

function addDaysIso(isoDate: string, n: number): string {
  const d = new Date(isoDate + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Exactly-one match rule: one financeTransaction dated within
 * [issueDate−2d, issueDate+10d] whose |amount| is within $0.01 of |total|
 * (the ledger stores expenses negative; an invoice can also match a
 * refund/income row, hence the absolute compare). Ambiguity (0 or ≥2 hits)
 * creates no link — the review UI decides.
 */
async function autoMatchTransaction(
  client: DataClient,
  invoiceId: string,
  issueDate: string,
  total: number,
): Promise<string | null> {
  const from = addDaysIso(issueDate, -2);
  const to   = addDaysIso(issueDate, 10);
  const txs = await listAll<TransactionRecord>(
    client.models.financeTransaction,
    { date: { between: [from, to] } },
  );
  const hits = txs.filter(
    (t) => Math.abs(Math.abs(t.amount ?? 0) - Math.abs(total)) <= 0.01,
  );
  if (hits.length !== 1) {
    console.log(`[invoiceProcessor] auto-match: ${hits.length} candidates for invoice ${invoiceId} — no link created`);
    return null;
  }
  const tx = hits[0];
  const { errors } = await client.models.financeInvoiceLink.create({
    invoiceId,
    transactionId: tx.id,
    amount: total,
  });
  if (errors?.length) throw new Error(`financeInvoiceLink create failed: ${errors[0].message}`);
  console.log(`[invoiceProcessor] auto-matched invoice ${invoiceId} → tx ${tx.id} (${tx.date} ${tx.amount})`);
  return tx.id;
}

// ── Per-email pipeline ──────────────────────────────────────────────────────

async function processEmail(bucket: string, key: string): Promise<void> {
  const raw = await readObject(bucket, key);
  const sources = await collectEmailSources(raw);
  if (sources.length > 1) {
    console.log(`[invoiceProcessor] multi-email forward: ${sources.length} nested source(s)`);
  }
  const client = await getClient();

  for (const mail of sources) {
    await processSource(client, bucket, raw, mail);
  }
}

/** One email source → N invoices (one per PDF, or one body render). */
async function processSource(
  client: DataClient,
  bucket: string,
  raw: Buffer,
  mail: ParsedMail,
): Promise<void> {
  const emailFrom    = mail.from?.value?.[0]?.address ?? mail.from?.text ?? null;
  const emailSubject = mail.subject ?? null;
  const receivedAt   = (mail.date ?? new Date()).toISOString();

  // PDF attachments are facsimiles as-is; otherwise render the body itself.
  const pdfAttachments = (mail.attachments ?? []).filter(isPdfAttachment);
  const pdfs: Buffer[] = pdfAttachments.length > 0
    ? pdfAttachments.map((a) => a.content) // mailparser already hands us a Buffer
    : [await renderBodyToPdf(mail)];

  for (const pdf of pdfs) {
    // Cast dodges the @types/node 20.5 Buffer/Uint8Array generics clash; the
    // runtime value is a plain Buffer either way.
    const contentHash = createHash("sha256").update(pdf as unknown as Uint8Array).digest("hex");

    // Dedup: a re-forwarded email carries the same PDF bytes.
    const dupes = await listAll<InvoiceRecord>(
      client.models.financeInvoice,
      { contentHash: { eq: contentHash } },
    );
    if (dupes.length > 0) {
      console.log(`[invoiceProcessor] duplicate PDF (contentHash ${contentHash.slice(0, 12)}…) — already invoice ${dupes[0].id}; skipping`);
      continue;
    }

    // Generate the id up front so the S3 keys and the row always agree.
    const invoiceId     = randomUUID();
    const s3KeyPdf      = `private/invoices/${invoiceId}/invoice.pdf`;
    const s3KeyOriginal = `private/invoices/${invoiceId}/original.eml`;

    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: s3KeyPdf, Body: pdf, ContentType: "application/pdf",
    }));
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: s3KeyOriginal, Body: raw, ContentType: "message/rfc822",
    }));

    const { fields, error } = await extractInvoiceFields(pdf);

    const parseStatus: "PARSED" | "NEEDS_REVIEW" | "ERROR" =
      error ? "ERROR" : fields?.total != null ? "PARSED" : "NEEDS_REVIEW";
    const parseError =
      error ?? (fields?.total == null ? "total not found in document" : null);

    const { data: created, errors } = await client.models.financeInvoice.create({
      id:            invoiceId,
      vendor:        fields?.vendor ?? null,
      invoiceNumber: fields?.invoiceNumber ?? null,
      issueDate:     fields?.issueDate ?? null,
      dueDate:       fields?.dueDate ?? null,
      currency:      fields?.currency ?? "USD",
      subtotal:      fields?.subtotal ?? null,
      tax:           fields?.tax ?? null,
      total:         fields?.total ?? null,
      items:         fields && fields.items.length > 0 ? JSON.stringify(fields.items) : null,
      s3KeyPdf,
      s3KeyOriginal,
      contentHash,
      source:        "EMAIL",
      emailFrom,
      emailSubject,
      receivedAt,
      parseStatus,
      parseError,
    });
    if (errors?.length) throw new Error(`financeInvoice create failed: ${errors[0].message}`);
    console.log(`[invoiceProcessor] created invoice ${created?.id} (${parseStatus}) vendor=${fields?.vendor ?? "?"} total=${fields?.total ?? "?"}`);

    // Auto-link — best effort; a matching failure must not undo the ingest.
    if (fields?.total != null && fields.issueDate) {
      try {
        await autoMatchTransaction(client, invoiceId, fields.issueDate, fields.total);
      } catch (err) {
        console.error(`[invoiceProcessor] auto-match failed for invoice ${invoiceId}:`, err);
      }
    }
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────

export const handler = async (event: S3Event): Promise<{ ok: boolean; processed: number; failed: number }> => {
  let processed = 0;
  let failed = 0;
  for (const record of event.Records ?? []) {
    const bucket = record.s3?.bucket?.name;
    const key    = decodeURIComponent((record.s3?.object?.key ?? "").replace(/\+/g, " "));
    if (!bucket || !key) {
      console.error("[invoiceProcessor] record missing bucket/key — skipping", JSON.stringify(record).slice(0, 500));
      failed++;
      continue;
    }
    // SES drops a marker object into the prefix when a receipt rule is
    // created/verified — it's not an email and produced junk rows once.
    if (key.endsWith("AMAZON_SES_SETUP_NOTIFICATION")) {
      console.log("[invoiceProcessor] skipping SES setup-notification marker");
      continue;
    }
    try {
      await processEmail(bucket, key);
      processed++;
    } catch (err) {
      // One bad email must not poison the batch.
      console.error(`[invoiceProcessor] failed processing s3://${bucket}/${key}:`, err);
      failed++;
    }
  }
  return { ok: failed === 0, processed, failed };
};
