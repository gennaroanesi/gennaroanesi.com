import React, { useEffect, useRef, useState } from "react";

import Head from "next/head";
import { generateClient } from "aws-amplify/data";
import { uploadData, getUrl, remove } from "aws-amplify/storage";
import type { Schema } from "@/amplify/data/resource";
import FlyingAdminLayout from "@/layouts/flying-admin";
import { useRequireAuth } from "@/hooks/useRequireAuth";

// ── Types ─────────────────────────────────────────────────────────────────────

type Flight = {
  id: string;
  date: string;
  from: string;
  to: string;
  title: string | null;
};

type FlightMedia = {
  id: string;
  flightId: string;
  s3Key: string;
  label: string | null;
  camera: string | null;
  sortOrder: number | null;
  kmlOffsetSec: number | null;  // seconds into KML track where frame 0 occurs
  featured: boolean | null;
  signedUrl?: string;
  flightLabel?: string;
};

type KmlTrack = {
  points: { t: number; lat: number; lon: number; alt: number; utc: Date | null }[];
  startUtc: Date | null;  // UTC of first point
  durationSec: number;
};

type UploadState = "idle" | "uploading" | "success" | "error";

// ── Config ────────────────────────────────────────────────────────────────────

const BUCKET_NAME  = "gennaroanesi.com";
const VIDEO_PREFIX = "public/flights/videos/";

const CAMERA_LABEL: Record<string, string> = {
  RAYBAN:    "Ray-Ban",
  COCKPIT:   "Cockpit",
  EXTERIOR:  "Exterior",
  PASSENGER: "Passenger",
  OTHER:     "Other",
};

const client = generateClient<Schema>();

// ── UUID helper (crypto.randomUUID not available in all browser contexts) ────
function randomUUID(): string {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// ── Video metadata ────────────────────────────────────────────────────────────
// Combines HTMLVideoElement (duration, dimensions) with a binary MP4 atom
// parser (creation timestamp, GPS coordinate) reading only the first 1 MB.

type VideoMeta = {
  durationSec: number;
  width: number;
  height: number;
  fileSizeMb: number;
  // From MP4 atoms:
  recordedAt: Date | null;   // mvhd creation_time
  gps: { lat: number; lon: number; alt: number | null } | null;  // udta.©xyz
};

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── MP4 atom parser ─────────────────────────────────────────────────────────

const MAC_EPOCH_OFFSET = 2082844800;
function r32(v: DataView, o: number) { return v.getUint32(o, false); }
function macToDate(s: number) { return new Date((s - MAC_EPOCH_OFFSET) * 1000); }

function parseISO6709(str: string): { lat: number; lon: number; alt: number | null } | null {
  const m = str.match(/([+-]\d+\.?\d*)([+-]\d+\.?\d*)(?:([+-]\d+\.?\d*))?/);
  if (!m) return null;
  return { lat: parseFloat(m[1]), lon: parseFloat(m[2]), alt: m[3] ? parseFloat(m[3]) : null };
}

type AtomResult = { recordedAt: Date | null; gps: { lat: number; lon: number; alt: number | null } | null; _keys?: string[] };

function findAtomOffset(view: DataView, fourcc: string): number {
  const cc = [fourcc.charCodeAt(0), fourcc.charCodeAt(1), fourcc.charCodeAt(2), fourcc.charCodeAt(3)];
  // Walk candidate positions — each atom starts with a 4-byte size then 4-byte name
  let pos = 0;
  while (pos + 8 <= view.byteLength) {
    if (view.getUint8(pos+4) === cc[0] && view.getUint8(pos+5) === cc[1] &&
        view.getUint8(pos+6) === cc[2] && view.getUint8(pos+7) === cc[3]) {
      return pos;
    }
    // Try to advance by the atom size, or byte-by-byte if size looks wrong
    const size = view.getUint32(pos, false);
    if (size >= 8 && pos + size <= view.byteLength) {
      pos += size;
    } else {
      pos += 1; // brute-force scan
    }
  }
  return -1;
}

function walkAtoms(view: DataView, start: number, end: number, depth: number, result: AtomResult) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = r32(view, pos);
    const nameBytes = [view.getUint8(pos+4), view.getUint8(pos+5), view.getUint8(pos+6), view.getUint8(pos+7)];
    const name = String.fromCharCode(...nameBytes);



    if (size === 1) {
      // 64-bit extended size — read the real 8-byte size
      if (pos + 16 > end) break;
      const hi = r32(view, pos + 8);
      const lo = r32(view, pos + 12);
      size = hi * 4294967296 + lo;
      if (size < 16) break;
    }
    if (size < 8) break;
    const atomEnd = Math.min(pos + size, end);

    if (name === "moov" || name === "udta" || name === "trak" || name === "mdia"
        || name === "minf" || name === "dinf" || name === "stbl") {
      // Standard container atoms — children start immediately after 8-byte header
      walkAtoms(view, pos + 8, atomEnd, depth + 1, result);
    } else if (name === "meta") {
      // meta is ambiguous: ISOBMFF uses a FullBox (4 extra bytes for version+flags),
      // QuickTime/Ray-Ban uses a plain container with no fullbox header.
      // Discriminate by checking if bytes at pos+8 look like a valid child atom:
      // a valid child has a reasonable size (8..atomSize) and a printable 4cc at pos+12.
      const childSizeAtPos8 = view.getUint32(pos + 8, false);
      const cc8 = String.fromCharCode(view.getUint8(pos+12), view.getUint8(pos+13), view.getUint8(pos+14), view.getUint8(pos+15));
      const validAtPos8 = childSizeAtPos8 >= 8 && childSizeAtPos8 <= (atomEnd - pos - 8) && /^[\x20-\x7e©]{4}$/.test(cc8);
      const childStart = validAtPos8 ? pos + 8 : pos + 12;
      walkAtoms(view, childStart, atomEnd, depth + 1, result);
    } else if (name === "mvhd") {
      // mvhd layout (version 0): [size 4][name 4][version 1][flags 3]
      //   [creation_time 4][modification_time 4][timescale 4][duration 4]...
      // Ray-Ban sets creation_time to end-of-recording (file close time).
      // Actual start = creation_time - duration/timescale.
      const version = view.getUint8(pos + 8);
      if (version === 0 && pos + 28 <= atomEnd) {
        const macSecs  = r32(view, pos + 12); // creation_time
        const timescale = r32(view, pos + 20);
        const duration  = r32(view, pos + 24);
        if (macSecs > MAC_EPOCH_OFFSET && timescale > 0) {
          const durationSec = duration / timescale;
          const startMac = macSecs - durationSec;
          if (!result.recordedAt) result.recordedAt = macToDate(startMac);
          console.log(`[mvhd] end=${macToDate(macSecs).toISOString()} dur=${durationSec.toFixed(1)}s start=${macToDate(startMac).toISOString()}`);
        }
      } else if (version === 1 && pos + 44 <= atomEnd) {
        // version 1: creation_time and modification_time are 8 bytes each
        const macSecsHi = r32(view, pos + 12);
        const macSecsLo = r32(view, pos + 16);
        const macSecs   = macSecsHi * 4294967296 + macSecsLo;
        const timescale  = r32(view, pos + 28);
        const durHi      = r32(view, pos + 32);
        const durLo      = r32(view, pos + 36);
        const duration   = durHi * 4294967296 + durLo;
        if (macSecs > MAC_EPOCH_OFFSET && timescale > 0) {
        const durationSec = duration / timescale;
        const startMac = macSecs - durationSec;
        if (!result.recordedAt) result.recordedAt = macToDate(startMac);
        console.log(`[mvhd v1] end=${macToDate(macSecs).toISOString()} dur=${durationSec.toFixed(1)}s start=${macToDate(startMac).toISOString()}`);
        }
      }
    } else if (name === "keys" && !result._keys) {
      // iTunes-style metadata: keys atom lists key name strings (FullBox: version+flags at pos+8)
      // Structure: [version 1][flags 3][entry_count 4] then entries: [key_size 4][key_ns 4][key_value...]
      const entryCount = r32(view, pos + 12);
      const keys: string[] = [];
      let kpos = pos + 16;
      for (let i = 0; i < entryCount && kpos + 8 <= atomEnd; i++) {
        const ksize = r32(view, kpos);
        if (ksize < 8) break;
        const kend = kpos + ksize;
        const kbytes = new Uint8Array(view.buffer, view.byteOffset + kpos + 8, kend - kpos - 8);
        keys.push(new TextDecoder().decode(kbytes));
        kpos = kend;
      }
      result._keys = keys;
    } else if (name === "ilst") {
      // ilst children are indexed 1-based by key index, fourcc is the 4-byte big-endian index
      // Each child contains a 'data' atom with the value
      let ipos = pos + 8;
      while (ipos + 8 <= atomEnd) {
        const isize = r32(view, ipos);
        if (isize < 8) break;
        const iend = Math.min(ipos + isize, atomEnd);
        const keyIdx = r32(view, ipos + 4) - 1; // 1-based → 0-based
        // Find 'data' child
        let dpos = ipos + 8;
        while (dpos + 16 <= iend) {
          const dsize = r32(view, dpos);
          const dname = String.fromCharCode(view.getUint8(dpos+4), view.getUint8(dpos+5), view.getUint8(dpos+6), view.getUint8(dpos+7));
          if (dname === "data" && dsize >= 16) {
            // data atom: [size 4][name 4][type_indicator 4][locale 4][value...]
            const valStart = dpos + 16;
            const valEnd = Math.min(dpos + dsize, iend);
            if (valStart < valEnd && result._keys) {
              const keyName = result._keys[keyIdx] ?? "";
              const valBytes = new Uint8Array(view.buffer, view.byteOffset + valStart, valEnd - valStart);
              const valStr = new TextDecoder().decode(valBytes);
              console.log(`[ilst] key="${keyName}" val="${valStr}"`);
              if ((keyName.includes("creationdate") || keyName.includes("creation_date")) && !result.recordedAt) {
                const d = new Date(valStr);
                if (!isNaN(d.getTime())) result.recordedAt = d;
              }
              if (keyName.includes("location") || keyName.includes("GPS") || keyName.includes("geo")) {
                const parsed = parseISO6709(valStr);
                if (parsed) result.gps = parsed;
              }
            }
          }
          dpos += Math.max(8, dsize);
        }
        ipos = iend;
      }
    } else if (view.getUint8(pos+4) === 0xA9 &&
                 view.getUint8(pos+5) === 0x78 &&  // 'x'
                 view.getUint8(pos+6) === 0x79 &&  // 'y'
                 view.getUint8(pos+7) === 0x7A) {  // 'z'
      // ©xyz GPS coordinate atom (QuickTime legacy format)
      const strStart = pos + 8 + 4;
      if (strStart < atomEnd) {
        const bytes = new Uint8Array(view.buffer, view.byteOffset + strStart, atomEnd - strStart);
        const str = new TextDecoder().decode(bytes);
        result.gps = parseISO6709(str);
      }
    }

    pos = atomEnd;
  }
}

