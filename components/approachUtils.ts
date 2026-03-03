/**
 * approachUtils.ts
 *
 * Maps ForeFlight approachTypes strings to CIFP procedure identifiers,
 * and provides types for the approach visualization data.
 */

export type ApproachFix = {
  seq: string;
  fixId: string;
  pathTerm: string;
  role: string;  // IAF, IF, FAF, MAP, MAH, or ""
  lat: number | null;
  lon: number | null;
  alt1: string | null;
  alt2: string | null;
};

export type ApproachProcedureRecord = {
  id: string;
  icao: string;
  procedure: string;
  transition: string | null;
  fixes: ApproachFix[];
};

export type ParsedApproach = {
  /** Original ForeFlight string e.g. "RNAV (GPS) RWY 18" */
  label: string;
  /** Airport ICAO e.g. "KGTU" */
  icao: string;
  /** CIFP procedure code e.g. "R18" */
  procedure: string;
};

/**
 * Parse a ForeFlight approachTypes string into structured approach objects.
 * Input: "RNAV (GPS) RWY 18@KGTU, ILS OR LOC RWY 33@KGRK"
 */
export function parseApproachTypes(approachTypes: string | null): ParsedApproach[] {
  if (!approachTypes) return [];
  return approachTypes
    .split(", ")
    .map((entry) => {
      const atIdx = entry.lastIndexOf("@");
      if (atIdx === -1) return null;
      const label = entry.slice(0, atIdx).trim();
      const icao = entry.slice(atIdx + 1).trim();
      const procedure = foreflight2cifp(label, icao);
      if (!procedure) return null;
      return { label, icao, procedure };
    })
    .filter((x): x is ParsedApproach => x !== null);
}

/**
 * Convert a ForeFlight procedure name to a CIFP procedure identifier.
 *
 * ForeFlight format examples:
 *   "RNAV (GPS) RWY 18"     → "R18"
 *   "RNAV (GPS) Y RWY 18"   → "R18"   (suffix ignored for now)
 *   "ILS OR LOC RWY 33"     → "I33"
 *   "ILS RWY 19"            → "I19"
 *   "LOC RWY 35"            → "L35"
 *   "LOC (BACK CRS) RWY 17" → "B17"
 *   "VOR RWY 14"            → "R14"   (some fields use R prefix)
 *   "VOR-A"                 → "VOR-A"
 *   "VOR DME-A"             → "VDM-A"
 *   "VOR DME RWY 32"        → "D32"
 *   "NDB RWY 17"            → "N17"
 *   "LDA RWY 28"            → "X28"
 *   "SDF RWY 22"            → "U22"
 *   "LOC@KTPL"              → "L16"  (can't know runway without CIFP lookup)
 *   "TACAN RWY 33"          → "T33"
 */
export function foreflight2cifp(label: string, _icao: string): string | null {
  const s = label.trim().toUpperCase();

  // RNAV / GPS
  const rnavMatch = s.match(/RNAV.*?RWY\s+(\d{1,2}[LRC]?)/);
  if (rnavMatch) return `R${rnavMatch[1]}`;

  // ILS or ILS OR LOC
  const ilsMatch = s.match(/^ILS(?:\s+OR\s+LOC)?\s+RWY\s+(\d{1,2}[LRC]?)/);
  if (ilsMatch) return `I${ilsMatch[1]}`;

  // LOC Back Course
  const locBcMatch = s.match(/LOC\s+\(BACK\s+CRS\)\s+RWY\s+(\d{1,2}[LRC]?)/);
  if (locBcMatch) return `B${locBcMatch[1]}`;

  // LOC with runway
  const locMatch = s.match(/^LOC\s+RWY\s+(\d{1,2}[LRC]?)/);
  if (locMatch) return `L${locMatch[1]}`;

  // LOC without runway (e.g. "LOC@KTPL") — can't resolve without DB
  if (s === "LOC") return null; // caller should handle fallback

  // VOR DME with runway
  const vorDmeRwyMatch = s.match(/^VOR\s+DME\s+RWY\s+(\d{1,2}[LRC]?)/);
  if (vorDmeRwyMatch) return `D${vorDmeRwyMatch[1]}`;

  // VOR DME circling (e.g. "VOR DME-A")
  const vorDmeCircMatch = s.match(/^VOR\s+DME-([A-Z])/);
  if (vorDmeCircMatch) return `VDM-${vorDmeCircMatch[1]}`;

  // VOR with runway
  const vorRwyMatch = s.match(/^VOR\s+RWY\s+(\d{1,2}[LRC]?)/);
  if (vorRwyMatch) return `R${vorRwyMatch[1]}`;

  // VOR circling (e.g. "VOR-A", "VOR/DME-A")
  const vorCircMatch = s.match(/^VOR(?:\/DME)?-([A-Z])/);
  if (vorCircMatch) return `VOR-${vorCircMatch[1]}`;

  // NDB
  const ndbMatch = s.match(/^NDB\s+RWY\s+(\d{1,2}[LRC]?)/);
  if (ndbMatch) return `N${ndbMatch[1]}`;

  // TACAN
  const tacanMatch = s.match(/^TACAN\s+RWY\s+(\d{1,2}[LRC]?)/);
  if (tacanMatch) return `T${tacanMatch[1]}`;

  // LDA
  const ldaMatch = s.match(/^LDA\s+RWY\s+(\d{1,2}[LRC]?)/);
  if (ldaMatch) return `X${ldaMatch[1]}`;

  // SDF
  const sdfMatch = s.match(/^SDF\s+RWY\s+(\d{1,2}[LRC]?)/);
  if (sdfMatch) return `U${sdfMatch[1]}`;

  return null;
}
