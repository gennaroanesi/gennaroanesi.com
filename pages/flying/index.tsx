import React, { useEffect, useState, useCallback, useRef } from "react";
import Head from "next/head";
import dynamic from "next/dynamic";
import { generateClient } from "aws-amplify/data";
import { getUrl } from "aws-amplify/storage";
import type { Schema } from "@/amplify/data/resource";
import DefaultLayout from "@/layouts/default";
import type { Flight, AirportMarker, ActiveApproach, TrackPoint } from "@/components/CesiumGlobe";
import { interpolateTrack } from "@/components/CesiumGlobe";
import { parseApproachTypes, extractApproachIcaos } from "@/components/approachUtils";
import { flightColor } from "@/components/flightColors";
import type { ApproachFix } from "@/components/approachUtils";

const CesiumGlobe = dynamic(() => import("@/components/CesiumGlobe"), { ssr: false });

// ── Labels ────────────────────────────────────────────────────────────────────

const FLIGHT_TYPE_LABEL: Record<string, string> = {
  TRAINING:      "Training",
  SOLO:          "Solo",
  CROSS_COUNTRY: "Cross-Country",
  CHECKRIDE:     "Checkride",
  INTRO:         "Intro",
  OTHER:         "Other",
};

// ── Amplify client ────────────────────────────────────────────────────────────

const client = generateClient<Schema>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(h: number | null) {
  if (h == null || h === 0) return "—";
  return `${h.toFixed(1)}h`;
}

function groupByYear(flights: Flight[]) {
  const groups: Record<string, Flight[]> = {};
  for (const f of flights) {
    const year = f.date.slice(0, 4);
    if (!groups[year]) groups[year] = [];
    groups[year].push(f);
  }
  return Object.entries(groups).sort(([a], [b]) => Number(b) - Number(a));
}

// "YYYY-MM" | null
type MonthFilter = string | null;

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Returns sorted unique "YYYY-MM" strings present in the flight list
function flightMonths(flights: Flight[]): string[] {
  const set = new Set(flights.map((f) => f.date.slice(0, 7)));
  return [...set].sort((a, b) => b.localeCompare(a));
}

// "last90" is a rolling-window sentinel; everything else is a "YYYY-MM" prefix
// matching f.date. null = no filter (all flights ever).
const LAST_90_FILTER = "last90";

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function filterFlights(flights: Flight[], filter: MonthFilter): Flight[] {
  if (!filter) return flights;
  if (filter === LAST_90_FILTER) {
    const cutoff = isoDaysAgo(90);
    return flights.filter((f) => f.date >= cutoff);
  }
  return flights.filter((f) => f.date.startsWith(filter));
}

// ── Video thumbnail extraction ──────────────────────────────────────────────
// Cache thumbnails in memory so we only seek each video once.
const thumbnailCache = new Map<string, string>(); // signedUrl → dataURL

function useThumbnail(signedUrl: string): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(
    () => thumbnailCache.get(signedUrl) ?? null
  );

  useEffect(() => {
    if (thumbnailCache.has(signedUrl)) {
      setDataUrl(thumbnailCache.get(signedUrl)!);
      return;
    }
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    const onSeeked = () => {
      const canvas = document.createElement("canvas");
      canvas.width  = video.videoWidth  || 320;
      canvas.height = video.videoHeight || 180;
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", 0.7);
      thumbnailCache.set(signedUrl, url);
      setDataUrl(url);
      video.src = "";
    };
    const onLoadedMetadata = () => { video.currentTime = 1; };
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("seeked", onSeeked);
    video.src = signedUrl;
    return () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("seeked", onSeeked);
      video.src = "";
    };
  }, [signedUrl]);

  return dataUrl;
}

// ── Featured videos ───────────────────────────────────────────────────────────
export type FeaturedVideo = {
  id: string;
  flightId: string;
  signedUrl: string;
  label: string | null;
  camera: string | null;
  sortOrder: number | null;
  kmlOffsetSec: number | null;
  featured: boolean | null;
};

// ── Stats ─────────────────────────────────────────────────────────────────────

function useFlightStats(flights: Flight[]) {
  const totalHours = flights.reduce((s, f) => s + (f.totalTime ?? 0), 0);
  const picHours   = flights.reduce((s, f) => s + (f.pic ?? 0), 0);
  const xcHours    = flights.reduce((s, f) => s + (f.crossCountry ?? 0), 0);
  const nightHours = flights.reduce((s, f) => s + (f.night ?? 0), 0);
  const imcHours   = flights.reduce((s, f) => s + (f.actualIMC ?? 0), 0);
  const totalAppr  = flights.reduce((s, f) => s + (f.approaches ?? 0), 0);
  const airports   = new Set([
    ...flights.map((f) => f.from),
    ...flights.map((f) => f.to),
  ].filter(Boolean)).size;

  return [
    { label: "Flights",    value: String(flights.length) },
    { label: "Total",      value: `${totalHours.toFixed(1)}h` },
    { label: "PIC",        value: `${picHours.toFixed(1)}h` },
    { label: "XC",         value: `${xcHours.toFixed(1)}h` },
    { label: "Night",      value: `${nightHours.toFixed(1)}h` },
    { label: "IMC",        value: `${imcHours.toFixed(1)}h` },
    { label: "Approaches", value: String(totalAppr) },
  ];
}

const BUCKET_NAME = "gennaroanesi.com";

// ── TrackPiP — map + vertical profile overlaid on the video ──────────────────
const NM_TO_DEG_LAT = 1 / 60;
const PIP_HALF_EXTENT_NM = 3.5;

// Derive instantaneous heading (degrees true) and ground speed (knots)
// by looking at the track segment surrounding `t`.
function deriveDynamics(track: TrackPoint[], t: number): { headingDeg: number; groundSpeedKt: number; vsFpm: number; gradDeg: number } | null {
  if (track.length < 2) return null;
  // Find surrounding points
  let lo = 0, hi = track.length - 1;
  if (t <= track[0].t) { lo = 0; hi = 1; }
  else if (t >= track[hi].t) { lo = hi - 1; }
  else {
    let l = 0, h = hi;
    while (h - l > 1) { const m = (l + h) >> 1; if (track[m].t <= t) l = m; else h = m; }
    lo = l; hi = h;
  }
  const a = track[lo], b = track[hi];
  const dt = b.t - a.t;
  if (dt < 0.5) return null; // too close — noisy
  const dLat = b.lat - a.lat;
  const dLon = b.lon - a.lon;
  const cosLat = Math.cos((a.lat * Math.PI) / 180);
  // Heading
  const headingRad = Math.atan2(dLon * cosLat, dLat);
  const headingDeg = ((headingRad * 180) / Math.PI + 360) % 360;
  // Ground speed: convert deg difference to nm then to kt
  const distNm = Math.sqrt((dLat * 60) ** 2 + (dLon * 60 * cosLat) ** 2);
  const groundSpeedKt = (distNm / dt) * 3600;
  // Vertical speed
  const dAltFt = (b.alt - a.alt) * 3.28084;
  const vsFpm = (dAltFt / dt) * 60;
  // Gradient: arctan(vertical / horizontal distance)
  const distFt = distNm * 6076.12;
  const gradDeg = distFt > 0 ? Math.atan2(dAltFt, distFt) * 180 / Math.PI : 0;
  return { headingDeg, groundSpeedKt, vsFpm, gradDeg };
}

// Approach fix dot colors — mirrors CesiumGlobe constants
const PIP_FIX_COLORS: Record<string, string> = {
  IAF: "#facc15",
  FAF: "#f97316",
  MAP: "#ef4444",
};
const PIP_FIX_DEFAULT = "#93c5fd";

