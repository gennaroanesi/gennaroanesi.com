/**
 * notesApi/handler.ts
 *
 * CRUD API for the household PARA vault in S3.
 *
 * Routes:
 *   GET    /notes              — list all files (optionally ?prefix=PARA/Areas/)
 *   GET    /notes/{key+}       — read a file (key = full S3 key, e.g. PARA/Areas/pets.md)
 *   PUT    /notes/{key+}       — write/overwrite a file (body = raw markdown)
 *   DELETE /notes/{key+}       — delete a file
 *
 * Auth:
 *   All requests must include:  Authorization: Bearer <token>
 *   Token is compared against NOTES_API_TOKEN env var (constant-time compare).
 *
 * The {key+} path parameter captures slashes, so the full S3 key is preserved.
 */

import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import * as crypto from "crypto";

const s3     = new S3Client({});
const BUCKET = process.env.BUCKET_NAME!;
const TOKEN  = process.env.NOTES_API_TOKEN!;

// ── Auth ──────────────────────────────────────────────────────────────────────

function authorize(event: any): boolean {
  const header = event.headers?.["authorization"] ?? event.headers?.["Authorization"] ?? "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !TOKEN) return false;
  // Constant-time compare to prevent timing attacks
  try {
    const a = new Uint8Array(Buffer.from(token));
    const b = new Uint8Array(Buffer.from(TOKEN));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function text(statusCode: number, body: string, contentType = "text/markdown; charset=utf-8") {
  return {
    statusCode,
    headers: { "Content-Type": contentType },
    body,
  };
}

async function streamToString(stream: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function listNotes(prefix: string) {
  const safePrefix = prefix.startsWith("PARA/") ? prefix : "PARA/";
  const result = await s3.send(new ListObjectsV2Command({
    Bucket: BUCKET,
    Prefix: safePrefix,
  }));

  const files = (result.Contents ?? [])
    .filter((obj) => obj.Key && !obj.Key.endsWith(".gitkeep"))
    .map((obj) => ({
      key:          obj.Key,
      size:         obj.Size,
      lastModified: obj.LastModified,
    }));

  return json(200, { files, count: files.length, prefix: safePrefix });
}

async function readNote(key: string) {
  // Scope to PARA/ only
  if (!key.startsWith("PARA/")) {
    return json(403, { error: "Access restricted to PARA/ prefix" });
  }
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body   = await streamToString(result.Body as any);
    return text(200, body);
  } catch (err: any) {
    if (err.name === "NoSuchKey") return json(404, { error: "Not found", key });
    throw err;
  }
}

async function writeNote(key: string, body: string) {
  if (!key.startsWith("PARA/")) {
    return json(403, { error: "Access restricted to PARA/ prefix" });
  }
  if (!key.endsWith(".md")) {
    return json(400, { error: "Only .md files are allowed" });
  }
  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        body,
    ContentType: "text/markdown; charset=utf-8",
  }));
  return json(200, { ok: true, key });
}

async function deleteNote(key: string) {
  if (!key.startsWith("PARA/")) {
    return json(403, { error: "Access restricted to PARA/ prefix" });
  }
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  return json(200, { ok: true, key });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Auth gate
  if (!authorize(event)) {
    return json(401, { error: "Unauthorized" });
  }

  const method     = event.requestContext.http.method.toUpperCase();
  const rawPath    = event.rawPath ?? "";                  // e.g. /notes/PARA/Areas/pets.md
  const pathParams = event.pathParameters ?? {};

  // Extract the S3 key from the path: /notes/{key+} → key
  // API Gateway HTTP API sends the greedy path param as "key"
  const key = pathParams["key"] ? decodeURIComponent(pathParams["key"]) : "";

  try {
    // GET /notes — list
    if (method === "GET" && !key) {
      const prefix = (event.queryStringParameters?.["prefix"] as string) ?? "PARA/";
      return await listNotes(prefix);
    }

    // GET /notes/{key+} — read
    if (method === "GET" && key) {
      return await readNote(key);
    }

    // PUT /notes/{key+} — write
    if (method === "PUT" && key) {
      const body = event.body ?? "";
      const content = event.isBase64Encoded
        ? Buffer.from(body, "base64").toString("utf-8")
        : body;
      return await writeNote(key, content);
    }

    // DELETE /notes/{key+} — delete
    if (method === "DELETE" && key) {
      return await deleteNote(key);
    }

    return json(405, { error: "Method not allowed", method, path: rawPath });

  } catch (err: any) {
    console.error("notesApi error:", err);
    return json(500, { error: "Internal server error", message: err.message });
  }
};
