/**
 * fetch_pexels_backgrounds.mjs
 *
 * Downloads portrait (9:16) background videos from Pexels for each of the
 * four Layoff Philosophy background categories, streaming each file directly
 * to S3 at:
 *
 *   s3://gennaroanesi.com/public/layoff-philosophy/backgrounds/{category}/{slug}.mp4
 *
 * No local copies are kept. After uploads complete, the manifest at
 * lib/layoff-philosophy/backgrounds-manifest.json is regenerated from a
 * fresh S3 listing.
 *
 * Run:
 *   npm run lp:fetch-bg
 *   npm run lp:fetch-bg -- --category=machine --per-query=3
 *   npm run lp:fetch-bg -- --dry-run
 *
 * Requires PEXELS_API_KEY in .env.local and ambient AWS credentials.
 */

import { CATEGORIES, regenerateManifest, s3KeyExists, s3KeyFor, uploadBuffer } from "./_lp_s3.mjs";

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
if (!PEXELS_API_KEY) {
  console.error("Missing PEXELS_API_KEY. Add it to .env.local and re-run.");
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  })
);

const TARGET_CATEGORY = args.category || null;
const PER_QUERY = parseInt(args["per-query"] || "2", 10);
const DRY_RUN = args["dry-run"] === "true";

const CATEGORY_QUERIES = {
  emptiness: ["empty office dark", "vacant desk", "abandoned office building"],
  machine: ["elevator doors corporate", "glass office building night", "corporate hallway"],
  exit: ["person leaving building", "walking away hallway", "exit door office"],
  contemplation: ["rain on window office", "person looking out window", "coffee alone moody"],
};

const PEXELS_BASE = "https://api.pexels.com";

async function pexelsSearch(query, perPage = 5) {
  const url = new URL(`${PEXELS_BASE}/videos/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("orientation", "portrait");

  const res = await fetch(url.toString(), {
    headers: { Authorization: PEXELS_API_KEY },
  });
  if (!res.ok) {
    throw new Error(`Pexels API ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.videos || [];
}

function bestMp4(video, target = { width: 1080, height: 1920 }) {
  const mp4s = (video.video_files || [])
    .filter((f) => f.file_type === "video/mp4")
    .sort((a, b) => {
      const da = Math.abs(a.width - target.width) + Math.abs(a.height - target.height);
      const db = Math.abs(b.width - target.width) + Math.abs(b.height - target.height);
      return da - db;
    });
  return mp4s[0] || null;
}

function slugForVideo(query, videoId) {
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug}-${videoId}.mp4`;
}

async function downloadToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed for ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function processCategory(category, queries) {
  let uploaded = 0;
  for (const query of queries) {
    console.log(`\n[${category}] searching "${query}"…`);
    let videos;
    try {
      videos = await pexelsSearch(query, PER_QUERY * 2);
    } catch (e) {
      console.error(`  ✗ search failed: ${e.message}`);
      continue;
    }

    const picks = videos.slice(0, PER_QUERY);
    for (const v of picks) {
      const file = bestMp4(v);
      if (!file) {
        console.log(`  · skipping video ${v.id}: no mp4 file`);
        continue;
      }
      const filename = slugForVideo(query, v.id);
      const key = s3KeyFor(category, filename);

      if (await s3KeyExists(key)) {
        console.log(`  · ${filename} (already in S3)`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  · DRY-RUN: would upload ${file.width}x${file.height} → s3://${key}`);
        continue;
      }
      try {
        const body = await downloadToBuffer(file.link);
        await uploadBuffer({ key, body });
        const sizeMB = (body.length / 1024 / 1024).toFixed(1);
        console.log(`  ✓ ${filename} (${file.width}x${file.height}, ${sizeMB} MB)`);
        uploaded++;
      } catch (e) {
        console.error(`  ✗ ${filename}: ${e.message}`);
      }
    }
    // Be nice to the Pexels API
    await new Promise((r) => setTimeout(r, 250));
  }
  return uploaded;
}

async function main() {
  const cats = TARGET_CATEGORY
    ? { [TARGET_CATEGORY]: CATEGORY_QUERIES[TARGET_CATEGORY] }
    : CATEGORY_QUERIES;

  if (TARGET_CATEGORY && !CATEGORY_QUERIES[TARGET_CATEGORY]) {
    console.error(
      `Unknown category: ${TARGET_CATEGORY}. Valid: ${Object.keys(CATEGORY_QUERIES).join(", ")}`
    );
    process.exit(1);
  }

  console.log(
    `Pexels → S3 fetch${DRY_RUN ? " (DRY RUN)" : ""} — per-query=${PER_QUERY}, categories=${Object.keys(cats).join(",")}`
  );

  let total = 0;
  for (const [category, queries] of Object.entries(cats)) {
    total += await processCategory(category, queries);
  }

  console.log(`\nUploaded ${total} new file(s).`);

  if (DRY_RUN) {
    console.log("DRY-RUN: skipping manifest regeneration.");
    return;
  }

  console.log("Regenerating manifest from S3 listing…");
  const manifest = await regenerateManifest();
  const counts = Object.entries(manifest.categories)
    .map(([cat, files]) => `${cat}=${files.length}`)
    .join(" ");
  console.log(`Manifest: ${counts}`);
  // Suppress unused-import warning on CATEGORIES (used for ordering by importers).
  void CATEGORIES;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
