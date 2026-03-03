#!/usr/bin/env node
/**
 * parse-nasr.mjs
 *
 * Parses FAA NASR APT_BASE.csv and outputs:
 *   1. src/data/airports.min.json   — lightweight autocomplete payload (frontend)
 *   2. src/data/airports.full.json  — full airport records matching Amplify Airport model
 *
 * Input: scripts/nasr/APT_BASE.csv (comma-delimited, quoted fields, header row)
 *
 * Actual column names from the 2026-01-22 NASR cycle:
 *   EFF_DATE, SITE_NO, SITE_TYPE_CODE, STATE_CODE, ARPT_ID, CITY, COUNTRY_CODE,
 *   REGION_CODE, ADO_CODE, STATE_NAME, COUNTY_NAME, COUNTY_ASSOC_STATE, ARPT_NAME,
 *   OWNERSHIP_TYPE_CODE, FACILITY_USE_CODE, LAT_DEG, LAT_MIN, LAT_SEC, LAT_HEMIS,
 *   LAT_DECIMAL, LONG_DEG, LONG_MIN, LONG_SEC, LONG_HEMIS, LONG_DECIMAL,
 *   SURVEY_METHOD_CODE, ELEV, ELEV_METHOD_CODE, MAG_VARN, MAG_HEMIS, MAG_VARN_YEAR,
 *   TPA, CHART_NAME, DIST_CITY_TO_AIRPORT, DIRECTION_CODE, ACREAGE,
 *   RESP_ARTCC_ID, COMPUTER_ID, ARTCC_NAME, FSS_ON_ARPT_FLAG, FSS_ID, FSS_NAME,
 *   PHONE_NO, TOLL_FREE_NO, ALT_FSS_ID, ALT_FSS_NAME, ALT_TOLL_FREE_NO,
 *   NOTAM_ID, NOTAM_FLAG, ACTIVATION_DATE, ARPT_STATUS, FAR_139_TYPE_CODE,
 *   FAR_139_CARRIER_SER_CODE, ARFF_CERT_TYPE_DATE, NASP_CODE, ASP_ANLYS_DTRM_CODE,
 *   CUST_FLAG, LNDG_RIGHTS_FLAG, JOINT_USE_FLAG, MIL_LNDG_FLAG,
 *   INSPECT_METHOD_CODE, INSPECTOR_CODE, LAST_INSPECTION, LAST_INFO_RESPONSE,
 *   FUEL_TYPES, AIRFRAME_REPAIR_SER_CODE, PWR_PLANT_REPAIR_SER,
 *   BOTTLED_OXY_TYPE, BULK_OXY_TYPE, LGT_SKED, BCN_LGT_SKED, TWR_TYPE_CODE,
 *   SEG_CIRCLE_MKR_FLAG, BCN_LENS_COLOR, LNDG_FEE_FLAG, MEDICAL_USE_FLAG,
 *   ARPT_PSN_SOURCE, POSITION_SRC_DATE, ARPT_ELEV_SOURCE, ELEVATION_SRC_DATE,
 *   CONTR_FUEL_AVBL, TRNS_STRG_BUOY_FLAG, TRNS_STRG_HGR_FLAG, TRNS_STRG_TIE_FLAG,
 *   OTHER_SERVICES, WIND_INDCR_FLAG, ICAO_ID, MIN_OP_NETWORK, USER_FEE_FLAG, CTA
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const APT_BASE = args[0] ?? path.join(__dirname, "nasr", "APT_BASE.csv");
const OUT_DIR = args[1] ?? path.join(__dirname, "data");
const OUT_MIN = path.join(OUT_DIR, "airports.min.json");
const OUT_FULL = path.join(OUT_DIR, "airports.full.json");
const TODAY = new Date().toISOString().slice(0, 10);

// ── Helpers ───────────────────────────────────────────────────────────────────

function tc(s) {
  return (s ?? "")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
function yn(s) {
  return (s ?? "").trim().toUpperCase() === "Y";
}
function str(s) {
  const v = (s ?? "").trim();
  return v || null;
}
function int(s) {
  const n = parseInt(s ?? "");
  return isNaN(n) ? null : n;
}
function flt(s) {
  const n = parseFloat(s ?? "");
  return isNaN(n) ? null : n;
}

function parseNasrDate(s) {
  // YYYY/MM/DD → YYYY-MM-DD
  const m = (s ?? "").match(/(\d{4})\/(\d{2})\/(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Parse a single CSV line respecting quoted fields.
 * NASR uses double-quoted fields; commas inside quotes are not present in this file
 * but we handle them correctly anyway.
 */
