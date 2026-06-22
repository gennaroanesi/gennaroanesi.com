/**
 * render_reels.mts
 *
 * Batch-renders Layoff Philosophy Reels via Remotion. Defaults to rendering
 * every quote whose status is "ready" using the kenBurns animation style.
 *
 * Run via the npm script (uses tsx for TS support):
 *   npm run lp:render                              # all ready quotes, kenBurns
 *   npm run lp:render -- --style=wordReveal
 *   npm run lp:render -- --status=draft --limit=3
 *   npm run lp:render -- --id=sartre-severance
 *   npm run lp:render -- --dry-run
 *
 * Outputs to ./out/{id}-{style}.mp4
 *
 * Background video selection: picks a deterministic file from
 * public/backgrounds/{quote.backgroundCategory}/ if any exist; otherwise
 * renders with the gradient fallback baked into the composition.
 */
import { existsSync, mkdirSync, readFileSync } from "fs";
import path from "path";

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

import {
  quotes as allQuotes,
  type BackgroundCategory,
  type Quote,
  type QuoteStatus,
} from "../lib/layoff-philosophy/quotes";

interface BackgroundsManifest {
  bucket: string;
  region: string;
  urlBase: string;
  prefix: string;
  generatedAt: string;
  categories: Record<string, string[]>;
}

type AnimationStyle =
  | "kenBurns"
  | "wordReveal"
  | "parallax"
  | "atmospheric"
  | "videoBackground";

const ANIMATION_STYLES: AnimationStyle[] = [
  "kenBurns",
  "wordReveal",
  "parallax",
  "atmospheric",
  "videoBackground",
];

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  })
);

const STATUS: QuoteStatus | "all" = (args.status ?? "ready") as QuoteStatus | "all";
const STYLE: AnimationStyle = (args.style ?? "kenBurns") as AnimationStyle;
const ID: string | null = args.id ?? null;
const LIMIT: number | null = args.limit ? parseInt(args.limit, 10) : null;
const DRY_RUN = args["dry-run"] === "true";

if (!ANIMATION_STYLES.includes(STYLE)) {
  console.error(`Unknown style "${STYLE}". Valid: ${ANIMATION_STYLES.join(", ")}`);
  process.exit(1);
}

const ROOT = process.cwd();
const ENTRY = path.join(ROOT, "remotion/index.ts");
const OUT_DIR = path.join(ROOT, "out");
const MANIFEST_PATH = path.join(ROOT, "lib/layoff-philosophy/backgrounds-manifest.json");

function loadManifest(): BackgroundsManifest | null {
  if (!existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as BackgroundsManifest;
}

function pickBackgroundVideo(
  manifest: BackgroundsManifest | null,
  category: BackgroundCategory,
  quoteId: string
): string {
  if (!manifest) return "";
  const files = manifest.categories[category] ?? [];
  if (files.length === 0) return "";
  // Stable per-quote pick: hash quoteId chars to pick a file
  const hash = quoteId.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const pick = files[hash % files.length];
  return `${manifest.urlBase}${manifest.prefix}${category}/${pick}`;
}

function selectQuotes(): Quote[] {
  if (ID) {
    const q = allQuotes.find((x) => x.id === ID);
    if (!q) {
      console.error(`No quote with id "${ID}"`);
      process.exit(1);
    }
    return [q];
  }
  const filtered = STATUS === "all" ? allQuotes : allQuotes.filter((q) => q.status === STATUS);
  return LIMIT ? filtered.slice(0, LIMIT) : filtered;
}

async function main() {
  const quotes = selectQuotes();
  if (quotes.length === 0) {
    console.log("No quotes match the filter. Nothing to render.");
    return;
  }

  const manifest = loadManifest();
  if (!manifest) {
    console.warn(
      "No backgrounds manifest at lib/layoff-philosophy/backgrounds-manifest.json — every render will use the gradient fallback. Run `npm run lp:sync-bg-s3` or `npm run lp:fetch-bg` first."
    );
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  console.log(
    `Render plan: ${quotes.length} quote(s), style=${STYLE}, status=${STATUS}${ID ? `, id=${ID}` : ""}`
  );

  if (DRY_RUN) {
    for (const q of quotes) {
      const bg = pickBackgroundVideo(manifest, q.backgroundCategory, q.id);
      console.log(`  · ${q.id}  bg=${bg || "(gradient fallback)"}`);
    }
    return;
  }

  console.log("Bundling Remotion project (one-time)…");
  const serveUrl = await bundle({ entryPoint: ENTRY });

  for (const q of quotes) {
    const bg = pickBackgroundVideo(manifest, q.backgroundCategory, q.id);
    const inputProps = {
      quoteText: q.text,
      author: q.author,
      backgroundVideo: bg,
      backgroundCategory: q.backgroundCategory,
      animationStyle: STYLE,
    };

    const composition = await selectComposition({
      serveUrl,
      id: "LayoffQuote",
      inputProps,
    });

    const outFile = path.join(OUT_DIR, `${q.id}-${STYLE}.mp4`);
    console.log(`\nRendering ${q.id}  →  ${path.relative(ROOT, outFile)}`);

    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: outFile,
      inputProps,
      onProgress: ({ progress }) => {
        if (progress > 0) process.stdout.write(`\r  ${(progress * 100).toFixed(0)}%   `);
      },
    });
    process.stdout.write("\r  done            \n");
  }

  console.log(`\nDone. ${quotes.length} reel(s) written to ${path.relative(ROOT, OUT_DIR)}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
