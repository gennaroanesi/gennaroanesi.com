/**
 * _lp_s3.mjs — shared S3 helpers for Layoff Philosophy background videos.
 *
 * Mirrors the pattern used by archive-charts.mjs:
 *   - bucket: gennaroanesi.com
 *   - region: us-east-1
 *   - public/* prefix has guest get + list, so URLs of the form
 *     https://gennaroanesi.com.s3.amazonaws.com/public/... are world-readable
 *
 * Backgrounds live under:
 *   public/layoff-philosophy/backgrounds/{category}/{filename}.mp4
 *
 * Manifest (small, committed) lives at:
 *   lib/layoff-philosophy/backgrounds-manifest.json
 */
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REGION = "us-east-1";
export const BUCKET = "gennaroanesi.com";
export const PREFIX = "public/layoff-philosophy/backgrounds/";
// Use path-style S3 URLs. Virtual-host style (https://<bucket>.s3.amazonaws.com/)
// fails TLS for buckets with dots in their names (wildcard cert *.s3.amazonaws.com
// only matches a single subdomain component).
export const URL_BASE = `https://s3.amazonaws.com/${BUCKET}/`;
export const CATEGORIES = ["emptiness", "machine", "exit", "contemplation"];
export const MANIFEST_PATH = path.resolve(
  __dirname,
  "..",
  "lib/layoff-philosophy/backgrounds-manifest.json"
);

export const s3 = new S3Client({ region: REGION });

export function s3KeyFor(category, filename) {
  return `${PREFIX}${category}/${filename}`;
}

export function s3UrlFor(category, filename) {
  return `${URL_BASE}${s3KeyFor(category, filename)}`;
}

export async function s3KeyExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function uploadBuffer({ key, body, contentType = "video/mp4" }) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
}

/**
 * List all MP4 keys under the backgrounds prefix, grouped by category.
 * Returns: { [category]: ["filename1.mp4", ...] }
 */
export async function listAllCategories() {
  const result = {};
  for (const category of CATEGORIES) {
    result[category] = [];
    let continuationToken;
    do {
      const res = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: `${PREFIX}${category}/`,
          ContinuationToken: continuationToken,
        })
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        const filename = obj.Key.replace(`${PREFIX}${category}/`, "");
        if (filename && filename.endsWith(".mp4")) result[category].push(filename);
      }
      continuationToken = res.NextContinuationToken;
    } while (continuationToken);
  }
  return result;
}

export function readManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function writeManifest(categories) {
  const manifest = {
    bucket: BUCKET,
    region: REGION,
    urlBase: URL_BASE,
    prefix: PREFIX,
    generatedAt: new Date().toISOString(),
    categories,
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/**
 * Regenerate the manifest by listing all S3 objects under the prefix.
 */
export async function regenerateManifest() {
  const categories = await listAllCategories();
  return writeManifest(categories);
}
