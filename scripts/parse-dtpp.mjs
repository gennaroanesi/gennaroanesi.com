/**
 * parse-dtpp.mjs
 *
 * Parses the FAA d-TPP XML Metafile (current.xml / d-TPP_Metafile.xml) and
 * extracts Instrument Approach Procedure (IAP) records for seeding DynamoDB.
 *
 * Source: https://nfdc.faa.gov/webContent/dtpp/current.xml  (28-day cycle)
 * Definitions: https://aeronav.faa.gov/dtpp/Metafile_XML_Definitions.pdf
 *
 * Usage:
 *   node scripts/parse-dtpp.mjs
 *
 * Output:
 *   src/data/iaps.json   — full records for DynamoDB seeding
 *
 * XML structure:
 *   <digital_tpp cycle="2601">
 *     <state_code ID="TX">
 *       <city_name ID="AUSTIN">
 *         <airport_name ID="AUSTIN-BERGSTROM INTL" apt_ident="AUS" icao_ident="KAUS">
 *           <record>
 *             <chart_code>IAP</chart_code>
 *             <chart_name>ILS OR LOC RWY 17L</chart_name>
 *             <pdf_name>09095IL17L.PDF</pdf_name>
 *             <amdtnum>12A</amdtnum>
 *             <amdtdate>1/19/2023</amdtdate>
 *           </record>
 *         </airport_name>
 *       </city_name>
 *     </state_code>
 *   </digital_tpp>
 */

import { readFileSync, writeFileSync } from "fs";
import { parseStringPromise } from "xml2js";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const INPUT_FILE =
  args[0] ?? path.join(__dirname, "nasr", "d-TPP_Metafile.xml");
const OUTPUT_FILE = args[1] ?? path.join(__dirname, "data/iaps.json");

// ── Nav type derivation ───────────────────────────────────────────────────────
// Derived from procedure name patterns per FAA naming conventions.
// Order matters — more specific patterns must come before general ones.

function deriveNavType(chartName) {
  const n = chartName.toUpperCase();

  if (n.includes("ILS") && n.includes("LOC")) return "ILS"; // ILS OR LOC
  if (n.includes("ILS")) return "ILS";
  if (n.includes("LPV")) return "LPV";
  if (n.includes("LOC/DME")) return "LOC";
  if (n.includes("LOC BC") || n.includes("LBC")) return "LOC_BC";
  if (n.includes("LOC")) return "LOC";
  if (n.includes("RNAV (RNP)")) return "RNAV";
  if (n.includes("RNAV (GPS)")) return "LNAV"; // will be refined by minima later
  if (n.includes("RNAV")) return "RNAV";
  if (n.includes("VOR/DME")) return "VOR_DME";
  if (n.includes("VOR")) return "VOR";
  if (n.includes("NDB/DME")) return "NDB";
  if (n.includes("NDB")) return "NDB";
  if (n.includes("TACAN")) return "TACAN";
  if (n.includes("VISUAL") || n.includes("CVFP")) return "VISUAL";

  return "RNAV"; // fallback
}

// ILS and LPV are precision (or precision-like) approaches
function deriveIsPrecision(navType) {
  return navType === "ILS" || navType === "LPV";
}

// Extract runway from procedure name (e.g. "ILS OR LOC RWY 17L" → "17L")
// Returns "ALL" for circling-only approaches
function extractRunway(chartName) {
  // Circling approach: ends without a runway designation
  if (/CIRCLING$/i.test(chartName.trim())) return "ALL";

  // Match "RWY 17L", "RWY 35", "RWY 04R", etc.
  const rwyMatch = chartName.match(/RWY\s+(\d{1,2}[LRC]?)/i);
  if (rwyMatch) return rwyMatch[1].toUpperCase();

  // Some approaches say "RUNWAY 35" instead of "RWY 35"
  const rwyMatch2 = chartName.match(/RUNWAY\s+(\d{1,2}[LRC]?)/i);
  if (rwyMatch2) return rwyMatch2[1].toUpperCase();

  return "ALL"; // circling or indeterminate
}

function extractSuffix(chartName) {
  // Suffix letter: "RNAV (GPS) Y RWY 35" → "Y", "RNAV (GPS) Z RWY 17R" → "Z"
  const match = chartName.match(/\)\s+([A-Z])\s+RWY/i);
  return match ? match[1].toUpperCase() : null;
}

function isCircling(runway) {
  return runway === "ALL";
}