function TrackPiP({
  track, currentTrackSec, color = "#facc15", mobileMapOnly = false, mobileProfileOnly = false,
  approachFixes = [],
}: {
  track: TrackPoint[];
  currentTrackSec: number;
  color?: string;
  mobileMapOnly?: boolean;
  mobileProfileOnly?: boolean;
  approachFixes?: ApproachFix[];
}) {
  // ── Panel dimensions (desktop PiP)
  const MW = 190, MH = 130, PAD = 10;
  const VW = 190, VH = 130, VPAD = 10;

  // Current interpolated position
  const pos = interpolateTrack(track, currentTrackSec);
  const dynamics = deriveDynamics(track, currentTrackSec);

  // ── Map geometry
  const halfLat = PIP_HALF_EXTENT_NM * NM_TO_DEG_LAT;
  const halfLon = pos
    ? PIP_HALF_EXTENT_NM * NM_TO_DEG_LAT / Math.cos((pos.lat * Math.PI) / 180)
    : halfLat;
  const centerLat = pos?.lat ?? (track[0].lat + track[track.length - 1].lat) / 2;
  const centerLon = pos?.lon ?? (track[0].lon + track[track.length - 1].lon) / 2;
  const minLat = centerLat - halfLat, maxLat = centerLat + halfLat;
  const minLon = centerLon - halfLon, maxLon = centerLon + halfLon;
  const latRange = maxLat - minLat, lonRange = maxLon - minLon;
  const innerW = MW - PAD * 2, innerH = MH - PAD * 2;
  const scale  = Math.min(innerW / lonRange, innerH / latRange);
  const offX   = PAD + (innerW - lonRange * scale) / 2;
  const offY   = PAD + (innerH - latRange * scale) / 2;
  const toSvg = (lat: number, lon: number) => ({
    x: offX + (lon - minLon) * scale,
    y: offY + (maxLat - lat) * scale,
  });
  // Project approach fixes into the same SVG space — only those with valid coords
  const validFixes = approachFixes.filter((f) => f.lat !== null && f.lon !== null);
  const fixSvgPts = validFixes.map((f) => toSvg(f.lat!, f.lon!));

  if (approachFixes.length > 0 || validFixes.length > 0) {
    console.log(`[TrackPiP] approachFixes received: ${approachFixes.length}, valid (have coords): ${validFixes.length}`);
    validFixes.forEach((fix, i) => {
      const pt = fixSvgPts[i];
      const inBounds = pt.x >= 0 && pt.x <= MW && pt.y >= 0 && pt.y <= MH;
      console.log(`  [${i}] ${fix.fixId.padEnd(6)} role=${(fix.role || '—').padEnd(3)} lat=${fix.lat?.toFixed(4)} lon=${fix.lon?.toFixed(4)} → svg(${pt.x.toFixed(1)}, ${pt.y.toFixed(1)}) ${inBounds ? '✓ in bounds' : '✗ OUT OF BOUNDS'}`);
    });
    console.log(`  map viewport: lon[${minLon.toFixed(4)}…${maxLon.toFixed(4)}] lat[${minLat.toFixed(4)}…${maxLat.toFixed(4)}] scale=${scale.toFixed(1)} center=(${centerLat.toFixed(4)}, ${centerLon.toFixed(4)})`);
  } else {
    console.log('[TrackPiP] no approachFixes passed');
  }

  const pts = track.map((p) => { const s = toSvg(p.lat, p.lon); return `${s.x},${s.y}`; }).join(" ");
  const flownIdx = track.findIndex((p) => p.t > currentTrackSec);
  const flownPts = (flownIdx === -1 ? track : track.slice(0, flownIdx + 1))
    .map((p) => { const s = toSvg(p.lat, p.lon); return `${s.x},${s.y}`; }).join(" ");
  const dot = pos ? toSvg(pos.lat, pos.lon) : null;

  // ── Vertical profile geometry — same time window as the map (±half-extent at current GS, min 5min)
  // Use a fixed ±5 minute window centred on currentTrackSec so it matches what
  // the map is showing rather than spanning the entire flight.
  const windowSec = 5 * 60; // 5 minutes each side
  const vTMin = Math.max(track[0].t, currentTrackSec - windowSec);
  const vTMax = Math.min(track[track.length - 1].t, currentTrackSec + windowSec);
  const vTrack = track.filter((p) => p.t >= vTMin && p.t <= vTMax);
  const vTrackSafe = vTrack.length > 1 ? vTrack : track; // fallback
  const altValues = vTrackSafe.map((p) => p.alt);
  const minAlt = Math.min(...altValues);
  const maxAlt = Math.max(...altValues);
  const altRange = maxAlt - minAlt || 30; // min 30m range so flat segments don't blow up
  const tMin = vTrackSafe[0].t, tMax = vTrackSafe[vTrackSafe.length - 1].t;
  const tRange = tMax - tMin || 1;
  const ALT_LABEL_H = 32; // px reserved at top for the altitude + VS + gradient readout
  const vInnerW = VW - VPAD * 2, vInnerH = VH - VPAD - ALT_LABEL_H;
  const toVSvg = (t: number, alt: number) => ({
    x: VPAD + ((t - tMin) / tRange) * vInnerW,
    y: ALT_LABEL_H + (1 - (alt - minAlt) / altRange) * vInnerH,
  });
  const vPts = vTrackSafe.map((p) => { const s = toVSvg(p.t, p.alt); return `${s.x},${s.y}`; }).join(" ");
  const vFlownInWindow = vTrackSafe.filter((p) => p.t <= currentTrackSec);
  const vFlownPts = vFlownInWindow.length > 0
    ? vFlownInWindow.map((p) => { const s = toVSvg(p.t, p.alt); return `${s.x},${s.y}`; }).join(" ")
    : "";
  const vDot = pos ? toVSvg(currentTrackSec, pos.alt) : null;
  const altFt = pos ? pos.alt * 3.28084 : null;

  // Heading arrow direction
  const arrowAngle = dynamics ? dynamics.headingDeg : 0;

  // ── Mobile single-panel renders (fill the flex-1 container passed by VideoChip) ──
  if (mobileMapOnly) {
    return (
      <svg width="100%" height={MH} viewBox={`0 0 ${MW} ${MH}`} preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
        <polyline points={pts} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={flownPts} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
        {dot && (
          <>
            <circle cx={dot.x} cy={dot.y} r={6} fill={color} opacity={0.25} />
            <circle cx={dot.x} cy={dot.y} r={3.5} fill={color} />
            <circle cx={dot.x} cy={dot.y} r={3.5} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={1} />
            {dynamics && (() => {
              const rad = (arrowAngle - 90) * Math.PI / 180;
              return <line x1={dot.x} y1={dot.y} x2={dot.x + Math.cos(rad) * 12} y2={dot.y + Math.sin(rad) * 12} stroke={color} strokeWidth={1.5} strokeLinecap="round" opacity={0.9} />;
            })()}
          </>
        )}
        {/* Approach waypoints */}
        {fixSvgPts.map((pt, i) => {
          const fix = validFixes[i];
          const dotColor = PIP_FIX_COLORS[fix.role] ?? PIP_FIX_DEFAULT;
          const isKey = !!fix.role;
          return (
            <g key={`fix-${fix.fixId}-${i}`}>
              <circle cx={pt.x} cy={pt.y} r={isKey ? 4 : 2.5}
                fill={dotColor} opacity={0.9}
                stroke="rgba(0,0,0,0.7)" strokeWidth={1} />
              {isKey && (
                <text x={pt.x + 5} y={pt.y + 3.5} fontSize={7} fill={dotColor}
                  fontFamily="monospace" fontWeight="bold"
                  stroke="rgba(0,0,0,0.8)" strokeWidth={2} paintOrder="stroke">
                  {fix.fixId}
                </text>
              )}
            </g>
          );
        })}
        {dynamics && (
          <>
            <text x={7} y={18} fontSize={13} fill={color} fontFamily="monospace" fontWeight="bold">
              {Math.round(dynamics.headingDeg).toString().padStart(3, "0")}°
            </text>
            <text x={7} y={33} fontSize={12} fill="rgba(255,255,255,0.6)" fontFamily="monospace">
              {Math.round(dynamics.groundSpeedKt)}kt
            </text>
          </>
        )}
      </svg>
    );
  }

  if (mobileProfileOnly) {
    return (
      <svg width="100%" height={VH} viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
        <polyline
          points={vPts + ` ${VPAD + vInnerW},${ALT_LABEL_H + vInnerH} ${VPAD},${ALT_LABEL_H + vInnerH}`}
          fill={color + "18"} stroke="none"
        />
        <polyline points={vPts} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={vFlownPts} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
        {vDot && (
          <>
            <circle cx={vDot.x} cy={vDot.y} r={4} fill={color} opacity={0.25} />
            <circle cx={vDot.x} cy={vDot.y} r={2.5} fill={color} />
          </>
        )}
        {altFt !== null && (
          <>
            <text x={7} y={17} fontSize={11} fill={color} fontFamily="monospace" fontWeight="bold">
              {Math.round(altFt).toLocaleString()}ft
            </text>
            {dynamics && (
              <text x={7} y={29} fontSize={10} fill="rgba(255,255,255,0.5)" fontFamily="monospace">
                {dynamics.vsFpm >= 0 ? "+" : ""}{Math.round(dynamics.vsFpm)}fpm · {dynamics.gradDeg >= 0 ? "+" : ""}{dynamics.gradDeg.toFixed(1)}°
              </text>
            )}
          </>
        )}
        <text x={VW - VPAD} y={ALT_LABEL_H + vInnerH} fontSize={9} fill="rgba(255,255,255,0.3)" fontFamily="monospace" textAnchor="end">
          {Math.round(minAlt * 3.28084).toLocaleString()}ft
        </text>
        <text x={VW - VPAD} y={ALT_LABEL_H + 9} fontSize={9} fill="rgba(255,255,255,0.3)" fontFamily="monospace" textAnchor="end">
          {Math.round(maxAlt * 3.28084).toLocaleString()}ft
        </text>
      </svg>
    );
  }

  return (
    <div
      className="absolute bottom-3 right-3 flex flex-col gap-1.5 pointer-events-none"
    >
      {/* ── Map panel ── */}
      <div
        className="rounded-lg overflow-hidden"
        style={{
          width: MW, height: MH,
          background: "rgba(15,20,35,0.82)",
          backdropFilter: "blur(6px)",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
        }}
      >
        <svg width={MW} height={MH} style={{ display: "block" }}>
          {/* Full track */}
          <polyline points={pts} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
          {/* Flown */}
          <polyline points={flownPts} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
          {/* Dot */}
          {dot && (
            <>
              <circle cx={dot.x} cy={dot.y} r={6} fill={color} opacity={0.25} />
              <circle cx={dot.x} cy={dot.y} r={3.5} fill={color} />
              <circle cx={dot.x} cy={dot.y} r={3.5} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={1} />
              {/* Heading arrow */}
              {dynamics && (() => {
                const rad = (arrowAngle - 90) * Math.PI / 180;
                const len = 12;
                const x2 = dot.x + Math.cos(rad) * len;
                const y2 = dot.y + Math.sin(rad) * len;
                return <line x1={dot.x} y1={dot.y} x2={x2} y2={y2} stroke={color} strokeWidth={1.5} strokeLinecap="round" opacity={0.9} />;
              })()}
            </>
          )}
            {/* Approach waypoints */}
          {fixSvgPts.map((pt, i) => {
            const fix = validFixes[i];
            const dotColor = PIP_FIX_COLORS[fix.role] ?? PIP_FIX_DEFAULT;
            const isKey = !!fix.role;
            return (
              <g key={`fix-${fix.fixId}-${i}`}>
                <circle cx={pt.x} cy={pt.y} r={isKey ? 4.5 : 3} fill={dotColor} opacity={0.9}
                  stroke="rgba(0,0,0,0.6)" strokeWidth={1} />
                {isKey && (
                  <text x={pt.x + 6} y={pt.y + 4} fontSize={8} fill={dotColor}
                    fontFamily="monospace" fontWeight="bold"
                    style={{ textShadow: "0 0 3px #000" }}>
                    {fix.fixId}
                  </text>
                )}
              </g>
            );
          })}
          {/* HUD: heading + GS */}
          {dynamics && (
            <>
              <text x={7} y={18} fontSize={13} fill={color} fontFamily="monospace" fontWeight="bold">
                {Math.round(dynamics.headingDeg).toString().padStart(3, "0")}°
              </text>
              <text x={7} y={33} fontSize={12} fill="rgba(255,255,255,0.6)" fontFamily="monospace">
                {Math.round(dynamics.groundSpeedKt)}kt
              </text>
            </>
          )}
        </svg>
      </div>

      {/* ── Vertical profile panel ── */}
      <div
        className="rounded-lg overflow-hidden"
        style={{
          width: VW, height: VH,
          background: "rgba(15,20,35,0.82)",
          backdropFilter: "blur(6px)",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
        }}
      >
        <svg width={VW} height={VH} style={{ display: "block" }}>
          {/* Filled area under profile */}
          <polyline
            points={vPts + ` ${VPAD + vInnerW},${ALT_LABEL_H + vInnerH} ${VPAD},${ALT_LABEL_H + vInnerH}`}
            fill={color + "18"}
            stroke="none"
          />
          {/* Full profile line */}
          <polyline points={vPts} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
          {/* Flown portion */}
          <polyline points={vFlownPts} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
          {/* Current altitude dot */}
          {vDot && (
            <>
              <circle cx={vDot.x} cy={vDot.y} r={4} fill={color} opacity={0.25} />
              <circle cx={vDot.x} cy={vDot.y} r={2.5} fill={color} />
            </>
          )}
          {/* Altitude + VS + gradient label row */}
          {altFt !== null && (
            <>
              <text x={7} y={17} fontSize={11} fill={color} fontFamily="monospace" fontWeight="bold">
                {Math.round(altFt).toLocaleString()}ft
              </text>
              {dynamics && (
                <text x={7} y={29} fontSize={10} fill="rgba(255,255,255,0.5)" fontFamily="monospace">
                  {dynamics.vsFpm >= 0 ? "+" : ""}{Math.round(dynamics.vsFpm)}fpm · {dynamics.gradDeg >= 0 ? "+" : ""}{dynamics.gradDeg.toFixed(1)}°
                </text>
              )}
            </>
          )}
          {/* Min/max labels */}
          <text x={VW - VPAD} y={ALT_LABEL_H + vInnerH} fontSize={9} fill="rgba(255,255,255,0.3)" fontFamily="monospace" textAnchor="end">
            {Math.round(minAlt * 3.28084).toLocaleString()}ft
          </text>
          <text x={VW - VPAD} y={ALT_LABEL_H + 9} fontSize={9} fill="rgba(255,255,255,0.3)" fontFamily="monospace" textAnchor="end">
            {Math.round(maxAlt * 3.28084).toLocaleString()}ft
          </text>
        </svg>
      </div>
    </div>
  );
}

