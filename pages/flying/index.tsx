import React, { useEffect, useState, useCallback } from "react";
import Head from "next/head";
import dynamic from "next/dynamic";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import DefaultLayout from "@/layouts/default";
import type { Flight } from "@/components/CesiumGlobe";

// ── Dynamically import globe — never SSR (Cesium + Amplify storage need window)
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

// ── Stats bar ─────────────────────────────────────────────────────────────────

function StatsBar({ flights }: { flights: Flight[] }) {
  const totalHours = flights.reduce((s, f) => s + (f.totalTime ?? 0), 0);
  const imcHours   = flights.reduce((s, f) => s + (f.actualIMC ?? 0), 0);
  const totalAppr  = flights.reduce((s, f) => s + (f.approaches ?? 0), 0);
  const airports   = new Set([...flights.map((f) => f.from), ...flights.map((f) => f.to)]).size;

  return (
    <div className="flex items-center gap-8 px-6 py-2.5 border-b border-darkBorder bg-darkSurface">
      {[
        { label: "Flights",    value: flights.length },
        { label: "Hours",      value: totalHours.toFixed(1) },
        { label: "IMC",        value: `${imcHours.toFixed(1)}h` },
        { label: "Approaches", value: totalAppr },
        { label: "Airports",   value: airports },
      ].map(({ label, value }) => (
        <div key={label} className="flex items-baseline gap-2">
          <span className="text-gold font-mono font-bold text-sm">{value}</span>
          <span className="text-xs text-gray-500 uppercase tracking-widest font-mono">{label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Flight list row ───────────────────────────────────────────────────────────

function FlightRow({ flight, selected, onClick }: {
  flight: Flight; selected: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 border-b border-darkBorder transition-all duration-150
        border-l-2 ${selected
          ? "bg-darkElevated border-l-gold"
          : "hover:bg-white/[0.03] border-l-transparent"
        }`}
    >
      <div className="flex justify-between items-start gap-2">
        <div className="min-w-0">
          <div className="text-xs font-mono text-gray-500 mb-0.5">{flight.date}</div>
          <div className="text-sm font-semibold text-gray-100 truncate">
            {flight.from}{flight.to && flight.to !== flight.from ? ` → ${flight.to}` : ""}
          </div>
          {flight.milestone && (
            <div className="text-xs text-gold mt-0.5">★ {flight.milestone}</div>
          )}
          {flight.title && !flight.milestone && (
            <div className="text-xs text-gray-500 truncate mt-0.5">{flight.title}</div>
          )}
        </div>
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

// ── Flight detail panel ───────────────────────────────────────────────────────

function FlightDetail({ flight, onClose }: { flight: Flight; onClose: () => void }) {
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

        {flight.route && (
          <div className="font-mono text-xs text-gray-500 bg-darkBg rounded px-3 py-2 border border-darkBorder leading-relaxed break-all">
            {flight.route}
          </div>
        )}

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

        {flight.approachTypes && (
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-1.5 font-mono">
              Approaches
            </p>
            <div className="flex flex-wrap gap-1">
              {flight.approachTypes.split(", ").map((a, i) => (
                <span key={i}
                  className="text-xs font-mono px-2 py-0.5 bg-darkElevated border border-darkBorder rounded text-gray-300">
                  {a}
                </span>
              ))}
            </div>
          </div>
        )}

        {flight.notes && (
          <p className="text-sm text-gray-400 italic border-l-2 border-gold/30 pl-3 leading-relaxed">
            {flight.notes}
          </p>
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FlyingPage() {
  const [flights,    setFlights]    = useState<Flight[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = flights.find((f) => f.id === selectedId) ?? null;

  // Fetch published flights via public API key
  useEffect(() => {
    async function load() {
      try {
        const all: Flight[] = [];
        let token: string | null | undefined = undefined;
        do {
          const { data, nextToken } = await (client.models.flight as any).list({
            authMode:  "apiKey",
            filter:    { published: { eq: true } },
            limit:     500,
            nextToken: token,
          });
          all.push(...(data as Flight[]));
          token = nextToken;
        } while (token);
        all.sort((a, b) => b.date.localeCompare(a.date));
        setFlights(all);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleSelect = useCallback((id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  }, []);

  const years = groupByYear(flights);

  return (
    <DefaultLayout>
      <Head>
        <title>Flying — Gennaro Anesi</title>
      </Head>

      <div className="flex flex-col" style={{ height: "calc(100vh - 4rem)" }}>
        {/* Stats bar */}
        {!loading && flights.length > 0 && <StatsBar flights={flights} />}

        {/* Globe + sidebar */}
        <div className="flex flex-1 overflow-hidden">

          {/* Globe */}
          <div className="flex-1 relative bg-darkBg">
            {loading ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-gray-600 font-mono text-xs tracking-widest uppercase animate-pulse">
                  {loading ? "Loading flights…" : "Initialising globe…"}
                </span>
              </div>
            ) : (
              <CesiumGlobe
                flights={flights}
                selectedId={selectedId}
                onSelect={handleSelect}
              />
            )}
          </div>

          {/* Sidebar */}
          <div className="w-72 flex flex-col border-l border-darkBorder bg-darkSurface overflow-hidden shrink-0">
            {selected ? (
              <FlightDetail flight={selected} onClose={() => setSelectedId(null)} />
            ) : (
              <div className="flex flex-col h-full overflow-y-auto">
                <div className="px-4 py-3 border-b border-darkBorder sticky top-0 bg-darkSurface z-10">
                  <span className="text-xs font-mono uppercase tracking-widest text-gray-500">
                    Logbook
                  </span>
                </div>

                {loading ? (
                  <div className="flex-1 flex items-center justify-center">
                    <span className="text-gray-600 text-xs font-mono animate-pulse">Loading…</span>
                  </div>
                ) : flights.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center px-6 text-center">
                    <span className="text-gray-600 text-xs font-mono">
                      No published flights yet
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
                        <FlightRow
                          key={f.id}
                          flight={f}
                          selected={f.id === selectedId}
                          onClick={() => handleSelect(f.id)}
                        />
                      ))}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </DefaultLayout>
  );
}
