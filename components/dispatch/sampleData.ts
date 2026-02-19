import type { DispatchBriefData } from "./types";

export const sampleBrief: DispatchBriefData = {
  pilot: {
    name: "Sarah Chen",
    cert: "PPL/IR",
    aircraft: "N4821K",
    type: "C172",
  },
  trip: {
    from: "KSQL",
    to: "KMRY",
    date: "SAT 22 FEB",
    depart: "0900L",
    returnTime: "1400L",
    aircraft: "C172 IFR",
    route: "Direct · 67nm",
  },
  verdict: "caution",
  verdictSummary:
    "Departure window at 0900L places you in IMC for ~8 min post-takeoff. Marine layer forecast OVC006 at KSQL, lifting to BKN015 by 1030L. **Recommended departure: 1045L.**",
  verdictSub:
    "BASED ON YOUR HISTORY: 2 PRIOR DIVERSIONS IN SIMILAR CONDITIONS · PERSONAL MINS 800FT / 2SM · LAST IFR FLIGHT 18 DAYS AGO",
  confidence: 74,
  briefText:
    "Saturday morning looks workable, but not at 0900. The coastal marine layer at San Carlos is forecast OVC006 at departure time — that puts you in the soup immediately after rotation with a ceiling below your personal minimums of 800ft. You've been here twice before and diverted both times, which is exactly the right call. The good news: **the layer burns off quickly Saturday**. By 1045L, TAF shows BKN015 with 10SM visibility, winds 290@08. That's a clean departure and a comfortable window to make Monterey for a late breakfast. The return leg at 1400L looks excellent — KMRY clear all afternoon, no coastal penetration required southbound. I'd file IFR both legs for the marine layer buffer, block out 1045L, and you have a solid day.",
  weather: [
    {
      icao: "KSQL",
      label: "Departure",
      ceiling: "OVC006",
      ceilingClass: "warn",
      detail: "1/4SM · FG · TEMPO OVC002",
      trend: "improving",
      trendNote: "Lifts ~1030L",
    },
    {
      icao: "KMRY",
      label: "Destination",
      ceiling: "SKC",
      ceilingClass: "go",
      detail: "10SM · Winds 290@12",
      trend: "stable",
      trendNote: "Clear all day",
    },
  ],
  wxAdvisory:
    "⚠ AIRMET SIERRA: IFR conditions coastal CA, marine layer, valid until 1200Z. Tops 2500ft MSL.",
  currency: [
    {
      label: "IFR Currency",
      sub: "6 approaches req. in last 6mo",
      value: "6 approaches",
      valueClass: "warn",
      note: "EXPIRES IN 23 DAYS",
    },
    {
      label: "Recent Flight Activity",
      sub: "Last flight logged",
      value: "18 days ago",
      valueClass: "ok",
    },
    {
      label: "Personal Minimums",
      sub: "Self-declared",
      value: "800ft / 2SM",
      valueClass: "ok",
    },
    {
      label: "This Route History",
      sub: "KSQL–KMRY flown before",
      value: "2 prior diversions",
      valueClass: "warn",
      note: "SIMILAR CONDITIONS",
    },
    {
      label: "Total Time",
      sub: "Logged hours",
      value: "342 hrs · 47 IMC",
      valueClass: "ok",
    },
  ],
  windows: [
    { time: "0900", condition: "OVC006 / FG",   fillPct: 85, status: "stop", rec: "AVOID"    },
    { time: "1000", condition: "OVC010 / 3SM",  fillPct: 55, status: "warn", rec: "MARGINAL"  },
    { time: "1045", condition: "BKN015 / 10SM", fillPct: 20, status: "go",   rec: "IDEAL", star: true },
    { time: "1200", condition: "SKC / 10SM",    fillPct: 10, status: "go",   rec: "IDEAL"    },
    { time: "1400", condition: "SKC / 10SM",    fillPct: 8,  status: "go",   rec: "RETURN"   },
  ],
  risks: [
    {
      icon: "⚠",
      title: "Marine Layer Below Personal Mins",
      detail: "OVC006 at 0900L vs your 800ft minimum. Ceiling below personal limits at planned departure.",
      level: "HIGH",
    },
    {
      icon: "⚠",
      title: "IFR Currency Expiring Soon",
      detail: "Legally current, but expires in 23 days. Consider logging approaches on this flight.",
      level: "MED",
    },
    {
      icon: "◈",
      title: "Route Familiarity",
      detail: "You've flown KSQL–KMRY 7 times. Familiar with coastal marine layer behavior on this route.",
      level: "LOW",
    },
    {
      icon: "◈",
      title: "Aircraft & Systems",
      detail: "N4821K annual current. No MEL items. IFR equipped and legal.",
      level: "LOW",
    },
    {
      icon: "◈",
      title: "Destination & Alternates",
      detail: "KMRY clear all afternoon. KSNS 20nm SE as solid alternate.",
      level: "LOW",
    },
  ],
  alternates: [
    { icao: "KSNS", name: "Salinas Municipal · Primary Alternate", distance: "20nm SE of KMRY", wx: "SKC / 10SM",              wxClass: "ok"   },
    { icao: "KWVI", name: "Watsonville Muni",                       distance: "22nm NE of KMRY", wx: "BKN040 / 8SM",            wxClass: "ok"   },
    { icao: "KOAK", name: "Oakland International · Return Divert",  distance: "40nm N of KSQL",  wx: "OVC010 / 3SM · Marine layer", wxClass: "warn" },
  ],
  releaseId: "N4821K · KSQL–KMRY · 22 FEB 2025",
  generatedAt: "0612L",
  validUntil: "1200L SAT 22 FEB 2025",
};
