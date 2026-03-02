import React, { useEffect, useState, useRef } from "react";
import Head from "next/head";
import { generateClient } from "aws-amplify/data";
import { uploadData } from "aws-amplify/storage";
import type { Schema } from "@/amplify/data/resource";
import DefaultLayout from "@/layouts/default";
import { useRequireAuth } from "@/hooks/useRequireAuth";

// ── Types ─────────────────────────────────────────────────────────────────────

type Flight = {
  id: string;
  date: string;
  from: string;
  to: string;
  aircraftId: string | null;
  totalTime: number | null;
  flightType: string | null;
  kmlS3Key: string | null;
  published: boolean | null;
  title: string | null;
  milestone: string | null;
};

type UploadState = "idle" | "uploading" | "success" | "error";

// ── Config ────────────────────────────────────────────────────────────────────

const BUCKET_NAME = "gennaroanesi.com";
const KML_PREFIX  = "public/flights/kml/";

const FLIGHT_TYPE_LABEL: Record<string, string> = {
  TRAINING:      "Training",
  SOLO:          "Solo",
  CROSS_COUNTRY: "XC",
  CHECKRIDE:     "Checkride",
  INTRO:         "Intro",
  OTHER:         "Other",
};

// ── Client ────────────────────────────────────────────────────────────────────

const client = generateClient<Schema>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(h: number | null) {
  if (h == null || h === 0) return "—";
  return `${h.toFixed(1)}h`;
}

// ── KML Upload Modal ──────────────────────────────────────────────────────────