async function extractMp4Atoms(file: File): Promise<AtomResult> {
  const result: AtomResult = { recordedAt: null, gps: null };
  try {
    const TAIL = 3 * 1024 * 1024;
    const buf = await file.slice(Math.max(0, file.size - TAIL)).arrayBuffer();
    const view = new DataView(buf);
    const moovOff = findAtomOffset(view, "moov");
    if (moovOff >= 0) walkAtoms(view, moovOff, buf.byteLength, 0, result);
  } catch { /**/ }
  return result;
}

async function extractVideoMeta(file: File): Promise<VideoMeta> {
  const [avMeta, atomMeta] = await Promise.all([
    new Promise<{ durationSec: number; width: number; height: number }>((resolve) => {
      const url = URL.createObjectURL(file);
      const vid = document.createElement("video");
      vid.preload = "metadata";
      vid.onloadedmetadata = () => {
        resolve({ durationSec: vid.duration, width: vid.videoWidth, height: vid.videoHeight });
        URL.revokeObjectURL(url);
      };
      vid.onerror = () => {
        resolve({ durationSec: 0, width: 0, height: 0 });
        URL.revokeObjectURL(url);
      };
      vid.src = url;
    }),
    extractMp4Atoms(file),
  ]);
  return {
    ...avMeta,
    fileSizeMb: file.size / 1024 / 1024,
    recordedAt: atomMeta.recordedAt,
    gps: atomMeta.gps,
  };
}

// ── Video upload modal ────────────────────────────────────────────────────────

