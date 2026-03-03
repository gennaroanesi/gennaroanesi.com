#!/usr/bin/env node
/**
 * parse-cifp.mjs
 *
 * Parses the FAA CIFP file (FAACIFP18) and outputs approach fix records
 * to scripts/data/cifp-fixes.json.
 *
 * Downloads:
 *   https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/
 *   → CIFP_YYYYMMDD.zip → extract FAACIFP18
 *
 * ACTUAL record format (verified by inspection of FAACIFP18):
 *   All records are 132 chars, fixed-width, space-padded.
 *   Col  1     : 'S' = Standard record
 *   Col  2-4   : Area code (e.g. 'USA', 'CAN')
 *   Col  5     : Section code ('P' = Terminal Procedures)
 *   Col  6     : ' ' (space — subsection is encoded in col 13, not here)
 *   Col  7-10  : Airport ICAO identifier (e.g. 'KGTU')
 *   Col  11-12 : ICAO region code (e.g. 'K4')
 *   Col  13    : Record type within section P:
 *                  'A' = Airport record
 *                  'C' = Terminal waypoint (has lat/lon)
 *                  'D' = SID procedure fix
 *                  'E' = STAR procedure fix
 *                  'F' = Approach procedure fix  ← we want this
 *                  'G' = Runway record
 *                  'P' = Path point
 *                  'S' = MSA
 *
 * F (approach) record fields (0-indexed):
 *   [13:19] Procedure identifier (e.g. 'R11   ', 'I13L  ')
 *   [19]    Route type
 *   [20:25] Transition identifier (e.g. 'AGJ  ', 'R    ' for final)
 *   [26:29] Sequence number (e.g. '010', '020')
 *   [29:34] Fix identifier (e.g. 'LOFJA', 'RW11 ')
 *   [34:36] Fix region code
 *   [36:38] Fix section/subsection (e.g. 'PC'=waypoint, 'D '=NDB)
 *   [38]    Continuation record number
 *   [39:43] Waypoint description codes (pos 2: A=IAF, B=IF, F=FAF, M=MAP, G=MAH)
 *   [47:49] Path & Terminator (e.g. 'TF', 'IF', 'CF', 'CA')
 *   [82:89] Altitude 1 (e.g. '+ 04000', '- 03400'; + = at-or-above, - = at-or-below)
 *   [94:99] Altitude 2
 *   [127:131] Cycle date (e.g. '2504')
 *
 * C (waypoint) record fields (0-indexed):
 *   [13:18] Waypoint name
 *   [32:41] Latitude  (e.g. 'N30462552' = N 30°46'25.52")
 *   [41:51] Longitude (e.g. 'W097520338' = W 097°52'03.38")
 *
 * Two-pass strategy:
 *   Pass 1: Build a waypoint → {lat, lon} lookup from all C records.
 *   Pass 2: Parse F records and join coordinates from the lookup.
 *
 * Usage:
 *   node scripts/parse-cifp.mjs <FAACIFP18_path> [output_json]
 *   npm run parse-cifp -- temp/FAACIFP18 temp/cifp-fixes.json
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const CIFP_FILE = args[0] ?? path.join(__dirname, "nasr", "FAACIFP18");
const OUT_FILE  = args[1] ?? path.join(__dirname, "data", "cifp-fixes.json");

if (!args[0]) {
  console.warn(`No input file specified — defaulting to ${CIFP_FILE}`);
  console.warn(`Usage: node scripts/parse-cifp.mjs <FAACIFP18_path> [output_json]`);
}

if (!fs.existsSync(CIFP_FILE)) {
  console.error(`CIFP file not found: ${CIFP_FILE}`);
  console.error(`Download from: https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

// ── Coordinate decoders ───────────────────────────────────────────────────────

// C record lat: 'N30462552' → N 30°46'25.52"
// Format: H DD MM SS TT  (H=N/S, DD=deg, MM=min, SS=sec, TT=hundredths)
function parseCLat(s) {
  s = (s ?? "").trim();
  if (!s || s.length < 7) return null;
  const hemi = s[0];
  const deg  = parseInt(s.slice(1, 3), 10);
  const min  = parseInt(s.slice(3, 5), 10);
  const sec  = parseInt(s.slice(5, 7), 10);
  const frac = s.length > 7 ? parseInt(s.slice(7), 10) / Math.pow(10, s.length - 7) : 0;
  const dd   = deg + min / 60 + (sec + frac) / 3600;
  return hemi === "S" ? -dd : dd;
}

// C record lon: 'W097520338' → W 097°52'03.38"
// Format: H DDD MM SS TT  (H=E/W, DDD=deg 3-digit, MM=min, SS=sec, TT=hundredths)
function parseCLon(s) {
  s = (s ?? "").trim();
  if (!s || s.length < 8) return null;
  const hemi = s[0];
  const deg  = parseInt(s.slice(1, 4), 10);
  const min  = parseInt(s.slice(4, 6), 10);
  const sec  = parseInt(s.slice(6, 8), 10);
  const frac = s.length > 8 ? parseInt(s.slice(8), 10) / Math.pow(10, s.length - 8) : 0;
  const dd   = deg + min / 60 + (sec + frac) / 3600;
  return hemi === "W" ? -dd : dd;
}

// Altitude: '+ 04000' or '+ 03400' — leading +/- indicates constraint type
function parseAlt(s) {
  s = (s ?? "").trim();
  if (!s) return null;
  const sign = s[0];
  const num  = parseInt(s.replace(/[^0-9]/g, ""), 10);
  if (isNaN(num) || num === 0) return null;
  return {
    ft: num,
    constraint: sign === "+" ? "AT_OR_ABOVE" : sign === "-" ? "AT_OR_BELOW" : "AT",
  };
}

// Waypoint description codes [39:43], position 2 (index 1 within the 4-char field):
//   A = IAF, B = IF, C = IAF+IF, F = FAF, M = MAP, G = MAH
function parseFixRole(desc) {
  if (!desc) return null;
  const roles = [];
  const pos2 = (desc[1] ?? " ").trim();
  if (pos2 === "A") roles.push("IAF");
  if (pos2 === "B") roles.push("IF");
  if (pos2 === "C") { roles.push("IAF"); roles.push("IF"); }
  if (pos2 === "F") roles.push("FAF");
  if (pos2 === "M") roles.push("MAP");
  if (pos2 === "G") roles.push("MAH");
  return roles.length ? roles.join(",") : null;
}

// ── Pass 1: Build waypoint coordinate lookup ──────────────────────────────────

function readLines(filePath) {
  return new Promise((resolve) => {
    const lines = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => lines.push(line));
    rl.on("close", () => resolve(lines));
  });
}

console.log(`Reading ${CIFP_FILE}...`);
const lines = await readLines(CIFP_FILE);
console.log(`  ${lines.length.toLocaleString()} lines read`);

// Waypoint lookup: key = fixId (trimmed) → { lat, lon }
// For fix lookups we use just the name since the same fix can appear under multiple airports.
// We store by name only; if there are duplicates the last one wins (coords won't differ meaningfully).
const waypointCoords = new Map();

for (const line of lines) {
  if (line.length < 51) continue;
  if (line[0] !== "S") continue;
  if (line[4] !== "P") continue;
  if (line[12] !== "C") continue;  // waypoint definition record

  const name   = line.slice(13, 18).trim();
  const latRaw = line.slice(32, 41).trim();
  const lonRaw = line.slice(41, 51).trim();
  if (!name || !latRaw || !lonRaw) continue;

  const lat = parseCLat(latRaw);
  const lon = parseCLon(lonRaw);
  if (lat === null || lon === null) continue;

  waypointCoords.set(name, { lat, lon });
}

console.log(`  ${waypointCoords.size.toLocaleString()} waypoints indexed`);

// ── Pass 2: Parse approach procedure (F) records ──────────────────────────────

const procedures = new Map();
let parsedCount = 0;

for (const line of lines) {
  if (line.length < 99) continue;
  if (line[0] !== "S") continue;
  if (line[4] !== "P") continue;
  if (line[12] !== "F") continue;  // approach procedure record

  // Skip continuation records (col 39, index 38) — only keep primary (0 or 1)
  const contNo = line[38].trim();
  if (contNo !== "0" && contNo !== "1" && contNo !== "") continue;

  const icao       = line.slice(6, 10).trim();
  const procedure  = line.slice(13, 19).trim();
  const routeType  = line[19].trim();
  const transition = line.slice(20, 25).trim();
  const seqNo      = parseInt(line.slice(26, 29), 10);
  const fixId      = line.slice(29, 34).trim();
  const descCodes  = line.slice(39, 43);
  const pathTerm   = line.slice(47, 49).trim();
  const alt1Raw    = line.slice(82, 89).trim();
  const alt2Raw    = line.slice(94, 99).trim();
  const cycleDate  = line.slice(127, 131).trim();

  if (!fixId || !icao) continue;

  // Look up coordinates from waypoint index
  const coords = waypointCoords.get(fixId);
  const lat    = coords?.lat ?? null;
  const lon    = coords?.lon ?? null;

  const alt1 = parseAlt(alt1Raw);
  const alt2 = parseAlt(alt2Raw);
  const role = parseFixRole(descCodes);

  const key = `${icao}|${procedure}|${transition}`;
  if (!procedures.has(key)) {
    procedures.set(key, {
      icao,
      procedure,
      transition: transition || null,
      routeType,
      cycleDate,
      fixes: [],
    });
  }

  procedures.get(key).fixes.push({
    seq:      seqNo,
    fixId,
    pathTerm: pathTerm || null,
    role:     role || null,
    lat,
    lon,
    alt1,
    alt2,
  });

  parsedCount++;
}

// ── Output ────────────────────────────────────────────────────────────────────

const output = [...procedures.values()].map((proc) => ({
  ...proc,
  fixes: proc.fixes.sort((a, b) => a.seq - b.seq),
}));

fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

console.log(`Fix records parsed:  ${parsedCount.toLocaleString()}`);
console.log(`Procedures:          ${output.length.toLocaleString()}`);
console.log(`Output:              ${OUT_FILE}`);
