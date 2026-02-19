import React, { useState } from "react";
import s from "./Dispatch.module.css";
import type { DispatchBriefData } from "./types";
import {
  TripBar,
  WeatherCard,
  CurrencyCard,
  WindowsCard,
  RiskCard,
  AlternatesCard,
} from "./DispatchComponents";

interface Props {
  data: DispatchBriefData;
}

export default function DispatchBrief({ data }: Props) {
  const [acknowledged, setAcknowledged] = useState(false);

  const verdictClass =
    data.verdict === "go"
      ? s.verdictGo
      : data.verdict === "caution"
      ? s.verdictCaution
      : s.verdictNogo;

  const barClass =
    data.verdict === "go" ? s.barGo : data.verdict === "caution" ? s.barCaution : s.barNogo;

  const labelClass =
    data.verdict === "go"
      ? s.labelGo
      : data.verdict === "caution"
      ? s.labelCaution
      : s.labelNogo;

  const verdictWord =
    data.verdict === "go" ? "GO" : data.verdict === "caution" ? "CAUTION" : "NO-GO";

  return (
    <div className={s.wrap}>
      <div className={s.container}>

        {/* ── Header ── */}
        <div className={s.header}>
          <div>
            <div className={s.logo}>
              DISPATCH<span className={s.logoAccent}>.</span>
            </div>
            <div className={s.tagline}>AI Flight Dispatcher · Personal Aviation</div>
          </div>
          <div className={s.headerRight}>
            <div className={s.pilotLabel}>PILOT // CERTIFICATE</div>
            <div className={s.pilotCert}>
              {data.pilot.name} · {data.pilot.cert} · {data.pilot.aircraft} · {data.pilot.type}
            </div>
          </div>
        </div>

        {/* ── Trip Bar ── */}
        <TripBar
          from={data.trip.from}
          to={data.trip.to}
          date={data.trip.date}
          depart={data.trip.depart}
          returnTime={data.trip.returnTime}
          aircraft={data.trip.aircraft}
          route={data.trip.route}
        />

        {/* ── Verdict ── */}
        <div className={`${s.verdict} ${verdictClass}`}>
          <div className={`${s.verdictBar} ${barClass}`} />
          <div className={`${s.verdictLabel} ${labelClass}`}>{verdictWord}</div>
          <div className={s.verdictBody}>
            <div className={s.verdictSummary}>
              {data.verdictSummary.split("**").map((part, i) =>
                i % 2 === 1 ? (
                  <strong key={i} className={s.verdictSummaryWarn}>{part}</strong>
                ) : (
                  part
                )
              )}
            </div>
            <div className={s.verdictSub}>{data.verdictSub}</div>
          </div>
          <div className={s.confidence}>
            <div className={s.confidenceNum}>{data.confidence}%</div>
            <div className={s.confidenceLabel}>Confidence</div>
          </div>
        </div>

        {/* ── AI Brief ── */}
        <div className={`${s.aiBrief} ${s.mb16}`}>
          <div className={s.aiBriefText}>
            {data.briefText.split(/(\*\*[^*]+\*\*|~~[^~]+~~)/).map((part, i) => {
              if (part.startsWith("**") && part.endsWith("**"))
                return <span key={i} className={s.highlightGo}>{part.slice(2, -2)}</span>;
              if (part.startsWith("~~") && part.endsWith("~~"))
                return <strong key={i} className={s.highlightWarn}>{part.slice(2, -2)}</strong>;
              return part;
            })}
          </div>
        </div>

        {/* ── Weather + Currency ── */}
        <div className={s.grid2}>
          <WeatherCard stations={data.weather} advisory={data.wxAdvisory} />
          <CurrencyCard items={data.currency} />
        </div>

        {/* ── Windows + Risk ── */}
        <div className={s.grid2}>
          <WindowsCard windows={data.windows} />
          <RiskCard risks={data.risks} />
        </div>

        {/* ── Alternates ── */}
        <AlternatesCard alternates={data.alternates} />

        {/* ── Dispatch Release ── */}
        <div className={s.release}>
          <div className={s.releaseText}>
            DISPATCH RELEASE · {data.releaseId}<br />
            This brief is advisory only. Pilot-in-command retains full authority and responsibility
            per FAR 91.3. By acknowledging, you confirm you have reviewed this brief and accept PIC
            responsibility for the flight.
          </div>
          <button
            className={`${s.releaseBtn} ${acknowledged ? s.releaseBtnAck : ""}`}
            onClick={() => setAcknowledged(true)}
          >
            {acknowledged ? "✓ ACKNOWLEDGED" : "ACKNOWLEDGE BRIEF"}
          </button>
        </div>

        {/* ── Footer ── */}
        <div className={s.footer}>
          <div className={s.footerLeft}>
            DISPATCH · AI FLIGHT DISPATCHER<br />
            BRIEF GENERATED {data.generatedAt} · DATA: FAA AWC, ADDS, NTSB ASRS<br />
            VALID UNTIL {data.validUntil}
          </div>
          <div className={s.footerDisclaimer}>
            This service provides decision support only. Not a substitute for a certified dispatcher
            or official weather briefing. Always obtain a standard weather briefing via
            1800wxbrief.com or equivalent.
          </div>
        </div>

      </div>
    </div>
  );
}
