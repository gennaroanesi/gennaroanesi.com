export type VerdictType = "go" | "caution" | "nogo";
export type RiskLevel = "LOW" | "MED" | "HIGH";
export type WindowRec = "IDEAL" | "MARGINAL" | "AVOID" | "RETURN";
export type TrendType = "improving" | "stable" | "deteriorating";

export interface WxStation {
  icao: string;
  label: string;
  ceiling: string;
  ceilingClass: "go" | "warn" | "stop";
  detail: string;
  trend: TrendType;
  trendNote: string;
}

export interface CurrencyItem {
  label: string;
  sub: string;
  value: string;
  valueClass: "ok" | "warn" | "bad";
  note?: string;
}

export interface RiskItem {
  icon: string;
  title: string;
  detail: string;
  level: RiskLevel;
}

export interface WindowItem {
  time: string;
  condition: string;
  fillPct: number;
  status: "go" | "warn" | "stop";
  rec: WindowRec;
  star?: boolean;
}

export interface AlternateItem {
  icao: string;
  name: string;
  distance: string;
  wx: string;
  wxClass: "ok" | "warn";
}

export interface DispatchBriefData {
  pilot: { name: string; cert: string; aircraft: string; type: string };
  trip: {
    from: string;
    to: string;
    date: string;
    depart: string;
    returnTime: string;
    aircraft: string;
    route: string;
  };
  verdict: VerdictType;
  verdictSummary: string;
  verdictSub: string;
  confidence: number;
  briefText: string;
  weather: WxStation[];
  wxAdvisory: string;
  currency: CurrencyItem[];
  windows: WindowItem[];
  risks: RiskItem[];
  alternates: AlternateItem[];
  releaseId: string;
  generatedAt: string;
  validUntil: string;
}
