import React from "react";
import s from "./Dispatch.module.css";
import type {
  WxStation,
  CurrencyItem,
  RiskItem,
  WindowItem,
  AlternateItem,
  TrendType,
} from "./types";

// ─── Shared ──────────────────────────────────────────────────────────────────

export const StatusDot = ({ status }: { status: "go" | "warn" | "ok" }) => (
  <span className={`${s.dot} ${status === "go" ? s.dotGo : status === "warn" ? s.dotWarn : s.dotOk}`} />
);

// ─── Trip Bar ─────────────────────────────────────────────────────────────────

interface TripBarProps {
  from: string;
  to: string;
  date: string;
  depart: string;
  returnTime: string;
  aircraft: string;
  route: string;
}

export const TripBar = ({ from, to, date, depart, returnTime, aircraft, route }: TripBarProps) => (
  <div className={s.tripBar}>
    <div className={s.airportPair}>
      <span className={s.airport}>{from}</span>
      <span className={s.arrow}>→</span>
      <span className={s.airport}>{to}</span>
    </div>
    <div className={s.tripMeta}>
      {[
        { label: "Date", value: date },
        { label: "Depart", value: depart },
        { label: "Return", value: returnTime },
        { label: "Aircraft", value: aircraft },
        { label: "Route", value: route },
      ].map((m) => (
        <div key={m.label} className={s.metaItem}>
          <span className={s.metaLabel}>{m.label}</span>
          <span className={s.metaValue}>{m.value}</span>
        </div>
      ))}
    </div>
  </div>
);

// ─── Weather Card ─────────────────────────────────────────────────────────────

const trendClass = (t: TrendType) =>
  t === "improving" ? s.trendImproving : t === "stable" ? s.trendStable : s.trendWorse;

const trendLabel = (t: TrendType) =>
  t === "improving" ? "↑ IMPROVING" : t === "stable" ? "● STABLE" : "↓ WORSENING";

export const WeatherCard = ({ stations, advisory }: { stations: WxStation[]; advisory: string }) => (
  <div className={s.card}>
    <div className={s.cardHeader}>
      <span className={s.cardTitle}>Weather Analysis</span>
      <StatusDot status="warn" />
    </div>
    {stations.map((st, i) => (
      <React.Fragment key={st.icao}>
        <div className={s.wxRow}>
          <div>
            <div className={s.wxStation}>{st.icao} · {st.label}</div>
            <div className={`${s.wxCeiling} ${st.ceilingClass === "go" ? s.wxGo : st.ceilingClass === "warn" ? s.wxWarn : s.wxStop}`}>
              {st.ceiling}
            </div>
            <div className={s.wxDetail}>{st.detail}</div>
          </div>
          <div className={s.wxRight}>
            <div className={`${s.wxTrend} ${trendClass(st.trend)}`}>{trendLabel(st.trend)}</div>
            <div className={s.wxDetail} style={{ marginTop: 6 }}>{st.trendNote}</div>
          </div>
        </div>
        {i < stations.length - 1 && <hr className={s.wxDivider} />}
      </React.Fragment>
    ))}
    <hr className={s.wxDivider} />
    <div className={s.wxAdvisory}>{advisory}</div>
  </div>
);

// ─── Currency Card ────────────────────────────────────────────────────────────

export const CurrencyCard = ({ items }: { items: CurrencyItem[] }) => (
  <div className={s.card}>
    <div className={s.cardHeader}>
      <span className={s.cardTitle}>Pilot Currency & Profile</span>
      <StatusDot status="warn" />
    </div>
    {items.map((item) => (
      <div key={item.label} className={s.currencyItem}>
        <div>
          <div className={s.currencyLabel}>{item.label}</div>
          <div className={s.currencySub}>{item.sub}</div>
        </div>
        <div className={`${s.currencyValue} ${item.valueClass === "ok" ? s.valOk : item.valueClass === "warn" ? s.valWarn : s.valBad}`}>
          {item.value}
          {item.note && <span className={s.currencyNote}>{item.note}</span>}
        </div>
      </div>
    ))}
  </div>
);

// ─── Departure Windows ────────────────────────────────────────────────────────

const recClass = (r: WindowItem["rec"]) =>
  r === "IDEAL" || r === "RETURN" ? s.recIdeal : r === "MARGINAL" ? s.recOk : s.recAvoid;

export const WindowsCard = ({ windows }: { windows: WindowItem[] }) => (
  <div className={s.card}>
    <div className={s.cardHeader}>
      <span className={s.cardTitle}>Departure Windows</span>
      <StatusDot status="ok" />
    </div>
    {windows.map((w) => (
      <div key={w.time} className={s.windowItem}>
        <span
          className={s.windowTime}
          style={{ color: w.status === "go" ? "#00e87a" : w.status === "warn" ? "#f5a623" : "#ff4757" }}
        >
          {w.time}
        </span>
        <div className={s.windowBar}>
          <div
            className={`${s.windowFill} ${w.status === "go" ? s.fillGo : w.status === "warn" ? s.fillWarn : s.fillStop}`}
            style={{ width: `${w.fillPct}%` }}
          />
        </div>
        <span
          className={s.windowLabel}
          style={{ color: w.status === "go" ? "#00e87a" : w.status === "warn" ? "#f5a623" : "#ff4757" }}
        >
          {w.condition}
        </span>
        <span className={`${s.windowRec} ${recClass(w.rec)}`}>
          {w.star ? `★ ${w.rec}` : w.rec}
        </span>
      </div>
    ))}
  </div>
);

// ─── Risk Card ────────────────────────────────────────────────────────────────

export const RiskCard = ({ risks }: { risks: RiskItem[] }) => (
  <div className={s.card}>
    <div className={s.cardHeader}>
      <span className={s.cardTitle}>Risk Factors</span>
      <StatusDot status="warn" />
    </div>
    {risks.map((r) => (
      <div key={r.title} className={s.riskItem}>
        <span className={s.riskIcon}>{r.icon}</span>
        <div className={s.riskText}>
          <div className={s.riskTitle}>{r.title}</div>
          <div className={s.riskDetail}>{r.detail}</div>
        </div>
        <span className={`${s.riskLevel} ${r.level === "LOW" ? s.levelLow : r.level === "MED" ? s.levelMed : s.levelHigh}`}>
          {r.level}
        </span>
      </div>
    ))}
  </div>
);

// ─── Alternates Card ──────────────────────────────────────────────────────────

export const AlternatesCard = ({ alternates }: { alternates: AlternateItem[] }) => (
  <div className={`${s.card} ${s.mb16}`}>
    <div className={s.cardHeader}>
      <span className={s.cardTitle}>Alternates & Divert Options</span>
      <StatusDot status="ok" />
    </div>
    {alternates.map((a) => (
      <div key={a.icao} className={s.altItem}>
        <span className={s.altIcao}>{a.icao}</span>
        <span className={s.altName}>{a.name}</span>
        <span className={s.altDist}>{a.distance}</span>
        <span className={`${s.altWx} ${a.wxClass === "ok" ? s.valOk : s.valWarn}`}>{a.wx}</span>
      </div>
    ))}
  </div>
);