function VideoUploadModal({ flights, kmlTracks, onClose, onSuccess }: {
  flights: Flight[];
  kmlTracks: Map<string, KmlTrack>;
  onClose: () => void;
  onSuccess: (media: FlightMedia) => void;
}) {
  const [file,        setFile]        = useState<File | null>(null);
  const [meta,        setMeta]        = useState<VideoMeta | null>(null);
  const [flightId,    setFlightId]    = useState("");
  const [label,       setLabel]       = useState("");
  const [camera,      setCamera]      = useState("RAYBAN");
  const [sortOrder,   setSortOrder]   = useState(0);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [progress,    setProgress]    = useState(0);
  const [error,       setError]       = useState<string | null>(null);

  const ACCEPTED = ["video/mp4", "video/quicktime", "video/x-m4v"];

  // Compute auto-sync offset when both video recordedAt and KML UTC timestamps exist
  function computeAutoSync(recordedAt: Date, fid: string): number | null {
    const track = kmlTracks.get(fid);
    if (!track || !track.startUtc) return null;
    const offsetSec = (recordedAt.getTime() - track.startUtc.getTime()) / 1000;
    // Sanity: offset must be within track duration (with ±60s buffer)
    if (offsetSec < -60 || offsetSec > track.durationSec + 60) return null;
    return Math.round(offsetSec * 10) / 10; // round to 0.1s
  }

  const loadFile = async (f: File) => {
    setFile(f);
    setError(null);
    setMeta(null);
    const m = await extractVideoMeta(f);
    setMeta(m);
    // Auto-detect portrait = likely Ray-Ban (shot vertically)
    if (m.width > 0 && m.height > m.width) setCamera("RAYBAN");
    // Auto-select flight if recordedAt matches a flight date
    if (m.recordedAt && !flightId) {
      const dateStr = m.recordedAt.toISOString().slice(0, 10);
      const match = flights.find((fl) => fl.date === dateStr);
      if (match) setFlightId(match.id);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && ACCEPTED.includes(f.type)) loadFile(f);
    else setError("Please drop an MP4 or MOV file");
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f && ACCEPTED.includes(f.type)) loadFile(f);
    else setError("Please select an MP4 or MOV file");
  };

  const handleUpload = async () => {
    if (!file || !flightId) return;
    setUploadState("uploading");
    setError(null);
    setProgress(0);

    const mediaId = randomUUID();
    const ext = file.name.split(".").pop() ?? "mp4";
    const s3Key = `${VIDEO_PREFIX}${mediaId}.${ext}`;

    try {
      await uploadData({
        path: s3Key,
        data: file,
        options: {
          bucket: BUCKET_NAME,
          contentType: file.type,
          onProgress: ({ transferredBytes, totalBytes }) => {
            if (totalBytes) setProgress(Math.round((transferredBytes / totalBytes) * 100));
          },
        },
      }).result;

      // Attempt auto-sync if recordedAt + KML timestamps are both available
      const kmlOffsetSec = meta?.recordedAt ? computeAutoSync(meta.recordedAt, flightId) : null;

      const { data: created, errors } = await (client.models.flightMedia as any).create({
        id: mediaId, flightId, s3Key,
        label: label || null,
        camera: camera || null,
        sortOrder: sortOrder ?? 0,
        kmlOffsetSec,
      });
      if (errors?.length) throw new Error(errors[0].message);

      const flight = flights.find((f) => f.id === flightId);
      setUploadState("success");
      setTimeout(() => onSuccess({
        ...created,
        kmlOffsetSec,
        flightLabel: flight ? `${flight.date} ${flight.from}→${flight.to}` : flightId,
      }), 800);
    } catch (e: any) {
      setError(e.message ?? "Upload failed");
      setUploadState("error");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-darkSurface border border-darkBorder rounded-lg w-full max-w-lg mx-4 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-darkBorder">
          <h2 className="text-sm font-semibold text-gray-100">Upload Video</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
        </div>
        <div className="p-5 flex flex-col gap-4">
          {uploadState === "success" ? (
            <div className="flex flex-col items-center gap-2 py-6">
              <span className="text-2xl">✓</span>
              <span className="text-sm text-gold font-semibold">Video uploaded successfully</span>
            </div>
          ) : (
            <>
              {/* Drop zone */}
              <div
                onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}
                className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors
                  ${file ? "border-blue-400/50 bg-blue-950/20" : "border-darkBorder hover:border-gray-500 bg-darkBg"}`}
                onClick={() => document.getElementById("video-file-input")?.click()}
              >
                <input id="video-file-input" type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" className="hidden" onChange={handleFile} />
                {file ? (
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-blue-400 text-sm font-mono">{file.name}</span>
                    {meta ? (
                      <div className="flex flex-col items-center gap-1.5 mt-1.5 w-full">
                        {/* Row 1: AV properties */}
                        <div className="flex items-center gap-3 flex-wrap justify-center">
                          <span className="text-xs font-mono text-gray-400">{fmtDuration(meta.durationSec)}</span>
                          <span className="text-xs text-gray-600">·</span>
                          <span className="text-xs font-mono text-gray-400">{meta.width}×{meta.height}</span>
                          <span className="text-xs text-gray-600">·</span>
                          <span className="text-xs font-mono text-gray-400">{meta.fileSizeMb.toFixed(1)} MB</span>
                          <span className="text-xs text-gray-600">·</span>
                          <span className="text-xs font-mono text-gray-500">
                            {meta.width > 0 && meta.height > meta.width ? "‖ portrait" : "― landscape"}
                          </span>
                        </div>
                        {/* Row 2: Embedded metadata from MP4 atoms */}
                        <div className="flex items-center gap-3 flex-wrap justify-center">
                          {meta.recordedAt ? (
                            <span className="text-xs font-mono text-blue-400/80">
                              🗓 {meta.recordedAt.toISOString().replace("T", " ").slice(0, 19)} UTC
                            </span>
                          ) : (
                            <span className="text-xs font-mono text-gray-700">no timestamp in file</span>
                          )}
                          <span className="text-xs text-gray-600">·</span>
                          {meta.gps ? (
                            <span className="text-xs font-mono text-green-400/80">
                              📍 {meta.gps.lat.toFixed(4)}, {meta.gps.lon.toFixed(4)}
                              {meta.gps.alt !== null ? ` ${meta.gps.alt.toFixed(0)}m` : ""}
                            </span>
                          ) : (
                            <span className="text-xs font-mono text-gray-700">no GPS in file</span>
                          )}
                        </div>
                        {/* Row 3: KML sync preview */}
                        {flightId && (() => {
                          const track = kmlTracks.get(flightId);
                          if (!track) return (
                            <div className="text-xs font-mono text-gray-700">KML track not loaded yet</div>
                          );
                          if (!track.startUtc) return (
                            <div className="text-xs font-mono text-gray-700">KML has no timestamps — manual sync needed</div>
                          );
                          if (!meta.recordedAt) return (
                            <div className="text-xs font-mono text-yellow-600/70">no video timestamp — manual sync needed</div>
                          );
                          const offset = computeAutoSync(meta.recordedAt, flightId);
                          if (offset === null) return (
                            <div className="text-xs font-mono text-red-500/70">
                              ⚠️ timestamp mismatch — video doesn’t overlap track
                            </div>
                          );
                          const mm = Math.floor(Math.abs(offset) / 60);
                          const ss = Math.abs(offset % 60).toFixed(1);
                          const label = offset >= 0
                            ? `+${mm}:${ss.padStart(4,"0")} into track`
                            : `-${mm}:${ss.padStart(4,"0")} before track start`;
                          return (
                            <div className="text-xs font-mono text-green-400/90">
                              ✅ auto-sync: frame 0 = {label}
                            </div>
                          );
                        })()}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-600 animate-pulse">reading metadata…</span>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-600">
                      <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                    </svg>
                    <span className="text-gray-500 text-sm">Drop MP4 or MOV here</span>
                    <span className="text-xs text-gray-600">or click to browse</span>
                  </div>
                )}
              </div>

              {/* Upload progress */}
              {uploadState === "uploading" && (
                <div className="w-full bg-darkBg rounded-full h-1.5 overflow-hidden">
                  <div className="bg-blue-400 h-full transition-all duration-200 rounded-full" style={{ width: `${progress}%` }} />
                </div>
              )}

              {/* Metadata fields */}
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="text-xs text-gray-500 font-mono uppercase tracking-wider mb-1 block">Flight *</label>
                  <select
                    value={flightId} onChange={(e) => setFlightId(e.target.value)}
                    className="w-full bg-darkBg border border-darkBorder rounded px-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-gray-500 font-mono"
                  >
                    <option value="">— select a flight —</option>
                    {[...flights].sort((a, b) => b.date.localeCompare(a.date)).map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.date} · {f.from}→{f.to}{f.title ? ` · ${f.title}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 font-mono uppercase tracking-wider mb-1 block">Label</label>
                  <input
                    type="text" value={label} onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. Final approach RWY 18"
                    className="w-full bg-darkBg border border-darkBorder rounded px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 font-mono uppercase tracking-wider mb-1 block">Camera</label>
                  <select
                    value={camera} onChange={(e) => setCamera(e.target.value)}
                    className="w-full bg-darkBg border border-darkBorder rounded px-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-gray-500"
                  >
                    {Object.entries(CAMERA_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 font-mono uppercase tracking-wider mb-1 block">Sort order</label>
                  <input
                    type="number" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value))} min={0}
                    className="w-full bg-darkBg border border-darkBorder rounded px-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-gray-500 font-mono"
                  />
                </div>
              </div>

              {file && (
                <div className="font-mono text-xs text-gray-600 bg-darkBg px-3 py-2 rounded border border-darkBorder">
                  → {VIDEO_PREFIX}&lt;id&gt;.{file.name.split(".").pop()}
                </div>
              )}

              {error && <p className="text-xs text-red-400">{error}</p>}

              <div className="flex gap-2 justify-end">
                <button onClick={onClose} className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors">Cancel</button>
                <button
                  onClick={handleUpload}
                  disabled={!file || !flightId || uploadState === "uploading"}
                  className={`px-4 py-1.5 text-sm rounded border transition-colors
                    ${file && flightId && uploadState !== "uploading"
                      ? "border-blue-400/50 text-blue-400 hover:bg-blue-950/30"
                      : "border-darkBorder text-gray-600 cursor-not-allowed"}`}
                >
                  {uploadState === "uploading" ? `Uploading… ${progress}%` : "Upload Video"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Shared helpers for sync modal panels ─────────────────────────────────────
const NM_TO_DEG = 1 / 60;
const PIP_HALF_NM = 3.5;

function interpolateTrackPoint(
  points: KmlTrack["points"],
  t: number,
): { lat: number; lon: number; alt: number } | null {
  if (!points.length) return null;
  if (t <= points[0].t) return points[0];
  if (t >= points[points.length - 1].t) return points[points.length - 1];
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const f = (t - a.t) / (b.t - a.t);
  return { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon), alt: a.alt + f * (b.alt - a.alt) };
}

function deriveSyncDynamics(
  points: KmlTrack["points"],
  t: number,
): { headingDeg: number; groundSpeedKt: number; vsFpm: number; gradDeg: number } | null {
  if (points.length < 2) return null;
  let lo = 0, hi = points.length - 1;
  if (t <= points[0].t) { lo = 0; hi = 1; }
  else if (t >= points[hi].t) { lo = hi - 1; }
  else {
    let l = 0, h = hi;
    while (h - l > 1) { const m = (l + h) >> 1; if (points[m].t <= t) l = m; else h = m; }
    lo = l; hi = h;
  }
  const a = points[lo], b = points[hi];
  const dt = b.t - a.t;
  if (dt < 0.5) return null;
  const dLat = b.lat - a.lat, dLon = b.lon - a.lon;
  const cosLat = Math.cos((a.lat * Math.PI) / 180);
  const headingDeg = ((Math.atan2(dLon * cosLat, dLat) * 180 / Math.PI) + 360) % 360;
  const distNm = Math.sqrt((dLat * 60) ** 2 + (dLon * 60 * cosLat) ** 2);
  const groundSpeedKt = (distNm / dt) * 3600;
  const dAltFt = (b.alt - a.alt) * 3.28084;
  const vsFpm = (dAltFt / dt) * 60;
  const distFt = distNm * 6076.12;
  const gradDeg = distFt > 0 ? Math.atan2(dAltFt, distFt) * 180 / Math.PI : 0;
  return { headingDeg, groundSpeedKt, vsFpm, gradDeg };
}

// ── Manual sync modal ─────────────────────────────────────────────────────────
// Video + zoomable mini-map side by side.
// Slider sets the kmlOffsetSec; dot moves live as video plays.
// Scroll wheel on the map zooms in/out. Reset reverts to last saved value.

const PANEL_W = 280, PANEL_H = 185;

function ManualSyncModal({
  media, track, onClose, onSaved,
}: {
  media: FlightMedia;
  track: KmlTrack;
  onClose: () => void;
  onSaved: (offset: number) => void;
}) {
  const videoRef   = useRef<HTMLVideoElement>(null);
  const rafRef     = useRef<number>(0);
  const savedOffset = media.kmlOffsetSec ?? 0;

  const [videoTime, setVideoTime] = useState(0);
  const [offsetSec, setOffsetSec] = useState(savedOffset);
  const [zoomNm,    setZoomNm]    = useState(PIP_HALF_NM);
  const [saving,    setSaving]    = useState(false);
  const isDirty = offsetSec !== savedOffset;

  const currentTrackSec = offsetSec + videoTime;

  // rAF loop — read video.currentTime
  useEffect(() => {
    const tick = () => {
      setVideoTime(videoRef.current?.currentTime ?? 0);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // Scroll to zoom on the map
  const handleMapWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoomNm((z) => Math.max(0.2, Math.min(50, z * (e.deltaY > 0 ? 1.15 : 0.87))));
  };

  // ── Map panel geometry
  const PAD = 10;
  const pos = interpolateTrackPoint(track.points, currentTrackSec);
  const dynamics = deriveSyncDynamics(track.points, currentTrackSec);
  const cLat = pos?.lat ?? track.points[Math.floor(track.points.length / 2)].lat;
  const cLon = pos?.lon ?? track.points[Math.floor(track.points.length / 2)].lon;
  const halfLat = zoomNm * NM_TO_DEG;
  const halfLon = zoomNm * NM_TO_DEG / Math.cos((cLat * Math.PI) / 180);
  const minLat = cLat - halfLat, maxLat = cLat + halfLat;
  const minLon = cLon - halfLon, maxLon = cLon + halfLon;
  const latR = maxLat - minLat, lonR = maxLon - minLon;
  const mapIW = PANEL_W - PAD * 2, mapIH = PANEL_H - PAD * 2;
  const mapScale = Math.min(mapIW / lonR, mapIH / latR);
  const mapOX = PAD + (mapIW - lonR * mapScale) / 2;
  const mapOY = PAD + (mapIH - latR * mapScale) / 2;
  const sv = (lat: number, lon: number) => ({
    x: mapOX + (lon - minLon) * mapScale,
    y: mapOY + (maxLat - lat) * mapScale,
  });
  const mapPts = track.points.map((p) => { const s = sv(p.lat, p.lon); return `${s.x},${s.y}`; }).join(" ");
  const flownIdx = track.points.findIndex((p) => p.t > currentTrackSec);
  const mapFlownPts = (flownIdx <= 0 ? track.points : track.points.slice(0, flownIdx + 1))
    .map((p) => { const s = sv(p.lat, p.lon); return `${s.x},${s.y}`; }).join(" ");
  const dot = pos ? sv(pos.lat, pos.lon) : null;

  // ── Vertical profile geometry (±5min window)
  const VPAD = 10;
  const windowSec = 5 * 60;
  const vTMin = Math.max(track.points[0].t, currentTrackSec - windowSec);
  const vTMax = Math.min(track.points[track.points.length - 1].t, currentTrackSec + windowSec);
  const vTrack = track.points.filter((p) => p.t >= vTMin && p.t <= vTMax);
  const vTrackSafe = vTrack.length > 1 ? vTrack : track.points;
  const altValues = vTrackSafe.map((p) => p.alt);
  const minAlt = Math.min(...altValues), maxAlt = Math.max(...altValues);
  const altRange = maxAlt - minAlt || 30;
  const vTMinT = vTrackSafe[0].t, vTMaxT = vTrackSafe[vTrackSafe.length - 1].t;
  const vTRange = vTMaxT - vTMinT || 1;
  const ALT_LABEL_H = 32;
  const vIW = PANEL_W - VPAD * 2, vIH = PANEL_H - VPAD - ALT_LABEL_H;
  const toV = (t: number, alt: number) => ({
    x: VPAD + ((t - vTMinT) / vTRange) * vIW,
    y: ALT_LABEL_H + (1 - (alt - minAlt) / altRange) * vIH,
  });
  const vPts = vTrackSafe.map((p) => { const s = toV(p.t, p.alt); return `${s.x},${s.y}`; }).join(" ");
  const vFlownPts = vTrackSafe.filter((p) => p.t <= currentTrackSec)
    .map((p) => { const s = toV(p.t, p.alt); return `${s.x},${s.y}`; }).join(" ");
  const vDot = pos ? toV(currentTrackSec, pos.alt) : null;
  const altFt = pos ? pos.alt * 3.28084 : null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const rounded = Math.round(offsetSec * 10) / 10;
      await (client.models.flightMedia as any).update({ id: media.id, kmlOffsetSec: rounded });
      onSaved(rounded);
    } catch (e: any) {
      alert(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const fmtT = (s: number) => {
    const abs = Math.abs(s);
    const m = Math.floor(abs / 60);
    const sec = (abs % 60).toFixed(1).padStart(4, "0");
    return `${s < 0 ? "-" : "+"}${m}:${sec}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-darkSurface border border-darkBorder rounded-lg w-full max-w-5xl shadow-2xl overflow-hidden flex flex-col" style={{ maxHeight: "90vh" }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-darkBorder">
          <div>
            <span className="text-sm font-semibold text-gray-100">Manual Sync</span>
            <span className="text-xs text-gray-500 font-mono ml-3">{media.label ?? media.s3Key.split("/").pop()}</span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
        </div>

        {/* Body: video + map */}
        <div className="flex gap-4 p-4 items-stretch" style={{ minHeight: 0, flex: 1 }}>

          {/* Video */}
          <div className="flex-1 min-w-0 flex flex-col gap-1" style={{ maxHeight: "calc(80vh - 120px)" }}>
            <video
              ref={videoRef}
              src={media.signedUrl}
              controls
              className="w-full rounded border border-darkBorder bg-black"
              style={{ flex: 1, minHeight: 0, maxHeight: "100%", objectFit: "contain" }}
            />
            <div className="text-[10px] font-mono text-gray-600 text-center shrink-0">
              video {videoTime.toFixed(1)}s → track {currentTrackSec.toFixed(1)}s
            </div>
          </div>

          {/* Map + profile panels */}
          <div className="flex flex-col gap-2 shrink-0" style={{ width: 280 }}>

            {/* Map panel */}
            <svg
              width={PANEL_W} height={PANEL_H}
              onWheel={handleMapWheel}
              style={{ display: "block", background: "rgba(10,14,26,0.95)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)", cursor: "crosshair" }}
            >
              <polyline points={mapPts} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
              <polyline points={mapFlownPts} fill="none" stroke="#facc15" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
              {dot && (
                <>
                  <circle cx={dot.x} cy={dot.y} r={7} fill="#facc15" opacity={0.18} />
                  <circle cx={dot.x} cy={dot.y} r={4} fill="#facc15" />
                  <circle cx={dot.x} cy={dot.y} r={4} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={1} />
                  {dynamics && (() => {
                    const rad = (dynamics.headingDeg - 90) * Math.PI / 180;
                    return <line x1={dot.x} y1={dot.y} x2={dot.x + Math.cos(rad) * 14} y2={dot.y + Math.sin(rad) * 14} stroke="#facc15" strokeWidth={1.5} strokeLinecap="round" opacity={0.9} />;
                  })()}
                </>
              )}
              {dynamics && (
                <>
                  <text x={8} y={20} fontSize={13} fill="#facc15" fontFamily="monospace" fontWeight="bold">
                    {Math.round(dynamics.headingDeg).toString().padStart(3, "0")}°
                  </text>
                  <text x={8} y={36} fontSize={12} fill="rgba(255,255,255,0.6)" fontFamily="monospace">
                    {Math.round(dynamics.groundSpeedKt)}kt
                  </text>
                </>
              )}
            </svg>
            <div className="text-[10px] font-mono text-gray-600 text-center">scroll to zoom · ±{zoomNm.toFixed(1)}nm</div>

            {/* Vertical profile panel */}
            <svg
              width={PANEL_W} height={PANEL_H}
              style={{ display: "block", background: "rgba(10,14,26,0.95)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)" }}
            >
              <polyline
                points={vPts + ` ${VPAD + vIW},${ALT_LABEL_H + vIH} ${VPAD},${ALT_LABEL_H + vIH}`}
                fill="#facc1518" stroke="none"
              />
              <polyline points={vPts} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
              {vFlownPts && <polyline points={vFlownPts} fill="none" stroke="#facc15" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />}
              {vDot && (
                <>
                  <circle cx={vDot.x} cy={vDot.y} r={5} fill="#facc15" opacity={0.25} />
                  <circle cx={vDot.x} cy={vDot.y} r={3} fill="#facc15" />
                </>
              )}
              {altFt !== null && (
                <>
                  <text x={8} y={17} fontSize={11} fill="#facc15" fontFamily="monospace" fontWeight="bold">
                    {Math.round(altFt).toLocaleString()}ft
                  </text>
                  {dynamics && (
                    <text x={8} y={29} fontSize={10} fill="rgba(255,255,255,0.5)" fontFamily="monospace">
                      {dynamics.vsFpm >= 0 ? "+" : ""}{Math.round(dynamics.vsFpm)}fpm · {dynamics.gradDeg >= 0 ? "+" : ""}{dynamics.gradDeg.toFixed(1)}°
                    </text>
                  )}
                </>
              )}
              <text x={PANEL_W - VPAD} y={ALT_LABEL_H + vIH} fontSize={10} fill="rgba(255,255,255,0.3)" fontFamily="monospace" textAnchor="end">
                {Math.round(minAlt * 3.28084).toLocaleString()}ft
              </text>
              <text x={PANEL_W - VPAD} y={ALT_LABEL_H + 10} fontSize={10} fill="rgba(255,255,255,0.3)" fontFamily="monospace" textAnchor="end">
                {Math.round(maxAlt * 3.28084).toLocaleString()}ft
              </text>
            </svg>
            <div className="text-[10px] font-mono text-gray-600 text-center">±5min window · GPS alt</div>

          </div>
        </div>

        {/* Offset slider */}
        <div className="px-4 pb-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-gray-500 uppercase tracking-wider">offset — where on the track does frame 0 land?</span>
            <span className="text-sm font-mono text-gold tabular-nums">{fmtT(offsetSec)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={track.durationSec}
            step={1}
            value={offsetSec}
            onChange={(e) => setOffsetSec(Number(e.target.value))}
            className="w-full accent-yellow-400"
          />
          <div className="flex justify-between text-[10px] font-mono text-gray-700">
            <span>track start</span>
            <span>{fmtDuration(track.durationSec)} (track end)</span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 pb-4">
          <button
            onClick={() => setOffsetSec(savedOffset)}
            disabled={!isDirty}
            className="text-xs font-mono text-gray-600 hover:text-gray-300 transition-colors disabled:opacity-30"
          >
            ↺ reset to {savedOffset === media.kmlOffsetSec ? "saved" : "original"} ({fmtT(savedOffset)})
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors">Cancel</button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 text-sm rounded border border-green-500/50 text-green-400 hover:bg-green-950/30 transition-colors disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save offset"}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

// ── Video row ─────────────────────────────────────────────────────────────────

function VideoRow({ media, track, onDelete, onSynced, onFeaturedToggle, deleting }: {
  media: FlightMedia;
  track: KmlTrack | null;
  onDelete: () => void;
  onSynced: (kmlOffsetSec: number | null) => void;
  onFeaturedToggle: (featured: boolean) => void;
  deleting: boolean;
}) {
  const [showPreview,   setShowPreview]   = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncing,       setSyncing]       = useState(false);
  const [togglingFeatured, setTogglingFeatured] = useState(false);

  const handleSync = async () => {
    if (!track) return;
    setSyncing(true);
    try {
      // Always generate a fresh signed URL to avoid 403s from stale tokens
      const { url: freshUrl } = await getUrl({ path: media.s3Key, options: { bucket: BUCKET_NAME, expiresIn: 300 } });
      const signedUrl = freshUrl.toString();
      // Fetch the last 3 MB — moov is at the end on Ray-Ban (mdat-first) files
      const TAIL = 3 * 1024 * 1024;
      const tailRes = await fetch(signedUrl, { headers: { Range: `bytes=-${TAIL}` } });
      if (!tailRes.ok) throw new Error(`S3 fetch failed: ${tailRes.status}`);
      const tailBuf = await tailRes.arrayBuffer();
      const tailView = new DataView(tailBuf);
      const atomResult: AtomResult = { recordedAt: null, gps: null };
      const moovOff = findAtomOffset(tailView, "moov");
      if (moovOff >= 0) walkAtoms(tailView, moovOff, tailBuf.byteLength, 0, atomResult);
      console.log(`[sync] gps=${JSON.stringify(atomResult.gps)} recordedAt=${atomResult.recordedAt?.toISOString()}`);
      if (!atomResult.gps && !atomResult.recordedAt) throw new Error("No GPS or timestamp found in video");

      // ── GPS-based sync (primary) ──────────────────────────────────────────
      // The ©xyz atom stores the GPS position at frame 0 of this clip.
      // Find the nearest KML track point and use its t value as the offset.
      if (atomResult.gps) {
        const { lat: vLat, lon: vLon } = atomResult.gps;
        console.log(`[sync] GPS from video: ${vLat.toFixed(5)}, ${vLon.toFixed(5)}`);
        let bestIdx = 0, bestDist = Infinity;
        for (let i = 0; i < track.points.length; i++) {
          const p = track.points[i];
          const dLat = p.lat - vLat, dLon = p.lon - vLon;
          const dist = dLat * dLat + dLon * dLon;
          if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        }
        const bestPt = track.points[bestIdx];
        const distDeg = Math.sqrt(bestDist);
        console.log(`[sync] nearest track point: idx=${bestIdx} t=${bestPt.t.toFixed(1)}s dist=${(distDeg * 111000).toFixed(0)}m`);
        if (distDeg * 111000 > 2000) {
          throw new Error(`Nearest track point is ${(distDeg * 111000).toFixed(0)}m away — GPS may not match this flight`);
        }
        const rounded = Math.round(bestPt.t * 10) / 10;
        await (client.models.flightMedia as any).update({ id: media.id, kmlOffsetSec: rounded });
        onSynced(rounded);
        return;
      }

      // ── Timestamp-based sync (fallback) ───────────────────────────────────
      if (!atomResult.recordedAt) throw new Error("No GPS or timestamp found in video file");
      if (!track.startUtc) throw new Error("KML track has no UTC timestamps — cannot sync by time");
      const offsetSec = (atomResult.recordedAt.getTime() - track.startUtc.getTime()) / 1000;
      const rounded = Math.round(offsetSec * 10) / 10;
      await (client.models.flightMedia as any).update({ id: media.id, kmlOffsetSec: rounded });
      onSynced(rounded);
    } catch (e: any) {
      alert(`Sync failed: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleFeaturedToggle = async () => {
    setTogglingFeatured(true);
    try {
      const next = !media.featured;
      await (client.models.flightMedia as any).update({ id: media.id, featured: next });
      onFeaturedToggle(next);
    } catch (e: any) {
      alert(`Update failed: ${e.message}`);
    } finally {
      setTogglingFeatured(false);
    }
  };

  const handleUnsync = async () => {
    try {
      await (client.models.flightMedia as any).update({ id: media.id, kmlOffsetSec: null });
      onSynced(null);
    } catch (e: any) {
      alert(`Unsync failed: ${e.message}`);
    }
  };

  const syncBadge = track ? (
    <span className="flex items-center gap-1.5">
      {media.kmlOffsetSec !== null && (
        <span className="text-xs font-mono text-green-500/80">
          ✓ {media.kmlOffsetSec >= 0 ? "+" : ""}{media.kmlOffsetSec.toFixed(1)}s
        </span>
      )}
      <button
        onClick={() => setShowSyncModal(true)}
        disabled={!media.signedUrl}
        className="text-xs font-mono text-yellow-600/70 hover:text-yellow-400 underline underline-offset-2 transition-colors disabled:opacity-40"
      >
        {media.kmlOffsetSec !== null ? "adjust" : "sync"}
      </button>
      {media.kmlOffsetSec !== null && (
        <button
          onClick={handleUnsync}
          className="text-xs font-mono text-gray-700 hover:text-red-400 transition-colors"
          title="Clear sync offset"
        >✕</button>
      )}
    </span>
  ) : (
    <span className="text-xs font-mono text-gray-600">no KML</span>
  );

  return (
    <>
    <tr className="border-b border-darkBorder hover:bg-white/[0.02] transition-colors">
      <td className="px-4 py-3 text-xs font-mono text-gray-500 whitespace-nowrap">
        {media.flightLabel ?? media.flightId.slice(0, 8)}
      </td>
      <td className="px-4 py-3">
        <div className="text-sm text-gray-200">
          {media.label ?? <span className="text-gray-600 italic">no label</span>}
        </div>
        <div className="text-xs font-mono text-gray-600 truncate max-w-[240px]">{media.s3Key}</div>
      </td>
      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
        {media.camera ? (CAMERA_LABEL[media.camera] ?? media.camera) : "—"}
      </td>
      <td className="px-4 py-3 text-xs font-mono text-gray-600 whitespace-nowrap text-center">
        {media.sortOrder ?? 0}
      </td>
      <td className="px-4 py-3 whitespace-nowrap">{syncBadge}</td>
      <td className="px-4 py-3 text-center">
        <button
          onClick={handleFeaturedToggle}
          disabled={togglingFeatured}
          title={media.featured ? "Remove from highlights" : "Add to highlights"}
          className={`text-lg leading-none transition-colors disabled:opacity-40 ${
            media.featured ? "text-gold hover:text-gold/60" : "text-gray-700 hover:text-gold/60"
          }`}
        >
          ★
        </button>
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        {media.signedUrl ? (
          <button
            onClick={() => setShowPreview(true)}
            className="text-xs px-2.5 py-1 border border-darkBorder rounded text-gray-400 hover:border-blue-500/50 hover:text-blue-400 transition-colors"
          >
            ▶ preview
          </button>
        ) : (
          <span className="text-xs text-gray-700 font-mono">resolving…</span>
        )}
        {showPreview && media.signedUrl && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={() => setShowPreview(false)}>
            <div className="relative max-w-3xl w-full mx-4" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setShowPreview(false)} className="absolute -top-8 right-0 text-gray-400 hover:text-gray-200 text-sm">✕ close</button>
              <video src={media.signedUrl} controls autoPlay className="w-full rounded-lg border border-darkBorder" />
            </div>
          </div>
        )}
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <button
          onClick={onDelete} disabled={deleting}
          className={`text-xs px-2.5 py-1 rounded border transition-colors border-darkBorder text-gray-600 hover:border-red-700/50 hover:text-red-400 ${deleting ? "opacity-40 cursor-wait" : ""}`}
        >
          {deleting ? "…" : "Delete"}
        </button>
      </td>
    </tr>
    {showSyncModal && track && media.signedUrl && (
      <ManualSyncModal
        media={media}
        track={track}
        onClose={() => setShowSyncModal(false)}
        onSaved={(offset) => {
          onSynced(offset);
          setShowSyncModal(false);
        }}
      />
    )}
  </>  
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminVideosPage() {
  const { authState } = useRequireAuth("admins");
  const [flights,    setFlights]    = useState<Flight[]>([]);
  const [videos,     setVideos]     = useState<FlightMedia[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [deleting,   setDeleting]   = useState<Set<string>>(new Set());
  const [kmlTracks,  setKmlTracks]  = useState<Map<string, KmlTrack>>(new Map());

  useEffect(() => {
    if (authState !== "authenticated") return;
    async function load() {
      try {
        const allFlights: Flight[] = [];
        let ft: string | null | undefined;
        do {
          const { data, nextToken } = await (client.models.flight as any).list({ limit: 1000, nextToken: ft });
          allFlights.push(...(data as Flight[]));
          ft = nextToken;
        } while (ft);
        allFlights.sort((a, b) => b.date.localeCompare(a.date));
        setFlights(allFlights);

        // Fetch KML tracks for any flight that has a kmlS3Key, to enable auto-sync
        const flightsWithKml = allFlights.filter((f: any) => f.kmlS3Key);
        const trackEntries = await Promise.all(
          flightsWithKml.map(async (f: any) => {
            try {
              const { url } = await getUrl({ path: f.kmlS3Key, options: { bucket: BUCKET_NAME, expiresIn: 300 } });
              const res = await fetch(url.toString(), { mode: "cors", credentials: "omit" });
              if (!res.ok) return null;
              const text = await res.text();
              let doc: Document | null = null;
              for (const mime of ["application/xml", "text/xml"] as DOMParserSupportedType[]) {
                try {
                  const c = new DOMParser().parseFromString(text, mime);
                  if (!c.querySelector("parsererror")) { doc = c; break; }
                } catch { /**/ }
              }
              if (!doc) return null;
              const whens = Array.from(doc.getElementsByTagName("when"));
              const coords = Array.from(doc.getElementsByTagNameNS("http://www.google.com/kml/ext/2.2", "coord"));
              if (whens.length === 0 || whens.length !== coords.length) return null;
              let t0: number | null = null;
              const points: KmlTrack["points"] = [];
              for (let i = 0; i < whens.length; i++) {
                const utc = new Date(whens[i].textContent?.trim() ?? "");
                if (isNaN(utc.getTime())) continue;
                const parts = coords[i].textContent?.trim().split(/\s+/) ?? [];
                if (parts.length < 2) continue;
                const lon = parseFloat(parts[0]), lat = parseFloat(parts[1]), alt = parts[2] ? parseFloat(parts[2]) : 0;
                if (isNaN(lon) || isNaN(lat)) continue;
                const ms = utc.getTime();
                if (t0 === null) t0 = ms;
                points.push({ t: (ms - t0) / 1000, lat, lon, alt, utc });
              }
              if (points.length === 0) return null;
              const track: KmlTrack = {
                points,
                startUtc: points[0].utc,
                durationSec: points[points.length - 1].t,
              };
              return [f.id, track] as [string, KmlTrack];
            } catch { return null; }
          })
        );
        const newMap = new Map<string, KmlTrack>();
        for (const entry of trackEntries) if (entry) newMap.set(entry[0], entry[1]);
        setKmlTracks(newMap);

        const allMedia: FlightMedia[] = [];
        let mt: string | null | undefined;
        do {
          const { data, nextToken } = await (client.models.flightMedia as any).list({ limit: 1000, nextToken: mt });
          allMedia.push(...(data as FlightMedia[]));
          mt = nextToken;
        } while (mt);
        allMedia.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

        const flightMap = new Map(allFlights.map((f) => [f.id, f]));
        const annotated = allMedia.map((m) => {
          const f = flightMap.get(m.flightId);
          return { ...m, flightLabel: f ? `${f.date} ${f.from}→${f.to}` : m.flightId };
        });
        setVideos(annotated);

        const withUrls = await Promise.all(
          annotated.map(async (m) => {
            try {
              const { url } = await getUrl({ path: m.s3Key, options: { bucket: BUCKET_NAME, expiresIn: 3600 } });
              return { ...m, signedUrl: url.toString() };
            } catch { return m; }
          })
        );
        setVideos(withUrls);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [authState]);

  const handleDelete = async (media: FlightMedia) => {
    if (!confirm(`Delete "${media.label ?? media.s3Key}"?\nThis removes the S3 file and database record.`)) return;
    setDeleting((s) => new Set(s).add(media.id));
    try {
      await remove({ path: media.s3Key, options: { bucket: BUCKET_NAME } });
      await (client.models.flightMedia as any).delete({ id: media.id });
      setVideos((prev) => prev.filter((m) => m.id !== media.id));
    } catch (e: any) {
      alert(`Delete failed: ${e.message}`);
    } finally {
      setDeleting((s) => { const n = new Set(s); n.delete(media.id); return n; });
    }
  };

  if (authState === "loading") {
    return (
      <FlyingAdminLayout>
        <div className="flex items-center justify-center h-64">
          <span className="text-gray-600 font-mono text-xs animate-pulse">Checking auth…</span>
        </div>
      </FlyingAdminLayout>
    );
  }

  return (
    <FlyingAdminLayout>
      <Head><title>Admin — Videos</title></Head>
      <div className="px-6 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-100">Videos</h1>
            <p className="text-xs text-gray-500 font-mono mt-0.5">{videos.length} uploaded</p>
          </div>
          <button
            onClick={() => setShowUpload(true)}
            className="text-xs px-3 py-1.5 rounded border border-blue-400/50 text-blue-400 hover:bg-blue-950/30 transition-colors"
          >
            + Upload Video
          </button>
        </div>

        <div className="border border-darkBorder rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-darkSurface border-b border-darkBorder">
                  {["Flight", "Label / S3 Key", "Camera", "Order", "Sync", "★", "Preview", ""].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-mono text-gray-600 uppercase tracking-widest">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="px-4 py-12 text-center text-xs text-gray-600 font-mono animate-pulse">Loading videos…</td></tr>
                ) : videos.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-12 text-center text-xs text-gray-600 font-mono">No videos yet — upload one to get started</td></tr>
                ) : (
                  videos.map((m) => (
                    <VideoRow
                      key={m.id}
                      media={m}
                      track={kmlTracks.get(m.flightId) ?? null}
                      onDelete={() => handleDelete(m)}
                      onSynced={(offset) => setVideos((prev) =>
                        prev.map((v) => v.id === m.id ? { ...v, kmlOffsetSec: offset ?? null } : v)
                      )}
                      onFeaturedToggle={(featured) => setVideos((prev) =>
                        prev.map((v) => v.id === m.id ? { ...v, featured } : v)
                      )}
                      deleting={deleting.has(m.id)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        <p className="text-xs text-gray-700 font-mono mt-3">{videos.length} videos · {kmlTracks.size} KML tracks loaded</p>
      </div>

      {showUpload && (
        <VideoUploadModal
          flights={flights}
          kmlTracks={kmlTracks}
          onClose={() => setShowUpload(false)}
          onSuccess={(media) => {
            setVideos((prev) => [...prev, media].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
            setShowUpload(false);
          }}
        />
      )}
    </FlyingAdminLayout>
  );
}
