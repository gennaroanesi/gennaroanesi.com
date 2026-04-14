#!/usr/bin/env node
import sharp from "sharp";
import { statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const [, , input, outputArg] = process.argv;

if (!input) {
  console.error("Usage: node scripts/optimize-photo.mjs <input> [output]");
  process.exit(1);
}

const base = basename(input, extname(input));
const output = outputArg ?? join(dirname(input), `${base}.web.jpg`);

await sharp(input)
  .rotate()
  .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
  .jpeg({ quality: 82, progressive: true, chromaSubsampling: "4:2:0", mozjpeg: true })
  .toFile(output);

const kb = (statSync(output).size / 1024).toFixed(0);
console.log(`${output} (${kb} KB)`);
