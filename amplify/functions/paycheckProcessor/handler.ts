/**
 * paycheckProcessor/handler.ts
 *
 * Triggered by S3 PutObject when SES drops a raw inbound email into
 * s3://gennaroanesi.com/private/paycheck-inbound/ (paychecks@gennaroanesi.com
 * — see scripts/setup-ses-inbound.sh).
 *
 * Pipeline per email:
 *   1. Fetch raw email from S3; parse MIME (mailparser). Collect every PDF
 *      attachment, recursing into message/rfc822 parts (Gmail "forward as
 *      attachment", including multi-select forwards).
 *   2. Per PDF: sha256 → skip if an inbox row already has that hash.
 *   3. Claude extracts the paystub fields (shared extract.ts prompt).
 *   4. Skip if a financePaycheck with the same person + payDate + net
 *      already exists (stub entered manually before being forwarded).
 *   5. Stage the PDF at attachments/PAYCHECK/staging/ (same prefix the
 *      upload flow uses) and create a financePaycheckInbox row —
 *      NEEDS_REVIEW, or ERROR when extraction failed.
 *
 * An email with no PDF at all still yields one ERROR row so the forward
 * doesn't vanish silently.
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { simpleParser, type ParsedMail, type Attachment } from "mailparser";
import { createHash, randomUUID } from "node:crypto";
import type { S3Event } from "aws-lambda";

import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/paycheckProcessor";
import type { Schema } from "../../data/resource";
import { extractPaycheckFields } from "../parsePaycheckPdf/extract";

const s3 = new S3Client({ region: "us-east-1" });

// ── Data client (mirrors invoiceProcessor) ──────────────────────────────────

type DataClient = ReturnType<typeof generateClient<Schema>>;
let _client: DataClient | null = null;

async function getClient(): Promise<DataClient> {
  if (_client) return _client;
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  _client = generateClient<Schema>();
  return _client;
}

async function listAll<T>(
  model: { list: (args?: any) => Promise<{ data: T[]; nextToken?: string | null }> },
  filter?: any,
): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | null | undefined;
  do {
    const args: any = { limit: 1000, nextToken };
    if (filter) args.filter = filter;
    const { data, nextToken: nt } = await model.list(args);
    out.push(...(data ?? []));
    nextToken = nt ?? null;
  } while (nextToken);
  return out;
}

// ── S3 ──────────────────────────────────────────────────────────────────────

async function readObject(bucket: string, key: string): Promise<Buffer> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!out.Body) throw new Error(`S3 object has no body: ${key}`);
  const bytes = await out.Body.transformToByteArray();
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

// ── Email parsing ───────────────────────────────────────────────────────────

function isPdfAttachment(a: { contentType?: string; filename?: string }): boolean {
  if ((a.contentType ?? "").toLowerCase() === "application/pdf") return true;
  return (a.filename ?? "").toLowerCase().endsWith(".pdf");
}

/** Every PDF in the email, including inside nested forwarded messages. */
async function collectPdfs(raw: Buffer): Promise<Attachment[]> {
  const pdfs: Attachment[] = [];
  async function walk(mail: ParsedMail, depth: number): Promise<void> {
    for (const a of mail.attachments ?? []) {
      if (isPdfAttachment(a)) pdfs.push(a);
      else if ((a.contentType ?? "").toLowerCase() === "message/rfc822" && depth < 3) {
        await walk(await simpleParser(a.content), depth + 1);
      }
    }
  }
  await walk(await simpleParser(raw), 0);
  return pdfs;
}

// ── Per-email pipeline ──────────────────────────────────────────────────────

type InboxRecord    = Schema["financePaycheckInbox"]["type"];
type PaycheckRecord = Schema["financePaycheck"]["type"];

async function processEmail(bucket: string, key: string): Promise<void> {
  const raw  = await readObject(bucket, key);
  const mail = await simpleParser(raw);
  const client = await getClient();

  const meta = {
    s3KeyOriginal: key,
    emailFrom:     mail.from?.value?.[0]?.address ?? mail.from?.text ?? null,
    emailSubject:  mail.subject ?? null,
    receivedAt:    (mail.date ?? new Date()).toISOString(),
  };

  const pdfs = await collectPdfs(raw);
  if (pdfs.length === 0) {
    const { errors } = await client.models.financePaycheckInbox.create({
      ...meta,
      status:     "ERROR",
      parseError: "No PDF attachment found — forward the paystub PDF itself.",
    });
    if (errors?.length) throw new Error(`financePaycheckInbox create failed: ${errors[0].message}`);
    console.log(`[paycheckProcessor] no PDF in "${meta.emailSubject ?? "(no subject)"}" — ERROR row created`);
    return;
  }

  // Per-PDF isolation: a throw out of the handler makes S3's async invoke
  // retry the whole object (the invoiceProcessor 2026-07-29 lesson).
  for (const pdf of pdfs) {
    try {
      await processPdf(client, bucket, pdf, meta);
    } catch (err) {
      console.error(`[paycheckProcessor] PDF "${pdf.filename ?? "?"}" failed — continuing:`, err);
    }
  }
}