// ── VideoChip ───────────────────────────────────────────────────────────────────
function VideoChip({
  video, size = "md", track, approachFixes = [], onPlaneTime,
}: {
  video: FeaturedVideo;
  size?: "sm" | "md";
  track?: TrackPoint[];
  approachFixes?: ApproachFix[];
  onPlaneTime?: (trackSec: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [currentTrackSec, setCurrentTrackSec] = useState(0);
  const [isMobile, setIsMobile] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef   = useRef<number>(0);
  const label = video.label ?? video.camera ?? "Video";

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Drive the plane cursor + PiP via rAF while the modal is open.
  // Update on every frame so cursor stays put even when paused;
  // only clear on modal close.
  // kmlOffsetSec is track-relative t (seconds from track[0]) — use directly.
  const trackOffsetSec = React.useMemo(() => {
    if (video.kmlOffsetSec == null || !track || track.length === 0) return null;
    return video.kmlOffsetSec;
  }, [video.kmlOffsetSec, track]);

  useEffect(() => {
    if (!open || trackOffsetSec == null) return;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        const ts = trackOffsetSec + v.currentTime;
        onPlaneTime?.(ts);
        setCurrentTrackSec(ts);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafRef.current);
      onPlaneTime?.(null);
    };
  }, [open, trackOffsetSec, onPlaneTime]);

  const handleClose = () => {
    setOpen(false);
    onPlaneTime?.(null);
  };

  const hasPiP = !!track && track.length > 1 && trackOffsetSec != null;
  const thumbnail = useThumbnail(video.signedUrl);

  // Card dimensions
  const cardW = size === "sm" ? 96  : 120;
  const cardH = size === "sm" ? 54  : 68;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="shrink-0 flex flex-col rounded overflow-hidden border border-darkBorder
          hover:border-gold/40 transition-all group"
        style={{ width: cardW }}
      >
        {/* Thumbnail */}
        <div className="relative w-full overflow-hidden bg-darkBg" style={{ height: cardH }}>
          {thumbnail
            ? <img src={thumbnail} alt={label} className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
                  className="text-gray-700">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              </div>
          }
          {/* Play overlay */}
          <div className="absolute inset-0 flex items-center justify-center
            opacity-0 group-hover:opacity-100 transition-opacity
            bg-black/30">
            <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center backdrop-blur-sm">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="white">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            </div>
          </div>
        </div>
        {/* Title */}
        <div className="px-1.5 py-1 bg-darkSurface w-full">
          <span className={`block truncate text-left ${
            size === "sm" ? "text-[9px]" : "text-[10px]"
          } text-gray-500 group-hover:text-gray-300 transition-colors font-mono`}>
            {label}
          </span>
        </div>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={handleClose}
        >
          {isMobile ? (
            // ── Mobile: video + panels pinned to bottom of screen ──
            <div className="fixed inset-0 flex flex-col bg-black" onClick={(e) => e.stopPropagation()}>
              <button onClick={handleClose} className="absolute top-3 right-3 z-10 text-gray-400 hover:text-gray-200 text-sm leading-none">✕</button>
              {/* Video grows to fill remaining space above panels */}
              <video
                ref={videoRef}
                src={video.signedUrl}
                controls
                autoPlay
                playsInline
                className="w-full bg-black"
                style={{ flex: 1, minHeight: 0, objectFit: "contain" }}
              />
              {/* Panels pinned to bottom */}
              {hasPiP && (
                <div className="flex gap-2 px-2 py-2 shrink-0" style={{ background: "rgba(10,14,26,0.98)", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                  <div className="flex-1 rounded-lg overflow-hidden" style={{ background: "rgba(15,20,35,1)", border: "1px solid rgba(255,255,255,0.08)" }}>
                    <TrackPiP track={track!} currentTrackSec={currentTrackSec} approachFixes={approachFixes} mobileMapOnly />
                  </div>
                  <div className="flex-1 rounded-lg overflow-hidden" style={{ background: "rgba(15,20,35,1)", border: "1px solid rgba(255,255,255,0.08)" }}>
                    <TrackPiP track={track!} currentTrackSec={currentTrackSec} mobileProfileOnly />
                  </div>
                </div>
              )}
            </div>
          ) : (
            // ── Desktop: PiP overlay ──
            <div className="relative max-w-2xl w-full mx-8" onClick={(e) => e.stopPropagation()}>
              <button onClick={handleClose} className="absolute -top-8 right-0 text-gray-400 hover:text-gray-200 text-sm">
                ✕ close
              </button>
              <div className="relative">
                <video
                  ref={videoRef}
                  src={video.signedUrl}
                  controls
                  autoPlay
                  playsInline
                  className="w-full rounded-lg border border-darkBorder block"
                />
                {hasPiP && (
                  <TrackPiP
                    track={track!}
                    currentTrackSec={currentTrackSec}
                    approachFixes={approachFixes}
                  />
                )}
              </div>
              {video.label && (
                <p className="text-xs text-gray-500 font-mono mt-2 text-center">{video.label}</p>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ── Desktop header panel (stats + videos + filter) ───────────────────────────
function DesktopHeader({
  allFlights, filteredFlights, monthFilter, onMonthChange, videos, getTrack, getApproachFixes, onPlaneTime,
}: {
  allFlights: Flight[];
  filteredFlights: Flight[];
  monthFilter: MonthFilter;
  onMonthChange: (m: MonthFilter) => void;
  videos: FeaturedVideo[];
  getTrack: (flightId: string) => TrackPoint[] | undefined;
  getApproachFixes: (flightId: string) => ApproachFix[];
  onPlaneTime?: (v: { flightId: string; trackSec: number } | null) => void;
}) {
  const stats  = useFlightStats(filteredFlights);
  const months = flightMonths(allFlights);
  const isFiltered = monthFilter !== null;

  return (
    <div className="shrink-0 border-b border-darkBorder bg-darkSurface">
      {/* ── Stats + highlights + filter — single row ── */}
      <div className="flex items-stretch gap-0 border-b border-darkBorder/60 overflow-x-auto"
        style={{ scrollbarWidth: "none" }}>
        {/* Stat cells */}
        {stats.map(({ label, value }, i) => (
          <div
            key={label}
            className={`flex flex-col items-center justify-center px-5 py-3 shrink-0 min-w-[72px]
              ${ i < stats.length - 1 ? "border-r border-darkBorder/60" : "" }`}
          >
            <span className="text-gold font-mono font-bold text-base leading-none">{value}</span>
            <span className="text-[10px] text-gray-500 uppercase tracking-widest font-mono mt-1 leading-none">{label}</span>
          </div>
        ))}

        {/* Highlights — shown inline when videos exist */}
        {videos.length > 0 && (
          <>
            <div className="w-px bg-darkBorder/60 shrink-0 my-2" />
            <div className="flex items-center gap-3 px-4 py-2 overflow-x-auto shrink-0"
              style={{ scrollbarWidth: "none" }}>
              <span className="text-[10px] font-mono uppercase tracking-widest text-gray-600 shrink-0">Highlights</span>
              {videos.map((v) => (
                <VideoChip
                  key={v.id} video={v}
                  track={getTrack(v.flightId)}
                  approachFixes={getApproachFixes(v.flightId)}
                  onPlaneTime={v.kmlOffsetSec != null
                    ? (t) => onPlaneTime?.(t != null ? { flightId: v.flightId, trackSec: t } : null)
                    : undefined}
                />
              ))}
            </div>
          </>
        )}

        {/* Spacer so filter pills right-align */}
        <div className="flex-1" />

        {/* ── Month filter pills ── */}
        <div className="flex items-center gap-1.5 px-4 overflow-x-auto shrink-0"
          style={{ scrollbarWidth: "none" }}>
          <button
            onClick={() => onMonthChange(null)}
            className={`shrink-0 px-3 py-1 rounded-full text-xs font-mono border transition-all
              ${ monthFilter === null
                ? "bg-gold/15 border-gold/40 text-gold"
                : "border-darkBorder text-gray-500 hover:border-gray-500 hover:text-gray-300" }`}
          >
            All
          </button>
          <button
            onClick={() => onMonthChange(LAST_90_FILTER)}
            className={`shrink-0 px-3 py-1 rounded-full text-xs font-mono border transition-all
              ${ monthFilter === LAST_90_FILTER
                ? "bg-gold/15 border-gold/40 text-gold"
                : "border-darkBorder text-gray-500 hover:border-gray-500 hover:text-gray-300" }`}
          >
            Last 90d
          </button>
          {months.map((m) => {
            const [y, mo] = m.split("-");
            const label = `${MONTH_NAMES[Number(mo) - 1]} ${y}`;
            const active = monthFilter === m;
            return (
              <button
                key={m}
                onClick={() => onMonthChange(active ? null : m)}
                className={`shrink-0 px-3 py-1 rounded-full text-xs font-mono border transition-all
                  ${ active
                    ? "bg-gold/15 border-gold/40 text-gold"
                    : "border-darkBorder text-gray-500 hover:border-gray-500 hover:text-gray-300" }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Mobile header (stats pills + filter + videos) — inside the drawer ────────
function MobileHeader({
  allFlights, filteredFlights, monthFilter, onMonthChange, videos, getTrack, getApproachFixes, onPlaneTime,
}: {
  allFlights: Flight[];
  filteredFlights: Flight[];
  monthFilter: MonthFilter;
  onMonthChange: (m: MonthFilter) => void;
  videos: FeaturedVideo[];
  getTrack: (flightId: string) => TrackPoint[] | undefined;
  getApproachFixes: (flightId: string) => ApproachFix[];
  onPlaneTime?: (v: { flightId: string; trackSec: number } | null) => void;
}) {
  const stats  = useFlightStats(filteredFlights);
  const months = flightMonths(allFlights);
  const isFiltered = monthFilter !== null;

  return (
    <div className="shrink-0 border-b border-darkBorder bg-darkBg">
      {/* Stats pills */}
      <div
        className="flex gap-2 px-4 py-2.5 overflow-x-auto"
        style={{ WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}
      >
        {stats.map(({ label, value }) => (
          <div
            key={label}
            className="flex flex-col items-center shrink-0 px-3 py-1.5
              bg-darkSurface border border-darkBorder rounded-lg min-w-[56px]"
          >
            <span className="text-gold font-mono font-bold text-xs leading-tight">{value}</span>
            <span className="text-[9px] text-gray-600 uppercase tracking-widest font-mono mt-0.5 leading-tight">{label}</span>
          </div>
        ))}
      </div>

      {/* Month filter pills */}
      <div
        className="flex gap-1.5 px-4 pb-2.5 overflow-x-auto"
        style={{ WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}
      >
        <button
          onClick={() => onMonthChange(null)}
          className={`shrink-0 px-2.5 py-0.5 rounded-full text-[10px] font-mono border transition-all
            ${ monthFilter === null
              ? "bg-gold/15 border-gold/40 text-gold"
              : "border-darkBorder text-gray-600 hover:text-gray-400" }`}
        >
          All
        </button>
        <button
          onClick={() => onMonthChange(LAST_90_FILTER)}
          className={`shrink-0 px-2.5 py-0.5 rounded-full text-[10px] font-mono border transition-all
            ${ monthFilter === LAST_90_FILTER
              ? "bg-gold/15 border-gold/40 text-gold"
              : "border-darkBorder text-gray-600 hover:text-gray-400" }`}
        >
          Last 90d
        </button>
        {months.map((m) => {
          const [y, mo] = m.split("-");
          const label = `${MONTH_NAMES[Number(mo) - 1]} '${y.slice(2)}`;
          const active = monthFilter === m;
          return (
            <button
              key={m}
              onClick={() => onMonthChange(active ? null : m)}
              className={`shrink-0 px-2.5 py-0.5 rounded-full text-[10px] font-mono border transition-all
                ${ active
                  ? "bg-gold/15 border-gold/40 text-gold"
                  : "border-darkBorder text-gray-600 hover:text-gray-400" }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Featured videos — only when present */}
      {videos.length > 0 && (
        <div
          className="flex gap-2 px-4 pb-2.5 overflow-x-auto"
          style={{ WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}
        >
          {videos.map((v) => (
            <VideoChip
              key={v.id} video={v} size="sm"
              track={getTrack(v.flightId)}
              approachFixes={getApproachFixes(v.flightId)}
              onPlaneTime={v.kmlOffsetSec != null
                ? (t) => onPlaneTime?.(t != null ? { flightId: v.flightId, trackSec: t } : null)
                : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Flight list row ───────────────────────────────────────────────────────────

function FlightRow({ flight, selected, colorIndex, onClick }: {
  flight: Flight; selected: boolean; colorIndex: number; onClick: () => void;
}) {
  const color = flightColor(colorIndex);
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 border-b border-darkBorder transition-all duration-150 border-l-2 ${
        selected ? "bg-darkElevated" : "hover:bg-white/[0.03] border-l-transparent"
      }`}
      style={{ borderLeftColor: selected ? color : undefined }}
    >
      <div className="flex justify-between items-start gap-2">
        {/* Left: swatch + text */}
        <div className="flex items-stretch gap-2.5 min-w-0">
          <div
            className="w-1 shrink-0 rounded-full"
            style={{ backgroundColor: color, minHeight: "1.2rem", opacity: flight.kmlS3Key ? 1 : 0.3 }}
          />
          <div className="min-w-0">
            <div className="text-xs font-mono text-gray-500 mb-0.5">{flight.date}</div>
            <div className="text-sm font-semibold text-gray-100 truncate">
              {flight.from} — {flight.to}
            </div>
            {flight.milestone && (
              <div className="text-xs text-gold mt-0.5">★ {flight.milestone}</div>
            )}
            {flight.title && !flight.milestone && (
              <div className="text-xs text-gray-500 truncate mt-0.5">{flight.title}</div>
            )}
            {flight.route && (
              <div className="text-xs font-mono text-gray-600 truncate mt-0.5 tracking-wide">
                {flight.route}
              </div>
            )}
          </div>
        </div>
        {/* Right: time + type */}
        <div className="flex flex-col items-end shrink-0 gap-0.5">
          <span className="text-xs font-mono text-gray-400">{fmt(flight.totalTime)}</span>
          {flight.flightType && (
            <span className="text-xs text-gray-600">
              {FLIGHT_TYPE_LABEL[flight.flightType] ?? flight.flightType}
            </span>
          )}
          {flight.conditions === "IMC" && (
            <span className="text-xs text-blue-400 font-semibold">IMC</span>
          )}
        </div>
      </div>
    </button>
  );
}

// ── Approach chip ─────────────────────────────────────────────────────────────

// S3 base for publicly-accessible chart PDFs
const CHART_BASE = "https://gennaroanesi.com.s3.amazonaws.com/public/flights/charts/";

// Match a chart key to an approach by procedure type prefix in the filename.
// d-TPP names loosely follow: ILS->il*, VOR->v*, RNAV->rn*/r*, NDB->nd*
// Single-approach: always returns the one key. Multi-approach: best-effort.
function chartUrlForApproach(
  approachChartKeys: string[] | null | undefined,
  label: string,
): string | null {
  if (!approachChartKeys || approachChartKeys.length === 0) return null;

  if (approachChartKeys.length === 1) {
    const filename = approachChartKeys[0].split("/").pop();
    return filename ? `${CHART_BASE}${filename}` : null;
  }

  // Multi-approach: try to match by procedure type prefix in filename
  const upper = label.toUpperCase();
  const prefixHints: [string, string[]][] = [
    ["ILS",  ["il"]],
    ["LOC",  ["lo"]],
    ["RNAV", ["rn", "r0", "r1", "r2", "r3"]],
    ["VOR",  ["vo", "v0", "v1", "v2", "v3"]],
    ["NDB",  ["nd", "n0", "n1"]],
  ];

  for (const [type, prefixes] of prefixHints) {
    if (!upper.includes(type)) continue;
    const match = approachChartKeys.find((k) => {
      const f = k.split("/").pop()?.toLowerCase() ?? "";
      return prefixes.some((p) => f.startsWith(p));
    });
    if (match) {
      const filename = match.split("/").pop();
      return filename ? `${CHART_BASE}${filename}` : null;
    }
  }

  // Fallback: first key
  const filename = approachChartKeys[0].split("/").pop();
  return filename ? `${CHART_BASE}${filename}` : null;
}

type ApproachChipProps = {
  label: string;
  procedure: string;
  loading: boolean;
  active: boolean;
  unavailable: boolean;
  chartUrl: string | null;
  onClick: () => void;
};

function ApproachChip({ label, procedure, loading, active, unavailable, chartUrl, onClick }: ApproachChipProps) {
  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={onClick}
        disabled={unavailable || loading}
        title={unavailable ? "No CIFP data for this procedure" : label}
        className={`flex flex-col items-start px-2.5 py-1.5 rounded border text-left transition-all
          ${active
            ? "bg-blue-900/60 border-blue-400/60 text-blue-300"
            : unavailable
            ? "border-gray-800 text-gray-700 cursor-not-allowed"
            : loading
            ? "border-gray-700 text-gray-600 animate-pulse cursor-wait"
            : "border-darkBorder hover:border-blue-500/40 hover:bg-blue-950/30 text-gray-400 hover:text-blue-300"
          }`}
      >
        <span className="text-xs font-mono font-bold">{procedure}</span>
        <span className="text-[10px] leading-tight truncate max-w-[130px]">{label}</span>
      </button>
      {chartUrl && (
        <a
          href={chartUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono
            text-amber-500/70 hover:text-amber-400 border border-amber-900/40
            hover:border-amber-600/50 transition-colors bg-amber-950/20 w-fit"
          title="View archived FAA approach chart (PDF)"
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          chart
        </a>
      )}
    </div>
  );
}

// ── Flight detail panel ───────────────────────────────────────────────────────

type FlightDetailProps = {
  flight: Flight;
  activeApproachKey: string | null;
  approachLoading: string | null;
  unavailableApproaches: Set<string>;
  onApproachClick: (icao: string, procedure: string, label: string) => void;
  onClose: () => void;
  videos?: FeaturedVideo[];
  getTrack?: (flightId: string) => TrackPoint[] | undefined;
  getApproachFixes?: (flightId: string) => ApproachFix[];
  onPlaneTime?: (v: { flightId: string; trackSec: number } | null) => void;
};

function FlightDetail({
  flight, activeApproachKey, approachLoading, unavailableApproaches,
  onApproachClick, onClose, videos = [], getTrack, getApproachFixes, onPlaneTime,
}: FlightDetailProps) {
  const flightVideos = videos.filter((v) => v.flightId === flight.id);
  const approaches = parseApproachTypes(flight.approachTypes);

  const stats: [string, string | number][] = [
    ["Total",         fmt(flight.totalTime)],
    ["Cross-Country", fmt(flight.crossCountry)],
    ["Solo",          fmt(flight.solo)],
    ["Night",         fmt(flight.night)],
    ["Actual IMC",    fmt(flight.actualIMC)],
    ["Sim. IMC",      fmt(flight.simulatedIMC)],
    ["Dual Recv.",    fmt(flight.dualReceived)],
    ["Day Ldgs",      flight.dayLandings ?? "—"],
    ["Night Ldgs",    flight.nightLandings ?? "—"],
    ["Approaches",    flight.approaches ?? "—"],
  ].filter(([, v]) => v !== "—") as [string, string | number][];

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-darkBorder sticky top-0 bg-darkSurface z-10">
        <span className="text-xs font-mono text-gray-500 uppercase tracking-widest">Flight Detail</span>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xs transition-colors">
          ✕ back
        </button>
      </div>

      <div className="flex flex-col gap-4 p-5">
        {/* Header */}
        <div>
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className="text-xs font-mono text-gray-500 tracking-wider">{flight.date}</span>
            {flight.conditions && (
              <span className={`text-xs font-mono px-1.5 py-0.5 rounded border
                ${flight.conditions === "IMC"
                  ? "border-blue-500/50 text-blue-400"
                  : flight.conditions === "IFR"
                  ? "border-indigo-500/50 text-indigo-400"
                  : "border-gray-600 text-gray-500"}`}>
                {flight.conditions}
              </span>
            )}
            {flight.flightType && (
              <span className="text-xs text-gray-600">
                {FLIGHT_TYPE_LABEL[flight.flightType]}
              </span>
            )}
          </div>
          <h2 className="text-lg font-bold text-gray-100 leading-snug">
            {flight.title ?? `${flight.from} → ${flight.to}`}
          </h2>
          {flight.title && (
            <p className="text-sm text-gray-500 mt-0.5">{flight.from} → {flight.to}</p>
          )}
          {flight.milestone && (
            <div className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1
              bg-gold/10 border border-gold/30 rounded text-gold text-xs font-semibold tracking-wide">
              ★ {flight.milestone}
            </div>
          )}
        </div>

        {/* Aircraft */}
        {(flight.aircraftId || flight.aircraftType) && (
          <div className="flex gap-2 items-center text-sm">
            {flight.aircraftId && (
              <span className="font-mono text-gray-300 bg-darkBg px-2 py-0.5 rounded border border-darkBorder">
                {flight.aircraftId}
              </span>
            )}
            {flight.aircraftType && (
              <span className="text-gray-500">{flight.aircraftType}</span>
            )}
          </div>
        )}

        {/* Route */}
        {flight.route && (
          <div className="font-mono text-xs text-gray-500 bg-darkBg rounded px-3 py-2 border border-darkBorder leading-relaxed break-all">
            {flight.route}
          </div>
        )}

        {/* Approaches section */}
        {approaches.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-2 font-mono">
              Approaches flown
            </p>
            <div className="flex flex-wrap gap-2">
              {approaches.map((appr) => {
                const key = `${appr.icao}|${appr.procedure}`;
                const chartUrl = chartUrlForApproach(flight.approachChartKeys, appr.label);
                return (
                  <ApproachChip
                    key={key}
                    label={appr.label}
                    procedure={`${appr.icao} ${appr.procedure}`}
                    loading={approachLoading === key}
                    active={activeApproachKey === key}
                    unavailable={unavailableApproaches.has(key)}
                    chartUrl={chartUrl}
                    onClick={() => onApproachClick(appr.icao, appr.procedure, appr.label)}
                  />
                );
              })}
            </div>
            {activeApproachKey && (
              <p className="text-[10px] text-blue-400/60 mt-2 font-mono">
                Click again to deselect
              </p>
            )}
          </div>
        )}

        {/* Stats grid */}
        {stats.length > 0 && (
          <div className="grid grid-cols-2 gap-1">
            {stats.map(([label, value]) => (
              <div key={label}
                className="flex justify-between items-center px-3 py-1.5 bg-darkBg rounded border border-darkBorder">
                <span className="text-xs text-gray-600 uppercase tracking-wider">{label}</span>
                <span className="text-xs font-mono font-semibold text-gray-200">{value}</span>
              </div>
            ))}
          </div>
        )}

        {/* Notes */}
        {flight.notes && (
          <p className="text-sm text-gray-400 italic border-l-2 border-gold/30 pl-3 leading-relaxed">
            {flight.notes}
          </p>
        )}

        {/* Videos for this flight */}
        {flightVideos.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-2 font-mono">Videos</p>
            <div className="flex flex-wrap gap-2">
              {flightVideos.map((v) => (
                <VideoChip
                  key={v.id}
                  video={v}
                  track={getTrack?.(v.flightId)}
                  approachFixes={getApproachFixes?.(v.flightId)}
                  onPlaneTime={v.kmlOffsetSec != null
                    ? (t) => onPlaneTime?.(t != null ? { flightId: v.flightId, trackSec: t } : null)
                    : undefined}
                />
              ))}
            </div>
          </div>
        )}

        {!flight.kmlS3Key && (
          <div className="text-xs text-gray-700 text-center py-3 border border-dashed border-darkBorder/50 rounded">
            No GPS track attached
          </div>
        )}
      </div>
    </div>
  );
}

// ── Mobile drawer ─────────────────────────────────────────────────────────────
// Three snap states: peek (just handle), list (half height), detail (full)
type DrawerState = "peek" | "list" | "detail";

function MobileDrawer({
  state, allFlights, flights, loading, selected, selectedId, years,
  monthFilter, onMonthChange, videos, getTrack, getApproachFixes,
  activeApproachKey, approachLoading, unavailableApproaches,
  onApproachClick, onSelect, onClose, onStateChange, onPlaneTime,
}: {
  state: DrawerState;
  allFlights: Flight[];
  flights: Flight[];
  loading: boolean;
  selected: Flight | null;
  selectedId: string | null;
  years: [string, Flight[]][];
  monthFilter: MonthFilter;
  onMonthChange: (m: MonthFilter) => void;
  videos: FeaturedVideo[];
  getTrack: (flightId: string) => TrackPoint[] | undefined;
  getApproachFixes: (flightId: string) => ApproachFix[];
  activeApproachKey: string | null;
  approachLoading: string | null;
  unavailableApproaches: Set<string>;
  onApproachClick: (icao: string, procedure: string, label: string) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  onStateChange: (s: DrawerState) => void;
  onPlaneTime?: (v: { flightId: string; trackSec: number } | null) => void;
}) {
  const PEEK_H   = 72;   // px — drag handle + summary line
  const LIST_H   = 52;   // vh
  const DETAIL_H = 92;   // vh

  const heightMap: Record<DrawerState, string> = {
    peek:   `${PEEK_H}px`,
    list:   `${LIST_H}vh`,
    detail: `${DETAIL_H}vh`,
  };

  // Drag tracking
  const startY    = useRef(0);
  const startH    = useRef(0);
  const drawerRef = useRef<HTMLDivElement>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    startY.current = e.touches[0].clientY;
    startH.current = drawerRef.current?.offsetHeight ?? 0;
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const dy = startY.current - e.changedTouches[0].clientY; // positive = swipe up
    if (Math.abs(dy) < 20) return; // ignore tiny taps
    if (dy > 0) {
      // swipe up → expand
      onStateChange(state === "peek" ? "list" : "detail");
    } else {
      // swipe down → collapse
      onStateChange(state === "detail" ? "list" : "peek");
    }
  };

  return (
    <div
      ref={drawerRef}
      className="absolute bottom-0 left-0 right-0 z-20 flex flex-col bg-darkSurface
        border-t border-darkBorder rounded-t-2xl shadow-2xl
        transition-all duration-300 ease-out overflow-hidden"
      style={{ height: heightMap[state] }}
    >
      {/* Drag handle */}
      <div
        className="flex flex-col items-center pt-2 pb-1 shrink-0 cursor-grab active:cursor-grabbing"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onClick={() => onStateChange(state === "peek" ? "list" : state === "list" ? "peek" : "list")}
      >
        <div className="w-10 h-1 rounded-full bg-gray-600 mb-2" />
        {/* Peek summary */}
        {state === "peek" && (
          <div className="flex items-center justify-between w-full px-4 pb-1">
            {selected ? (
              <span className="text-sm font-semibold text-gray-100">
                {selected.from} → {selected.to}
                <span className="text-xs text-gray-500 ml-2">{selected.date}</span>
              </span>
            ) : (
              <span className="text-xs font-mono text-gray-500 uppercase tracking-widest">
                {loading ? "Loading…" : `${flights.length} flights`}
              </span>
            )}
            <span className="text-gray-600 text-xs">↑ swipe</span>
          </div>
        )}
      </div>

      {/* Content — hidden in peek */}
      {state !== "peek" && (
        <div className="flex-1 overflow-hidden flex flex-col">
          {selected && state === "detail" ? (
            <FlightDetail
              flight={selected}
              activeApproachKey={activeApproachKey}
              approachLoading={approachLoading}
              unavailableApproaches={unavailableApproaches}
              onApproachClick={onApproachClick}
              onClose={onClose}
              videos={videos}
              getTrack={getTrack}
              getApproachFixes={getApproachFixes}
              onPlaneTime={onPlaneTime}
            />
          ) : (
            <div className="flex flex-col h-full overflow-y-auto">
              {/* Header row */}
              <div className="px-4 py-2 border-b border-darkBorder sticky top-0 bg-darkSurface z-10 flex items-center justify-between shrink-0">
                <span className="text-xs font-mono uppercase tracking-widest text-gray-500">Logbook</span>
                {selected && (
                  <button
                    className="text-xs text-gold font-mono"
                    onClick={() => onStateChange("detail")}
                  >
                    {selected.from}→{selected.to} ›
                  </button>
                )}
              </div>

              {/* Stats + filter + videos */}
              {flights.length > 0 && (
                <MobileHeader
                  allFlights={allFlights}
                  filteredFlights={flights}
                  monthFilter={monthFilter}
                  onMonthChange={onMonthChange}
                  videos={videos.filter((v) => v.featured)}
                  getTrack={getTrack}
                  getApproachFixes={getApproachFixes}
                  onPlaneTime={onPlaneTime}
                />
              )}

              {/* Flight list grouped by year */}
              {years.map(([year, yf]) => (
                <div key={year}>
                  <div className="px-4 py-1.5 bg-darkBg border-b border-darkBorder sticky top-[2.25rem] z-[5]">
                    <span className="text-xs font-mono text-gold tracking-widest">
                      {year}
                      <span className="text-gray-600 ml-2 font-normal">
                        {yf.length} flights · {yf.reduce((s, f) => s + (f.totalTime ?? 0), 0).toFixed(1)}h
                      </span>
                    </span>
                  </div>
                  {yf.map((f) => (
                    <FlightRow
                      key={f.id}
                      flight={f}
                      selected={f.id === selectedId}
                      colorIndex={flights.findIndex((x) => x.id === f.id)}
                      onClick={() => { onSelect(f.id); onStateChange("detail"); }}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FlyingPage() {
  const [flights,    setFlights]    = useState<Flight[]>([]);
  const [airports,   setAirports]   = useState<AirportMarker[]>([]);
  const [videos,     setVideos]     = useState<FeaturedVideo[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerState, setDrawerState] = useState<DrawerState>("peek");
  // Default landing view: trailing 90 days. Showing "all flights ever" was
  // overwhelming on first paint; showing "this month" was empty in months
  // without activity. Rolling 90d strikes the balance.
  const [monthFilter, setMonthFilter] = useState<MonthFilter>(LAST_90_FILTER);

  // Approach procedures cache: "ICAO|procedure|transition" -> record
  const approachCache = useRef<Map<string, any>>(new Map());

  // Track data surfaced from CesiumGlobe via onTrackReady — used for PiP mini-maps
  const trackMap = useRef<Map<string, TrackPoint[]>>(new Map());
  const handleTrackReady = useCallback((flightId: string, track: TrackPoint[]) => {
    trackMap.current.set(flightId, track);
  }, []);

  // Plane cursor — driven by the currently-playing video
  const [planeCursor, setPlaneCursor] = useState<{ flightId: string; trackSec: number } | null>(null);

  // Force re-render when tracks load so VideoChips that are already open can pick them up
  const [tracksVersion, setTracksVersion] = useState(0);
  const handleTrackReadyWithRender = useCallback((flightId: string, track: TrackPoint[]) => {
    handleTrackReady(flightId, track);
    setTracksVersion((v) => v + 1);
  }, [handleTrackReady]);

  // Stable getter — reads from ref so it doesn't cause re-renders; tracksVersion keeps it fresh
  const getTrack = useCallback((flightId: string): TrackPoint[] | undefined => {
    void tracksVersion; // reactive dependency so this updates after tracks load
    return trackMap.current.get(flightId);
  }, [tracksVersion]);

  // Return all approach fixes for any approach linked to a given flight,
  // merged across all procedures (e.g. multiple approaches on one flight).
  const getApproachFixes = useCallback((flightId: string): ApproachFix[] => {
    const flight = flights.find((f) => f.id === flightId);
    if (!flight) return [];
    const approaches = parseApproachTypes(flight.approachTypes);
    console.log(`[getApproachFixes] flight=${flightId} approachTypes=${JSON.stringify(flight.approachTypes)}`);
    console.log(`[getApproachFixes] parsed approaches:`, approaches);
    const fixes: ApproachFix[] = [];
    for (const appr of approaches) {
      // Try both with and without empty-string transition key
      const key0 = `${appr.icao}|${appr.procedure}|`;
      const record = approachCache.current.get(key0);
      console.log(`[getApproachFixes]   ${key0} → ${record ? `found (${JSON.parse(record.fixes ?? '[]').length} fixes)` : 'MISS'}`);
      if (!record) {
        // Dump nearby cache keys to help diagnose
        const nearby = [...approachCache.current.keys()].filter((k) => k.startsWith(appr.icao));
        console.log(`[getApproachFixes]   cache keys for ${appr.icao}:`, nearby);
        continue;
      }
      try {
        const parsed: ApproachFix[] = JSON.parse(record.fixes);
        fixes.push(...parsed.filter((f) => f.lat !== null && f.lon !== null));
      } catch { /* malformed */ }
    }
    return fixes;
  }, [flights]);

  // Approach state
  const [activeApproach,         setActiveApproach]         = useState<ActiveApproach | null>(null);
  const [activeApproachKey,      setActiveApproachKey]      = useState<string | null>(null);
  const [approachLoading] = useState<string | null>(null); // unused, kept for chip prop compat
  const [unavailableApproaches,  setUnavailableApproaches]  = useState<Set<string>>(new Set());

  // Flights visible given the current month filter
  const visibleFlights = filterFlights(flights, monthFilter);
  const selected = visibleFlights.find((f) => f.id === selectedId) ?? null;

  // ── Load flights + airports ────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const all: Flight[] = [];
        let token: string | null | undefined;
        do {
          // approachChartKeys must be fetched via raw graphql — Amplify Gen2 typed client
          // drops array fields from .list() unless explicitly selected.
          const listResult = await (client as any).graphql({
            query: `query ListFlights($filter: ModelFlightFilterInput, $limit: Int, $nextToken: String) {
              listFlights(filter: $filter, limit: $limit, nextToken: $nextToken) {
                items {
                  id date from to route aircraftId aircraftType
                  totalTime pic sic solo night actualIMC simulatedIMC
                  crossCountry dualReceived dualGiven
                  dayLandings nightLandings approaches approachTypes
                  flightType conditions kmlS3Key approachChartKeys
                  title milestone notes published
                }
                nextToken
              }
            }`,
            variables: { filter: { published: { eq: true } }, limit: 500, nextToken: token ?? null },
            authMode: "apiKey",
          });
          const { data, nextToken: nt } = {
            data:      listResult.data?.listFlights?.items ?? [],
            nextToken: listResult.data?.listFlights?.nextToken ?? null,
          };
          all.push(...(data as Flight[]));
          token = nt;
        } while (token);
        all.sort((a, b) => b.date.localeCompare(a.date));
        setFlights(all);

        const looksLikeAirport = (s: string) =>
          /^[KPC][A-Z0-9]{3}$/.test(s) ||   // KGTU, KAUS, PHNL, CYVR…
          /^[A-Z]\d{2}$/.test(s) ||          // T74, H46…
          /^\d[A-Z0-9]{2}$/.test(s);         // 0R0, 3T5…

        const fromToIcaos = [...new Set(all.flatMap((f) => {
          const base = [f.from, f.to].filter(Boolean) as string[];
          const routeTokens = (f.route ?? "")
            .split(/\s+/)
            .map((s: string) => s.trim().toUpperCase())
            .filter(looksLikeAirport);
          return [...base, ...routeTokens];
        }))];

        const APT_FIELDS = `id faaId icaoId name city stateCode latDecimal lonDecimal elevationFt hasTower airspaceClass`;
        const aptResults = await Promise.all(
          fromToIcaos.map((icaoId) =>
            (client as any).graphql({
              query: `query ListAirportByIcaoId($icaoId: String!) {
                listAirportByIcaoId(icaoId: $icaoId, limit: 1) {
                  items { ${APT_FIELDS} }
                }
              }`,
              variables: { icaoId },
              authMode: "apiKey",
            }).then((res: any) => res.data?.listAirportByIcaoId?.items?.[0] ?? null)
              .catch(() => null)
          )
        );
        setAirports(aptResults.filter(Boolean) as AirportMarker[]);

        // Fetch approach procedures via GSI — one request per unique ICAO with approaches.
        const apprIcaos = [...new Set(all.flatMap((f) =>
          extractApproachIcaos(f.approachTypes)
        ))];

        const cache = approachCache.current;
        await Promise.all(
          apprIcaos.map(async (icao) => {
            let token: string | null | undefined;
            do {
              const res: any = await (client as any).graphql({
                query: `query ListApproachByIcao($icao: String!, $nextToken: String) {
                  listApproachProcedureByIcao(icao: $icao, limit: 100, nextToken: $nextToken) {
                    items { icao procedure transition fixes }
                    nextToken
                  }
                }`,
                variables: { icao, nextToken: token ?? null },
                authMode: "apiKey",
              });
              const page = res.data?.listApproachProcedureByIcao;
              for (const r of page?.items ?? []) {
                cache.set(`${r.icao}|${r.procedure}|${r.transition ?? ""}`, r);
              }
              token = page?.nextToken;
            } while (token);
          })
        );
        console.log(`[approaches] cached ${cache.size} records for ${apprIcaos.length} airports`);

        // Load flight media (videos) — resolve signed URLs in parallel
        const mediaResult = await (client as any).graphql({
          query: `query ListFlightMedia($limit: Int, $nextToken: String) {
            listFlightMedias(limit: $limit, nextToken: $nextToken) {
              items { id flightId s3Key label camera sortOrder kmlOffsetSec featured }
              nextToken
            }
          }`,
          variables: { limit: 200 },
          authMode: "apiKey",
        });
        const rawMedia: any[] = mediaResult.data?.listFlightMedias?.items ?? [];
        rawMedia.sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

        const resolvedVideos = await Promise.all(
          rawMedia.map(async (m: any) => {
            try {
              const { url } = await getUrl({
                path: m.s3Key,
                options: { bucket: BUCKET_NAME, expiresIn: 7200 },
              });
              return { ...m, signedUrl: url.toString() } as FeaturedVideo;
            } catch {
              return null;
            }
          })
        );
        setVideos(resolvedVideos.filter(Boolean) as FeaturedVideo[]);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // ── Approach click handler ─────────────────────────────────────────────────
  const handleApproachClick = useCallback(async (
    icao: string, procedure: string, label: string,
  ) => {
    const key = `${icao}|${procedure}`;

    // Toggle off
    if (activeApproachKey === key) {
      setActiveApproach(null);
      setActiveApproachKey(null);
      return;
    }

    // Already known unavailable
    if (unavailableApproaches.has(key)) return;

    // Look up from in-memory cache — no DB call needed
    const cacheKey = `${icao}|${procedure}|`;
    const record = approachCache.current.get(cacheKey);

    if (!record) {
      setUnavailableApproaches((prev) => new Set(prev).add(key));
      return;
    }

    try {
      const fixes: ApproachFix[] = JSON.parse(record.fixes);
      setActiveApproach({ label, icao, procedure, fixes });
      setActiveApproachKey(key);
    } catch {
      setUnavailableApproaches((prev) => new Set(prev).add(key));
    }
  }, [activeApproachKey, unavailableApproaches]);

  // Clear approach when flight deselected
  const handleSelect = useCallback((id: string) => {
    setSelectedId((prev) => {
      if (prev === id) {
        setActiveApproach(null);
        setActiveApproachKey(null);
        return null;
      }
      return id;
    });
  }, []);

  const handleClose = useCallback(() => {
    setSelectedId(null);
    setActiveApproach(null);
    setActiveApproachKey(null);
    setDrawerState("peek");
  }, []);

  // Clear selected flight if it's filtered out
  useEffect(() => {
    if (selectedId && !visibleFlights.find((f) => f.id === selectedId)) {
      setSelectedId(null);
      setActiveApproach(null);
      setActiveApproachKey(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthFilter]);

  const years = groupByYear(visibleFlights);

  return (
    <DefaultLayout>
      <Head>
        <title>Flying — Gennaro Anesi</title>
      </Head>

      {/* ── Desktop layout (lg+): side-by-side ───────────────────────────────── */}
      <div className="hidden lg:flex flex-col" style={{ height: "100%" }}>
        {!loading && flights.length > 0 && (
          <DesktopHeader
            allFlights={flights}
            filteredFlights={visibleFlights}
            monthFilter={monthFilter}
            onMonthChange={setMonthFilter}
            videos={videos.filter((v) => v.featured)}
            getTrack={getTrack}
            getApproachFixes={getApproachFixes}
            onPlaneTime={setPlaneCursor}
          />
        )}
        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 relative bg-darkBg">
            {loading ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-gray-600 font-mono text-xs tracking-widest uppercase animate-pulse">Loading flights…</span>
              </div>
            ) : (
              <CesiumGlobe flights={visibleFlights} airports={airports} selectedId={selectedId}
                activeApproach={activeApproach} onSelect={handleSelect} planeCursor={planeCursor}
                onTrackReady={handleTrackReadyWithRender} />
            )}
          </div>
          <div className="w-72 flex flex-col border-l border-darkBorder bg-darkSurface overflow-hidden shrink-0">
            {selected ? (
              <FlightDetail
                flight={selected}
                activeApproachKey={activeApproachKey}
                approachLoading={approachLoading}
                unavailableApproaches={unavailableApproaches}
                onApproachClick={handleApproachClick}
                onClose={handleClose}
                videos={videos}
                getTrack={getTrack}
                getApproachFixes={getApproachFixes}
                onPlaneTime={setPlaneCursor}
              />
            ) : (
              <div className="flex flex-col h-full overflow-y-auto">
                <div className="px-4 py-3 border-b border-darkBorder sticky top-0 bg-darkSurface z-10">
                  <span className="text-xs font-mono uppercase tracking-widest text-gray-500">Logbook</span>
                </div>
                {loading ? (
                  <div className="flex-1 flex items-center justify-center">
                    <span className="text-gray-600 text-xs font-mono animate-pulse">Loading…</span>
                  </div>
                ) : visibleFlights.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center px-6 text-center">
                    <span className="text-gray-600 text-xs font-mono">
                      {monthFilter === null
                        ? "No flights yet"
                        : monthFilter === LAST_90_FILTER
                          ? "No flights in the last 90 days"
                          : "No flights this month"}
                    </span>
                  </div>
                ) : (
                  years.map(([year, yf]) => (
                    <div key={year}>
                      <div className="px-4 py-2 bg-darkBg border-b border-darkBorder sticky top-[2.75rem] z-[5]">
                        <span className="text-xs font-mono text-gold tracking-widest">
                          {year}
                          <span className="text-gray-600 ml-2 font-normal">
                            {yf.length} flights · {yf.reduce((s, f) => s + (f.totalTime ?? 0), 0).toFixed(1)}h
                          </span>
                        </span>
                      </div>
                      {yf.map((f) => (
                        <FlightRow key={f.id} flight={f} selected={f.id === selectedId}
                          colorIndex={visibleFlights.findIndex((x) => x.id === f.id)}
                          onClick={() => handleSelect(f.id)} />
                      ))}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Mobile layout (<lg): full-screen globe + bottom drawer ──────────── */}
      {/* Fixed positioning bypasses the flex height chain — most reliable on iOS Safari */}
      <div className="lg:hidden fixed bg-darkBg" style={{ top: 0, left: 0, right: 0, bottom: 0, zIndex: 50 }}>
        {/* Globe fills entire area */}
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-gray-600 font-mono text-xs tracking-widest uppercase animate-pulse">Loading flights…</span>
          </div>
        ) : (
          <CesiumGlobe flights={visibleFlights} airports={airports} selectedId={selectedId}
            activeApproach={activeApproach} onSelect={(id) => { handleSelect(id); setDrawerState("detail"); }}
            planeCursor={planeCursor} onTrackReady={handleTrackReadyWithRender} />
        )}

        {/* Floating back button — replaces navbar on mobile */}
        <a
          href="/"
          className="absolute top-3 left-3 z-30 flex items-center justify-center
            w-9 h-9 rounded-full bg-black/50 backdrop-blur-sm border border-white/10"
          aria-label="Home"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-300">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </a>

        {/* Bottom drawer */}
        {!loading && (
          <MobileDrawer
            state={drawerState}
            allFlights={flights}
            flights={visibleFlights}
            loading={loading}
            selected={selected}
            selectedId={selectedId}
            years={years}
            monthFilter={monthFilter}
            onMonthChange={setMonthFilter}
            videos={videos}
            getTrack={getTrack}
            getApproachFixes={getApproachFixes}
            activeApproachKey={activeApproachKey}
            approachLoading={approachLoading}
            unavailableApproaches={unavailableApproaches}
            onApproachClick={handleApproachClick}
            onSelect={handleSelect}
            onClose={handleClose}
            onStateChange={setDrawerState}
            onPlaneTime={setPlaneCursor}
          />
        )}
      </div>
    </DefaultLayout>
  );
}