// ── PDF chart URL ─────────────────────────────────────────────────────────────
// d-TPP PDFs are served at a cycle-specific URL:
// https://aeronav.faa.gov/d-tpp/<CYCLE>/<PDF_NAME>
// We store just the pdf_name and reconstruct the URL at query time,
// since the cycle changes every 28 days.

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Reading ${INPUT_FILE}...`);
  const xml = readFileSync(INPUT_FILE, "utf-8");

  console.log("Parsing XML...");
  const result = await parseStringPromise(xml, {
    explicitArray: false,
    trim: true,
    mergeAttrs: false,
  });

  const root = result.digital_tpp;
  const cycle = root.$.cycle; // e.g. "2601"
  console.log(`Cycle: ${cycle}`);

  const iaps = [];
  let skipped = 0;
  let total = 0;

  const states = Array.isArray(root.state_code)
    ? root.state_code
    : [root.state_code];

  for (const state of states) {
    const cities = state.city_name
      ? Array.isArray(state.city_name)
        ? state.city_name
        : [state.city_name]
      : [];

    for (const city of cities) {
      const airports = city.airport_name
        ? Array.isArray(city.airport_name)
          ? city.airport_name
          : [city.airport_name]
        : [];

      for (const airport of airports) {
        const attrs = airport.$;
        const aptIdent = attrs.apt_ident?.trim() || "";
        const icaoIdent = attrs.icao_ident?.trim() || "";

        // Skip if no FAA identifier
        if (!aptIdent) continue;

        const records = airport.record
          ? Array.isArray(airport.record)
            ? airport.record
            : [airport.record]
          : [];

        for (const rec of records) {
          total++;

          // Only process IAP (Instrument Approach Procedure) records
          const chartCode = rec.chart_code?.trim() || "";
          if (chartCode !== "IAP") {
            skipped++;
            continue;
          }

          const chartName = rec.chart_name?.trim() || "";
          const pdfName = rec.pdf_name?.trim() || "";
          const amdtnum = rec.amdtnum?.trim() || null;
          const amdtdate = rec.amdtdate?.trim() || null;

          const navType = deriveNavType(chartName);
          const runway = extractRunway(chartName);
          const suffix = extractSuffix(chartName);

          iaps.push({
            // Airport identifiers (denormalized for convenience)
            airportId: icaoIdent || aptIdent,
            faaAptIdent: aptIdent,
            icaoIdent: icaoIdent || null,

            // Procedure
            procedureName: chartName,
            runway,
            suffix,

            // Nav type classification
            navType,
            isPrecision: deriveIsPrecision(navType),
            isCircling: isCircling(runway),

            // Minima — not available in metafile, left null for now
            straightInDaMsl: null,
            straightInVisSm: null,
            straightInRvrFt: null,
            circlingMdaMsl: null,
            circlingVisSm: null,

            // Equipment — not available in metafile
            approachLighting: null,
            hasTdzl: null,
            hasCl: null,
            hasGlideslope: navType === "ILS" || navType === "LPV" || null,
            hasLocalizer: ["ILS", "LOC", "LOC_BC"].includes(navType) || null,
            dmeRequired: null,
            radarRequired: null,

            // Chart metadata
            pdfName,
            chartCycle: cycle,
            amdtnum,
            amdtdate,

            // NASR metadata (cycle date derived from d-TPP cycle)
            nasrSiteNo: null, // populated during seeding by joining to airport table
            nasrCycleDate: formatCycleDate(cycle),
          });
        }
      }
    }
  }

  console.log(`\nResults:`);
  console.log(`  Total records:   ${total.toLocaleString()}`);
  console.log(`  IAP records:     ${iaps.length.toLocaleString()}`);
  console.log(`  Skipped (non-IAP): ${skipped.toLocaleString()}`);

  // Summary by nav type
  const byNavType = {};
  for (const iap of iaps) {
    byNavType[iap.navType] = (byNavType[iap.navType] || 0) + 1;
  }
  console.log("\nBy nav type:");
  for (const [type, count] of Object.entries(byNavType).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${type.padEnd(12)} ${count.toLocaleString()}`);
  }

  writeFileSync(OUTPUT_FILE, JSON.stringify(iaps, null, 2));
  console.log(
    `\nWrote ${iaps.length.toLocaleString()} IAP records to ${OUTPUT_FILE}`,
  );
}

// Convert cycle like "2601" → approximate NASR date "2026-01-XX"
// The exact date comes from the XML root element's from_edate attribute,
// but we use cycle as a best-effort fallback.
function formatCycleDate(cycle) {
  const year = `20${cycle.slice(0, 2)}`;
  return `${year}-cycle-${cycle.slice(2)}`;
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