async function processPdf(
  client: DataClient,
  bucket: string,
  pdf: Attachment,
  meta: { s3KeyOriginal: string; emailFrom: string | null; emailSubject: string | null; receivedAt: string },
): Promise<void> {
  const bytes = pdf.content;
  // Cast dodges the @types/node Buffer/Uint8Array generics clash.
  const contentHash = createHash("sha256").update(bytes as unknown as Uint8Array).digest("hex");

  const dupes = await listAll<InboxRecord>(
    client.models.financePaycheckInbox,
    { contentHash: { eq: contentHash } },
  );
  if (dupes.length > 0) {
    console.log(`[paycheckProcessor] duplicate PDF (contentHash ${contentHash.slice(0, 12)}…) — already inbox ${dupes[0].id}; skipping`);
    return;
  }

  const { draft, error } = await extractPaycheckFields(bytes);

  // Already entered (manual upload before the forward)? Same person + pay
  // date + net is the same stub.
  const person  = draft?.person;
  const payDate = draft?.payDate;
  const net     = draft?.net;
  if ((person === "ME" || person === "SPOUSE") && typeof payDate === "string" && typeof net === "number") {
    const existing = await listAll<PaycheckRecord>(
      client.models.financePaycheck,
      { person: { eq: person }, payDate: { eq: payDate }, net: { eq: net } },
    );
    if (existing.length > 0) {
      console.log(`[paycheckProcessor] paycheck ${person} ${payDate} net=${net} already exists (${existing[0].id}); skipping`);
      return;
    }
  }

  const inboxId  = randomUUID();
  const filename = pdf.filename || "paystub.pdf";
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  const s3KeyPdf = `attachments/PAYCHECK/staging/${inboxId}-${safeName}`;

  // Written after the dedup gates so a skipped duplicate never orphans objects.
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: s3KeyPdf, Body: bytes, ContentType: "application/pdf",
  }));

  const { errors } = await client.models.financePaycheckInbox.create({
    id:          inboxId,
    ...meta,
    // AWSJSON wants a serialized string.
    draft:       draft ? JSON.stringify(draft) : null,
    s3KeyPdf,
    filename,
    sizeBytes:   bytes.byteLength,
    contentHash,
    status:      error ? "ERROR" : "NEEDS_REVIEW",
    parseError:  error,
  });
  if (errors?.length) throw new Error(`financePaycheckInbox create failed: ${errors[0].message}`);
  console.log(`[paycheckProcessor] inbox ${inboxId} (${error ? "ERROR" : "NEEDS_REVIEW"}) ${person ?? "?"} ${payDate ?? "?"} net=${net ?? "?"}`);
}

// ── Handler ─────────────────────────────────────────────────────────────────

export const handler = async (event: S3Event): Promise<{ ok: boolean; processed: number; failed: number }> => {
  let processed = 0;
  let failed = 0;
  for (const record of event.Records ?? []) {
    const bucket = record.s3?.bucket?.name;
    const key    = decodeURIComponent((record.s3?.object?.key ?? "").replace(/\+/g, " "));
    if (!bucket || !key) {
      console.error("[paycheckProcessor] record missing bucket/key — skipping", JSON.stringify(record).slice(0, 500));
      failed++;
      continue;
    }
    // SES drops a marker object into the prefix when a receipt rule is created.
    if (key.endsWith("AMAZON_SES_SETUP_NOTIFICATION")) {
      console.log("[paycheckProcessor] skipping SES setup-notification marker");
      continue;
    }
    try {
      await processEmail(bucket, key);
      processed++;
    } catch (err) {
      console.error(`[paycheckProcessor] failed processing s3://${bucket}/${key}:`, err);
      failed++;
    }
  }
  return { ok: failed === 0, processed, failed };
};
