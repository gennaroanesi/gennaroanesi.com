/**
 * sync_backgrounds_s3.mjs
 *
 * One-shot migration: uploads any MP4s sitting in public/backgrounds/{category}/
 * up to S3 at s3://gennaroanesi.com/public/layoff-philosophy/backgrounds/{category}/{file},
 * skipping anything already present. Then regenerates the manifest at
 * lib/layoff-philosophy/backgrounds-manifest.json from a fresh S3 listing.
 *
 * Usage:
 *   node scripts/sync_backgrounds_s3.mjs                  # upload + regen manifest
 *   node scripts/sync_backgrounds_s3.mjs --dry-run        # preview only
 *   node scripts/sync_backgrounds_s3.mjs --delete-local   # remove local copies after upload
 *   node scripts/sync_backgrounds_s3.mjs --manifest-only  # skip uploads, just regen manifest
 *
 * Requires ambient AWS credentials (~/.aws/credentials or AWS_PROFILE).
 */

import { existsSync, readdirSync, readFileSync, unlinkSync, rmdirSync } from "fs";
import { stat } from "fs/promises";
import path from "path";

import {
  CATEGORIES,
  regenerateManifest,
  s3KeyExists,
  s3KeyFor,
  uploadBuffer,
} from "./_lp_s3.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  })
);

const DRY_RUN = args["dry-run"] === "true";
const DELETE_LOCAL = args["delete-local"] === "true";
const MANIFEST_ONLY = args["manifest-only"] === "true";
const LOCAL_BASE = path.resolve(process.cwd(), "public/backgrounds");

async function uploadCategory(category) {
  const dir = path.join(LOCAL_BASE, category);
  if (!existsSync(dir)) {
    console.log(`[${category}] no local dir, skipping`);
    return { uploaded: 0, skipped: 0 };
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".mp4"));
  if (files.length === 0) {
    console.log(`[${category}] no files`);
    return { uploaded: 0, skipped: 0 };
  }

  let uploaded = 0;
  let skipped = 0;
  for (const filename of files) {
    const localPath = path.join(dir, filename);
    const key = s3KeyFor(category, filename);

    if (await s3KeyExists(key)) {
      console.log(`  · ${filename} (already in S3)`);
      skipped++;
      if (DELETE_LOCAL && !DRY_RUN) unlinkSync(localPath);
      continue;
    }

    const sizeMB = (((await stat(localPath)).size) / 1024 / 1024).toFixed(1);
    if (DRY_RUN) {
      console.log(`  · DRY-RUN: would upload ${filename} (${sizeMB} MB) → s3://${key}`);
      continue;
    }

    const body = readFileSync(localPath);
    try {
      await uploadBuffer({ key, body });
      console.log(`  ✓ ${filename} (${sizeMB} MB)`);
      uploaded++;
      if (DELETE_LOCAL) unlinkSync(localPath);
    } catch (e) {
      console.error(`  ✗ ${filename}: ${e.message}`);
    }
  }
  return { uploaded, skipped };
}

async function main() {
  if (!MANIFEST_ONLY) {
    console.log(`Sync backgrounds → S3${DRY_RUN ? " (DRY RUN)" : ""}${DELETE_LOCAL ? " (will delete locals after upload)" : ""}\n`);
    let totalUploaded = 0;
    let totalSkipped = 0;
    for (const category of CATEGORIES) {
      console.log(`[${category}]`);
      const { uploaded, skipped } = await uploadCategory(category);
      totalUploaded += uploaded;
      totalSkipped += skipped;
      console.log();
    }
    console.log(`Upload summary: ${totalUploaded} new, ${totalSkipped} already present.`);

    if (DELETE_LOCAL && !DRY_RUN) {
      // Try to remove empty category dirs + the base
      for (const category of CATEGORIES) {
        const dir = path.join(LOCAL_BASE, category);
        if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
      }
      if (existsSync(LOCAL_BASE) && readdirSync(LOCAL_BASE).length === 0) rmdirSync(LOCAL_BASE);
    }
  }

  if (DRY_RUN) {
    console.log("\nDRY-RUN: skipping manifest regeneration.");
    return;
  }

  console.log("\nRegenerating manifest from S3 listing…");
  const manifest = await regenerateManifest();
  let total = 0;
  for (const [cat, files] of Object.entries(manifest.categories)) {
    console.log(`  ${cat}: ${files.length} file(s)`);
    total += files.length;
  }
  console.log(`\nManifest written (${total} backgrounds across ${CATEGORIES.length} categories).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