function KmlUploadModal({
  flight,
  onClose,
  onSuccess,
}: {
  flight: Flight;
  onClose: () => void;
  onSuccess: (kmlS3Key: string) => void;
}) {
  const [file,        setFile]        = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [error,       setError]       = useState<string | null>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f?.name.endsWith(".kml")) setFile(f);
    else setError("Please drop a .kml file");
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f?.name.endsWith(".kml")) { setFile(f); setError(null); }
    else setError("Please select a .kml file");
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploadState("uploading");
    setError(null);

    // Key: public/flights/kml/{flightId}.kml
    const key = `${KML_PREFIX}${flight.id}.kml`;

    try {
      await uploadData({
        path:    key,
        data:    file,
        options: { bucket: BUCKET_NAME, contentType: "application/vnd.google-earth.kml+xml" },
      }).result;

      // Update the flight record with the S3 key
      const { errors } = await (client.models.flight as any).update({
        id:       flight.id,
        kmlS3Key: key,
      });

      if (errors?.length) throw new Error(errors[0].message);

      setUploadState("success");
      setTimeout(() => onSuccess(key), 800);
    } catch (e: any) {
      setError(e.message ?? "Upload failed");
      setUploadState("error");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-darkSurface border border-darkBorder rounded-lg w-full max-w-md mx-4 overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-darkBorder">
          <div>
            <h2 className="text-sm font-semibold text-gray-100">Attach KML Track</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {flight.date} · {flight.from} → {flight.to}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="p-5 flex flex-col gap-4">
          {uploadState === "success" ? (
            <div className="flex flex-col items-center gap-2 py-6">
              <span className="text-2xl">✓</span>
              <span className="text-sm text-gold font-semibold">KML attached successfully</span>
            </div>
          ) : (
            <>
              {/* Drop zone */}
              <div
                ref={dropRef}
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                className={`relative border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer
                  ${file
                    ? "border-gold/50 bg-gold/5"
                    : "border-darkBorder hover:border-gray-500 bg-darkBg"
                  }`}
                onClick={() => document.getElementById("kml-file-input")?.click()}
              >
                <input
                  id="kml-file-input"
                  type="file"
                  accept=".kml"
                  className="hidden"
                  onChange={handleFile}
                />
                {file ? (
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-gold text-sm font-mono">{file.name}</span>
                    <span className="text-xs text-gray-500">
                      {(file.size / 1024).toFixed(1)} KB
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-gray-500 text-sm">Drop .kml file here</span>
                    <span className="text-xs text-gray-600">or click to browse</span>
                  </div>
                )}
              </div>

              {/* S3 key preview */}
              {file && (
                <div className="font-mono text-xs text-gray-600 bg-darkBg px-3 py-2 rounded border border-darkBorder">
                  → {KML_PREFIX}{flight.id}.kml
                </div>
              )}

              {error && (
                <p className="text-xs text-red-400">{error}</p>
              )}

              {/* Actions */}
              <div className="flex gap-2 justify-end">
                <button
                  onClick={onClose}
                  className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUpload}
                  disabled={!file || uploadState === "uploading"}
                  className={`px-4 py-1.5 text-sm rounded border transition-colors
                    ${file && uploadState !== "uploading"
                      ? "border-gold/50 text-gold hover:bg-gold/10"
                      : "border-darkBorder text-gray-600 cursor-not-allowed"
                    }`}
                >
                  {uploadState === "uploading" ? "Uploading…" : "Upload & Attach"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Flight row ────────────────────────────────────────────────────────────────

function FlightRow({
  flight,
  onKmlClick,
  onTogglePublish,
  publishing,
}: {
  flight: Flight;
  onKmlClick: () => void;
  onTogglePublish: () => void;
  publishing: boolean;
}) {
  return (
    <tr className="border-b border-darkBorder hover:bg-white/[0.02] transition-colors">
      {/* Date */}
      <td className="px-4 py-3 text-xs font-mono text-gray-400 whitespace-nowrap">
        {flight.date}
      </td>

      {/* Route */}
      <td className="px-4 py-3">
        <div className="text-sm text-gray-100 font-semibold">
          {flight.from} → {flight.to}
        </div>
        {flight.title && (
          <div className="text-xs text-gray-500 truncate max-w-[180px]">{flight.title}</div>
        )}
        {flight.milestone && (
          <div className="text-xs text-gold">★ {flight.milestone}</div>
        )}
      </td>

      {/* Aircraft */}
      <td className="px-4 py-3 text-xs font-mono text-gray-500 whitespace-nowrap">
        {flight.aircraftId ?? "—"}
      </td>

      {/* Type */}
      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
        {flight.flightType ? (FLIGHT_TYPE_LABEL[flight.flightType] ?? flight.flightType) : "—"}
      </td>

      {/* Time */}
      <td className="px-4 py-3 text-xs font-mono text-gray-400 whitespace-nowrap">
        {fmt(flight.totalTime)}
      </td>

      {/* KML */}
      <td className="px-4 py-3 whitespace-nowrap">
        {flight.kmlS3Key ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-green-500 font-mono">✓ attached</span>
            <button
              onClick={onKmlClick}
              className="text-xs text-gray-600 hover:text-gray-400 transition-colors underline"
            >
              replace
            </button>
          </div>
        ) : (
          <button
            onClick={onKmlClick}
            className="text-xs px-2.5 py-1 border border-darkBorder rounded
              text-gray-400 hover:border-gold/50 hover:text-gold transition-colors"
          >
            + attach KML
          </button>
        )}
      </td>

      {/* Published */}
      <td className="px-4 py-3 whitespace-nowrap">
        <button
          onClick={onTogglePublish}
          disabled={publishing}
          className={`text-xs px-2.5 py-1 rounded border transition-colors
            ${flight.published
              ? "border-green-700/50 text-green-500 hover:border-red-700/50 hover:text-red-400"
              : "border-darkBorder text-gray-600 hover:border-gold/50 hover:text-gold"
            } ${publishing ? "opacity-40 cursor-wait" : ""}`}
        >
          {publishing ? "…" : flight.published ? "Published" : "Unpublished"}
        </button>
      </td>
    </tr>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminFlightsPage() {
  const { authState }      = useRequireAuth("admins");
  const [flights,  setFlights]  = useState<Flight[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [kmlFlight, setKmlFlight] = useState<Flight | null>(null);
  const [publishing, setPublishing] = useState<Set<string>>(new Set());
  const [search,   setSearch]   = useState("");
  const [filter,   setFilter]   = useState<"all" | "published" | "unpublished" | "no-kml">("all");

  // Fetch all flights
  useEffect(() => {
    if (authState !== "authenticated") return;
    async function load() {
      try {
        const all: Flight[] = [];
        let token: string | null | undefined;
        do {
          const { data, nextToken } = await (client.models.flight as any).list({
            limit: 1000, nextToken: token,
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
  }, [authState]);

  const handleTogglePublish = async (flight: Flight) => {
    setPublishing((s) => new Set(s).add(flight.id));
    try {
      await (client.models.flight as any).update({
        id:        flight.id,
        published: !flight.published,
      });
      setFlights((prev) =>
        prev.map((f) => f.id === flight.id ? { ...f, published: !f.published } : f)
      );
    } finally {
      setPublishing((s) => { const n = new Set(s); n.delete(flight.id); return n; });
    }
  };

  const handleKmlSuccess = (flightId: string, kmlS3Key: string) => {
    setFlights((prev) =>
      prev.map((f) => f.id === flightId ? { ...f, kmlS3Key } : f)
    );
    setKmlFlight(null);
  };

  // Filter + search
  const visible = flights.filter((f) => {
    if (filter === "published"   && !f.published)  return false;
    if (filter === "unpublished" &&  f.published)  return false;
    if (filter === "no-kml"      &&  f.kmlS3Key)   return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        f.date.includes(q)         ||
        f.from.toLowerCase().includes(q) ||
        f.to.toLowerCase().includes(q)   ||
        f.aircraftId?.toLowerCase().includes(q) ||
        f.title?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const published   = flights.filter((f) =>  f.published).length;
  const unpublished = flights.filter((f) => !f.published).length;
  const noKml       = flights.filter((f) => !f.kmlS3Key).length;

  if (authState === "loading") {
    return (
      <DefaultLayout>
        <div className="flex items-center justify-center h-64">
          <span className="text-gray-600 font-mono text-xs animate-pulse">Checking auth…</span>
        </div>
      </DefaultLayout>
    );
  }

  return (
    <DefaultLayout>
      <Head><title>Admin — Flights</title></Head>

      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-100">Flight Manager</h1>
            <p className="text-xs text-gray-500 mt-0.5 font-mono">
              {flights.length} flights · {published} published · {noKml} missing KML
            </p>
          </div>
        </div>

        {/* Filters + search */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          {(["all", "published", "unpublished", "no-kml"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-xs px-3 py-1.5 rounded border transition-colors font-mono
                ${filter === f
                  ? "border-gold/50 text-gold bg-gold/5"
                  : "border-darkBorder text-gray-500 hover:border-gray-500"
                }`}
            >
              {f === "all"         ? `All (${flights.length})`      :
               f === "published"   ? `Published (${published})`     :
               f === "unpublished" ? `Unpublished (${unpublished})` :
                                     `No KML (${noKml})`}
            </button>
          ))}

          <input
            type="text"
            placeholder="Search date, airport, aircraft…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ml-auto text-xs bg-darkBg border border-darkBorder rounded px-3 py-1.5
              text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500 w-56"
          />
        </div>

        {/* Table */}
        <div className="border border-darkBorder rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-darkBg border-b border-darkBorder">
                  {["Date", "Route", "Aircraft", "Type", "Time", "KML", "Status"].map((h) => (
                    <th key={h}
                      className="px-4 py-2.5 text-left text-xs font-mono text-gray-600 uppercase tracking-widest">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-xs text-gray-600 font-mono animate-pulse">
                      Loading flights…
                    </td>
                  </tr>
                ) : visible.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-xs text-gray-600 font-mono">
                      No flights match
                    </td>
                  </tr>
                ) : (
                  visible.map((f) => (
                    <FlightRow
                      key={f.id}
                      flight={f}
                      onKmlClick={() => setKmlFlight(f)}
                      onTogglePublish={() => handleTogglePublish(f)}
                      publishing={publishing.has(f.id)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-xs text-gray-700 font-mono mt-3">
          {visible.length} of {flights.length} flights shown
        </p>
      </div>

      {/* KML Upload Modal */}
      {kmlFlight && (
        <KmlUploadModal
          flight={kmlFlight}
          onClose={() => setKmlFlight(null)}
          onSuccess={(key) => handleKmlSuccess(kmlFlight.id, key)}
        />
      )}
    </DefaultLayout>
  );
}