function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      fields.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}

function ownershipType(code) {
  const c = (code ?? "").trim().toUpperCase();
  if (["MA", "MN", "MR", "CG"].includes(c)) return "MILITARY";
  if (c === "PR") return "PRIVATE";
  return "PUBLIC";
}

function facilityUseEnum(code) {
  return (code ?? "").trim().toUpperCase() === "PR" ? "PRIVATE" : "PUBLIC";
}

function repairEnum(code) {
  const c = (code ?? "").trim().toUpperCase();
  if (c === "MAJOR") return "MAJOR";
  if (c === "MINOR") return "MINOR";
  return "NONE";
}

function deriveIcao(faaId, icaoField, stateCode) {
  const icao = (icaoField ?? "").trim();
  if (icao && icao.length >= 3) return { icaoId: icao, hasIcao: true };
  const nonContig = ["AK", "HI", "GU", "PR", "VI", "AS", "MP"];
  const derived = nonContig.includes(stateCode) ? faaId : `K${faaId}`;
  return { icaoId: derived, hasIcao: false };
}

// ── Parse ─────────────────────────────────────────────────────────────────────

if (!fs.existsSync(APT_BASE)) {
  console.error(`\n❌  APT_BASE.csv not found at ${APT_BASE}\n`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const fullAirports = [];
const minAirports = [];
let headers = null;
let skipped = 0;
let lineNum = 0;

console.log("⏳  Parsing APT_BASE.csv…");

await new Promise((resolve) => {
  const rl = readline.createInterface({
    input: fs.createReadStream(APT_BASE),
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    lineNum++;
    if (!line.trim()) return;

    const cols = parseCsvLine(line);

    // First line is the header row
    if (lineNum === 1) {
      headers = cols.map((h) => h.replace(/"/g, "").trim());
      return;
    }

    // Build a named-column accessor
    const c = {};
    headers.forEach((h, i) => {
      c[h] = (cols[i] ?? "").trim();
    });

    // ── Filters ──────────────────────────────────────────────────────────────
    if (c.SITE_TYPE_CODE !== "A") {
      skipped++;
      return;
    } // airports only
    if (c.FACILITY_USE_CODE !== "PU") {
      skipped++;
      return;
    } // public use only
    if (c.COUNTRY_CODE !== "US") {
      skipped++;
      return;
    } // US only
    // Skip closed airports
    if (["CI", "CP"].includes(c.ARPT_STATUS)) {
      skipped++;
      return;
    }

    const faaId = str(c.ARPT_ID);
    const stateCode = str(c.STATE_CODE);
    if (!faaId || !stateCode) {
      skipped++;
      return;
    }

    // Longitude in the file is unsigned — apply hemisphere
    const latRaw = flt(c.LAT_DECIMAL);
    const lonRaw = flt(c.LONG_DECIMAL);
    if (latRaw === null || lonRaw === null) {
      skipped++;
      return;
    }

    // LAT_DECIMAL is already signed in this file; LONG_DECIMAL is positive
    // and LONG_HEMIS tells us W (negative) or E (positive)
    const lat = latRaw;
    const lon = c.LONG_HEMIS === "W" ? -Math.abs(lonRaw) : Math.abs(lonRaw);

    const { icaoId, hasIcao } = deriveIcao(faaId, c.ICAO_ID, stateCode);
    const name = tc(c.ARPT_NAME);
    const city = tc(c.CITY);
    const nasrSiteNo = str(c.SITE_NO);
    const cycleDate = parseNasrDate(c.EFF_DATE) ?? TODAY;

    const full = {
      // Identifiers
      faaId,
      icaoId,
      hasIcao,
      nasrSiteNo,
      nasrCycleDate: cycleDate,

      // Classification
      facilityType: "AIRPORT",
      facilityUse: facilityUseEnum(c.FACILITY_USE_CODE),
      ownershipType: ownershipType(c.OWNERSHIP_TYPE_CODE),

      // Name & location
      name,
      city,
      stateCode,
      stateName: tc(c.STATE_NAME),
      county: tc(c.COUNTY_NAME),
      faaRegion: str(c.REGION_CODE),
      sectionalChart: tc(c.CHART_NAME),

      // Coordinates & elevation
      latDecimal: Math.round(lat * 100000) / 100000,
      lonDecimal: Math.round(lon * 100000) / 100000,
      elevationFt: int(c.ELEV),

      // Services
      hasTower: str(c.TWR_TYPE_CODE) !== null && c.TWR_TYPE_CODE !== "NON-ATCT",
      fuelTypes: str(c.FUEL_TYPES),
      airframeRepair: repairEnum(c.AIRFRAME_REPAIR_SER_CODE),
      powerplantRepair: repairEnum(c.PWR_PLANT_REPAIR_SER),
      hasWeatherStation: false, // to be enriched from AWOS data
      beaconType: str(c.BCN_LENS_COLOR),
      hasLandingFee: yn(c.LNDG_FEE_FLAG),
      hasTransientHangar: yn(c.TRNS_STRG_HGR_FLAG),
      hasTransientTiedown: yn(c.TRNS_STRG_TIE_FLAG),
      contractFuel: yn(c.CONTR_FUEL_AVBL),

      // Airspace (tower = Class D proxy; proper class requires shapefile join)
      airspaceClass:
        str(c.TWR_TYPE_CODE) !== null && c.TWR_TYPE_CODE !== "NON-ATCT"
          ? "D"
          : "G",
    };

    fullAirports.push(full);

    minAirports.push({
      icao: icaoId,
      id: faaId,
      name,
      city,
      state: stateCode,
      lat: full.latDecimal,
      lon: full.lonDecimal,
    });
  });

  rl.on("close", resolve);
});

// Sort min: real ICAOs first (length 4), then alphabetical
minAirports.sort((a, b) => {
  const aReal = a.icao.length === 4;
  const bReal = b.icao.length === 4;
  if (aReal !== bReal) return aReal ? -1 : 1;
  return a.icao.localeCompare(b.icao);
});

fullAirports.sort((a, b) => {
  if (a.hasIcao !== b.hasIcao) return a.hasIcao ? -1 : 1;
  return a.icaoId.localeCompare(b.icaoId);
});

fs.writeFileSync(OUT_MIN, JSON.stringify(minAirports));
fs.writeFileSync(OUT_FULL, JSON.stringify(fullAirports, null, 2));

const minKb = Math.round(fs.statSync(OUT_MIN).size / 1024);
const fullKb = Math.round(fs.statSync(OUT_FULL).size / 1024);

console.log(
  `\n✅  ${fullAirports.length.toLocaleString()} public US airports parsed`,
);
console.log(`    airports.min.json   → ${minKb}kb   (autocomplete)`);
console.log(`    airports.full.json  → ${fullKb}kb  (DynamoDB seed)`);
console.log(
  `    Skipped: ${skipped.toLocaleString()} lines (private, closed, non-airport, foreign)\n`,
);
console.log(`    Sample records:`);
fullAirports
  .slice(0, 3)
  .forEach((a) =>
    console.log(
      `      ${a.icaoId.padEnd(6)} ${a.name.padEnd(35)} ${a.city}, ${a.stateCode}  elev ${a.elevationFt}ft  tower:${a.hasTower}`,
    ),
  );
console.log();
