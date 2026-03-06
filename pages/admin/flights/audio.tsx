/**
 * Admin — Flight Audio
 *
 * Manages FlightAudio records: upload, KML sync, transcription, mixing preview.
 *
 * Sections:
 *   - Upload modal: drag/drop MP3/M4A/WAV, auto-detects duration, links to flight
 *   - Audio table: one row per record with inline controls
 *   - Sync modal:  audio player + map panel (same pattern as videos/ManualSyncModal)
 *   - Mix modal:   side-by-side audio players with Web Audio gain sliders
 *   - Transcript modal: viewer with raw/corrected diff + speaker colour coding
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
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
  kmlS3Key: string | null;
};

type FlightAudio = {
  id: string;
  flightId: string;
  s3Key: string;
  sourceType: "PERSONAL" | "LIVEATC" | "COCKPIT_EXTRACTED" | null;
  sourceUrl: string | null;
  label: string | null;
  frequency: string | null;
  durationSec: number | null;
  sortOrder: number | null;
  kmlOffsetSec: number | null;
  recordedAt: string | null;
  mixGain: number | null;
  transcriptStatus: "NONE" | "PENDING" | "PROCESSING" | "DONE" | "FAILED";
  transcriptProgress: number | null;
  transcriptError: string | null;
  transcript: string | null;
  signedUrl?: string;
  flightLabel?: string;
};

type TranscriptSegment = {
  startSec: number;
  endSec:   number;
  speaker:  "PILOT" | "ATC" | "UNKNOWN";
  raw:      string;
  text:     string;
};

type KmlTrack = {
  points: { t: number; lat: number; lon: number; alt: number }[];
  startUtc: Date | null;
  durationSec: number;
};

// ── Config ────────────────────────────────────────────────────────────────────

const BUCKET_NAME  = "gennaroanesi.com";
const AUDIO_PREFIX = "public/flights/audio/";

const SOURCE_LABEL: Record<string, string> = {
  PERSONAL:           "Personal",
  LIVEATC:            "LiveATC",
  COCKPIT_EXTRACTED:  "Cockpit (extracted)",
};

const STATUS_LABEL: Record<string, string> = {
  NONE:       "—",
  PENDING:    "Queued",
  PROCESSING: "Processing…",
  DONE:       "Done",
  FAILED:     "Failed",
};

const STATUS_COLOR: Record<string, string> = {
  NONE:       "text-gray-600",
  PENDING:    "text-yellow-500",
  PROCESSING: "text-blue-400 animate-pulse",
  DONE:       "text-green-400",
  FAILED:     "text-red-400",
};

const client = generateClient<Schema>();

function randomUUID(): string {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtOffset(sec: number): string {
  const abs = Math.abs(sec);
  const m = Math.floor(abs / 60);
  const s = (abs % 60).toFixed(1).padStart(4, "0");
  return `${sec < 0 ? "-" : "+"}${m}:${s}`;
}

// ── KML track parser (reused from videos admin) ──────────────────────────────

async function parseKmlTrack(url: string): Promise<KmlTrack | null> {
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) return null;
    const text = await res.text();
    let doc: Document | null = null;
    for (const mime of ["application/xml", "text/xml"] as DOMParserSupportedType[]) {
      try {
        const c = new DOMParser().parseFromString(text, mime);
        if (!c.querySelector("parsererror")) { doc = c; break; }
      } catch { /* */ }
    }
    if (!doc) return null;
    const whens  = Array.from(doc.getElementsByTagName("when"));
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
      points.push({ t: (ms - t0) / 1000, lat, lon, alt });
    }
    if (!points.length) return null;
    return {
      points,
      startUtc: new Date(whens[0].textContent?.trim() ?? ""),
      durationSec: points[points.length - 1].t,
    };
  } catch { return null; }
}

// ── Waveform Trimmer ─────────────────────────────────────────────────────────
// Draws waveform on a canvas and exposes draggable start/end handles.
// Returns the trimmed Blob (WAV) when the user is done.

function WaveformTrimmer({
  audioBuffer,
  startSec,
  endSec,
  duration,
  onChange,
}: {
  audioBuffer: AudioBuffer;
  startSec: number;
  endSec: number;
  duration: number;
  onChange: (start: number, end: number) => void;
}) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const rafRef     = useRef<number>(0);
  const dragging   = useRef<"start" | "end" | "region" | null>(null);
  const dragAnchor = useRef<{ x: number; start: number; end: number }>({ x: 0, start: 0, end: 0 });

  const HANDLE_W = 6;
  const H = 80;

  // Draw waveform + handles
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.width;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);

    // Waveform
    const data = audioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / W);
    ctx.fillStyle = "#374151"; // gray-700
    for (let x = 0; x < W; x++) {
      let min = 1, max = -1;
      for (let j = 0; j < step; j++) {
        const v = data[x * step + j] ?? 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const yTop  = ((1 - max) / 2) * H;
      const yBot  = ((1 - min) / 2) * H;
      ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
    }

    const sx = (startSec / duration) * W;
    const ex = (endSec   / duration) * W;

    // Dim outside region
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0,  0, sx, H);
    ctx.fillRect(ex, 0, W - ex, H);

    // Region highlight
    ctx.fillStyle = "rgba(96,165,250,0.10)";
    ctx.fillRect(sx, 0, ex - sx, H);

    // Handles
    ctx.fillStyle = "#60a5fa"; // blue-400
    ctx.fillRect(sx - HANDLE_W / 2, 0, HANDLE_W, H);
    ctx.fillRect(ex - HANDLE_W / 2, 0, HANDLE_W, H);

    // Time labels on handles
    ctx.fillStyle = "#e5e7eb";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText(fmtDuration(startSec), Math.max(sx, 22), H - 4);
    ctx.fillText(fmtDuration(endSec),   Math.min(ex, W - 22), H - 4);

    // Selection duration
    ctx.fillStyle = "#9ca3af";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText(`${fmtDuration(endSec - startSec)} selected`, W / 2, 14);
  }, [audioBuffer, startSec, endSec, duration]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width = canvas.offsetWidth;
      draw();
    });
    ro.observe(canvas);
    canvas.width = canvas.offsetWidth;
    draw();
    return () => ro.disconnect();
  }, [draw]);

  const secFromX = (x: number) => {
    const W = canvasRef.current!.offsetWidth;
    return Math.max(0, Math.min(duration, (x / W) * duration));
  };

  const hitTest = (x: number): "start" | "end" | "region" | null => {
    const W   = canvasRef.current!.offsetWidth;
    const sx  = (startSec / duration) * W;
    const ex  = (endSec   / duration) * W;
    const HIT = HANDLE_W + 4;
    if (Math.abs(x - sx) <= HIT) return "start";
    if (Math.abs(x - ex) <= HIT) return "end";
    if (x > sx && x < ex)        return "region";
    return null;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x    = e.clientX - rect.left;
    const hit  = hitTest(x);
    if (!hit) return;
    dragging.current   = hit;
    dragAnchor.current = { x, start: startSec, end: endSec };
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !canvasRef.current) return;
      const rect  = canvasRef.current.getBoundingClientRect();
      const dx    = e.clientX - rect.left - dragAnchor.current.x;
      const dt    = (dx / canvasRef.current.offsetWidth) * duration;
      const { start, end } = dragAnchor.current;
      const MIN_SEL = 1;
      if (dragging.current === "start") {
        const ns = Math.max(0, Math.min(start + dt, end - MIN_SEL));
        onChange(ns, end);
      } else if (dragging.current === "end") {
        const ne = Math.min(duration, Math.max(end + dt, start + MIN_SEL));
        onChange(start, ne);
      } else {
        // move whole region
        const len = end - start;
        const ns  = Math.max(0, Math.min(start + dt, duration - len));
        onChange(ns, ns + len);
      }
    };
    const onUp = () => { dragging.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
  }, [duration, onChange]);

  // cursor style
  const [cursor, setCursor] = useState("default");
  const onMouseMove = (e: React.MouseEvent) => {
    if (dragging.current) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const hit  = hitTest(e.clientX - rect.left);
    setCursor(hit === "start" || hit === "end" ? "ew-resize" : hit === "region" ? "grab" : "default");
  };

  return (
    <canvas
      ref={canvasRef}
      height={H}
      className="w-full rounded border border-darkBorder bg-darkBg block"
      style={{ cursor, height: H }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
    />
  );
}

// Re-encode a slice of an AudioBuffer as 16-bit PCM WAV (no external libs)
function audioBufferToWavBlob(buffer: AudioBuffer, startSec: number, endSec: number): Blob {
  const sampleRate  = buffer.sampleRate;
  const numChannels = buffer.numberOfChannels;
  const startFrame  = Math.floor(startSec * sampleRate);
  const endFrame    = Math.min(Math.ceil(endSec * sampleRate), buffer.length);
  const frameCount  = endFrame - startFrame;

  const bytesPerSample = 2; // 16-bit
  const dataLen  = frameCount * numChannels * bytesPerSample;
  const buf      = new ArrayBuffer(44 + dataLen);
  const view     = new DataView(buf);

  const writeStr = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeStr(0,  "RIFF");
  view.setUint32(4,  36 + dataLen, true);
  writeStr(8,  "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1,  true);  // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataLen, true);

  let offset = 44;
  for (let i = 0; i < frameCount; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = buffer.getChannelData(ch)[startFrame + i];
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

// ── Audio Upload Modal ────────────────────────────────────────────────────────

function AudioUploadModal({ flights, kmlTracks, onClose, onSuccess }: {
  flights: Flight[];
  kmlTracks: Map<string, KmlTrack>;
  onClose: () => void;
  onSuccess: (record: FlightAudio) => void;
}) {
  const [file,        setFile]        = useState<File | null>(null);
  const [duration,    setDuration]    = useState<number | null>(null);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [decoding,    setDecoding]    = useState(false);
  const [trimStart,   setTrimStart]   = useState(0);
  const [trimEnd,     setTrimEnd]     = useState(0);
  const [flightId,    setFlightId]    = useState("");
  const [label,       setLabel]       = useState("");
  const [sourceType,  setSourceType]  = useState<string>("PERSONAL");
  const [sourceUrl,   setSourceUrl]   = useState("");
  const [frequency,   setFrequency]   = useState("");
  const [sortOrder,   setSortOrder]   = useState(0);
  const [uploading,   setUploading]   = useState(false);
  const [progress,    setProgress]    = useState(0);
  const [error,       setError]       = useState<string | null>(null);

  const ACCEPTED = ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/ogg", "audio/aac"];

  const loadFile = async (f: File) => {
    setFile(f);
    setError(null);
    setDuration(null);
    setAudioBuffer(null);
    setDecoding(true);
    try {
      const arrayBuf = await f.arrayBuffer();
      const ac = new AudioContext();
      const decoded = await ac.decodeAudioData(arrayBuf);
      await ac.close();
      setAudioBuffer(decoded);
      setDuration(decoded.duration);
      setTrimStart(0);
      setTrimEnd(decoded.duration);
    } catch (e: any) {
      setError(`Could not decode audio: ${e.message}`);
    } finally {
      setDecoding(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && (ACCEPTED.includes(f.type) || f.name.match(/\.(mp3|m4a|wav|ogg|aac)$/i))) loadFile(f);
    else setError("Please drop an audio file (MP3, M4A, WAV, AAC, OGG)");
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) loadFile(f);
  };

  const handleUpload = async () => {
    if (!file || !flightId || !audioBuffer) return;
    setUploading(true);
    setError(null);
    setProgress(0);

    const isTrimmed = trimStart > 0 || trimEnd < (duration ?? 0);
    const trimmedDuration = trimEnd - trimStart;

    // Slice + re-encode to WAV client-side if trimmed, otherwise upload original
    const uploadBlob: Blob = isTrimmed
      ? audioBufferToWavBlob(audioBuffer, trimStart, trimEnd)
      : file;
    const uploadExt  = isTrimmed ? "wav" : (file.name.split(".").pop() ?? "mp3");
    const uploadType = isTrimmed ? "audio/wav" : (file.type || "audio/mpeg");

    const mediaId = randomUUID();
    const s3Key   = `${AUDIO_PREFIX}${mediaId}.${uploadExt}`;

    try {
      await uploadData({
        path: s3Key,
        data: uploadBlob,
        options: {
          bucket: BUCKET_NAME,
          contentType: uploadType,
          onProgress: ({ transferredBytes, totalBytes }) => {
            if (totalBytes) setProgress(Math.round((transferredBytes / totalBytes) * 100));
          },
        },
      }).result;

      const { data: created, errors } = await (client.models.flightAudio as any).create({
        id:          mediaId,
        flightId,
        s3Key,
        label:       label || null,
        sourceType:  sourceType || null,
        sourceUrl:   sourceUrl || null,
        frequency:   frequency || null,
        durationSec: trimmedDuration,
        sortOrder:   sortOrder ?? 0,
        mixGain:     1,
        transcriptStatus: "NONE",
      });
      if (errors?.length) throw new Error(errors[0].message);

      const flight = flights.find((f) => f.id === flightId);
      setTimeout(() => onSuccess({
        ...created,
        flightLabel: flight ? `${flight.date} ${flight.from}→${flight.to}` : flightId,
      }), 600);
    } catch (e: any) {
      setError(e.message ?? "Upload failed");
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-darkSurface border border-darkBorder rounded-lg w-full max-w-2xl mx-4 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-darkBorder">
          <h2 className="text-sm font-semibold text-gray-100">Upload Audio</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
        </div>
        <div className="p-5 flex flex-col gap-4">
          {/* Drop zone */}
          <div
            onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}
            onClick={() => document.getElementById("audio-file-input")?.click()}
            className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors
              ${file ? "border-blue-400/50 bg-blue-950/20" : "border-darkBorder hover:border-gray-500 bg-darkBg"}`}
          >
            <input id="audio-file-input" type="file"
              accept=".mp3,.m4a,.wav,.aac,.ogg,audio/*" className="hidden" onChange={handleFile} />
            {file ? (
              <div className="flex flex-col items-center gap-1.5">
                <span className="text-blue-400 text-sm font-mono">{file.name}</span>
                <div className="flex items-center gap-3 text-xs font-mono text-gray-400">
                  {duration !== null && <span>⏱ {fmtDuration(duration)}</span>}
                  <span>{(file.size / 1024 / 1024).toFixed(1)} MB</span>
                  {decoding && <span className="text-yellow-500 animate-pulse">decoding…</span>}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.5" className="text-gray-600">
                  <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                </svg>
                <span className="text-gray-500 text-sm">Drop MP3, M4A, or WAV here</span>
                <span className="text-xs text-gray-600">or click to browse</span>
              </div>
            )}
          </div>

          {/* Waveform trimmer — shown once audio is decoded */}
          {audioBuffer && duration !== null && !uploading && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500 font-mono uppercase tracking-wider">Trim</span>
                <div className="flex items-center gap-3 text-xs font-mono">
                  <span className="text-gray-500">
                    {fmtDuration(trimStart)} – {fmtDuration(trimEnd)}
                  </span>
                  <span className="text-blue-400">{fmtDuration(trimEnd - trimStart)}</span>
                  {(trimStart > 0 || trimEnd < duration) && (
                    <button
                      onClick={() => { setTrimStart(0); setTrimEnd(duration); }}
                      className="text-gray-600 hover:text-gray-400 transition-colors"
                      title="Reset trim">
                      ↺ reset
                    </button>
                  )}
                </div>
              </div>
              <WaveformTrimmer
                audioBuffer={audioBuffer}
                startSec={trimStart}
                endSec={trimEnd}
                duration={duration}
                onChange={(s, e) => { setTrimStart(s); setTrimEnd(e); }}
              />
              {(trimStart > 0 || trimEnd < duration) && (
                <p className="text-[11px] text-yellow-500/80 font-mono">
                  ⚠️ Will upload trimmed WAV — original file unchanged
                </p>
              )}
            </div>
          )}

          {uploading && (
            <div className="w-full bg-darkBg rounded-full h-1.5 overflow-hidden">
              <div className="bg-blue-400 h-full transition-all duration-200 rounded-full"
                style={{ width: `${progress}%` }} />
            </div>
          )}

          {/* Fields */}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs text-gray-500 font-mono uppercase tracking-wider mb-1 block">Flight *</label>
              <select value={flightId} onChange={(e) => setFlightId(e.target.value)}
                className="w-full bg-darkBg border border-darkBorder rounded px-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-gray-500 font-mono">
                <option value="">— select a flight —</option>
                {[...flights].sort((a, b) => b.date.localeCompare(a.date)).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.date} · {f.from}→{f.to}{f.title ? ` · ${f.title}` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs text-gray-500 font-mono uppercase tracking-wider mb-1 block">Source</label>
              <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}
                className="w-full bg-darkBg border border-darkBorder rounded px-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-gray-500">
                {Object.entries(SOURCE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs text-gray-500 font-mono uppercase tracking-wider mb-1 block">Frequency (MHz)</label>
              <input type="text" value={frequency} onChange={(e) => setFrequency(e.target.value)}
                placeholder="e.g. 125.025"
                className="w-full bg-darkBg border border-darkBorder rounded px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500 font-mono" />
            </div>

            <div className="col-span-2">
              <label className="text-xs text-gray-500 font-mono uppercase tracking-wider mb-1 block">Label</label>
              <input type="text" value={label} onChange={(e) => setLabel(e.target.value)}
                placeholder='e.g. "KAUS Approach 125.0" or "Cockpit intercom"'
                className="w-full bg-darkBg border border-darkBorder rounded px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500" />
            </div>

            {sourceType === "LIVEATC" && (
              <div className="col-span-2">
                <label className="text-xs text-gray-500 font-mono uppercase tracking-wider mb-1 block">LiveATC Source URL</label>
                <input type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)}
                  placeholder="https://archive.liveatc.net/…"
                  className="w-full bg-darkBg border border-darkBorder rounded px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500 font-mono" />
              </div>
            )}

            <div>
              <label className="text-xs text-gray-500 font-mono uppercase tracking-wider mb-1 block">Sort order</label>
              <input type="number" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value))} min={0}
                className="w-full bg-darkBg border border-darkBorder rounded px-3 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-gray-500 font-mono" />
            </div>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex gap-2 justify-end">
            <button onClick={onClose} className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors">Cancel</button>
            <button onClick={handleUpload} disabled={!file || !flightId || !audioBuffer || uploading || decoding}
              className={`px-4 py-1.5 text-sm rounded border transition-colors
                ${file && flightId && audioBuffer && !uploading && !decoding
                  ? "border-blue-400/50 text-blue-400 hover:bg-blue-950/30"
                  : "border-darkBorder text-gray-600 cursor-not-allowed"}`}>
              {uploading ? `Uploading… ${progress}%` : decoding ? "Decoding…" : "Upload Audio"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sync Modal ────────────────────────────────────────────────────────────────
// Audio player + mini-map panel. Slider sets kmlOffsetSec.

const PANEL_W = 280, PANEL_H = 185, PAD = 10;
const NM_TO_DEG = 1 / 60;
const HALF_NM   = 3.5;

function interpolate(
  points: KmlTrack["points"], t: number
): { lat: number; lon: number; alt: number } | null {
  if (!points.length) return null;
  if (t <= points[0].t) return points[0];
  if (t >= points[points.length - 1].t) return points[points.length - 1];
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid].t <= t) lo = mid; else hi = mid; }
  const a = points[lo], b = points[hi], f = (t - a.t) / (b.t - a.t);
  return { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon), alt: a.alt + f * (b.alt - a.alt) };
}

function AudioSyncModal({ audio, track, onClose, onSaved }: {
  audio: FlightAudio;
  track: KmlTrack;
  onClose: () => void;
  onSaved: (offset: number) => void;
}) {
  const audioRef   = useRef<HTMLAudioElement>(null);
  const rafRef     = useRef<number>(0);
  const savedOffset = audio.kmlOffsetSec ?? 0;

  const [audioTime, setAudioTime] = useState(0);
  const [offsetSec, setOffsetSec] = useState(savedOffset);
  const [saving,    setSaving]    = useState(false);

  const isDirty = offsetSec !== savedOffset;
  const currentTrackSec = offsetSec + audioTime;

  useEffect(() => {
    const tick = () => {
      setAudioTime(audioRef.current?.currentTime ?? 0);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // Map geometry
  const pos = interpolate(track.points, currentTrackSec);
  const cLat = pos?.lat ?? track.points[Math.floor(track.points.length / 2)].lat;
  const cLon = pos?.lon ?? track.points[Math.floor(track.points.length / 2)].lon;
  const halfLat = HALF_NM * NM_TO_DEG;
  const halfLon = HALF_NM * NM_TO_DEG / Math.cos((cLat * Math.PI) / 180);
  const minLat = cLat - halfLat, maxLat = cLat + halfLat;
  const minLon = cLon - halfLon, maxLon = cLon + halfLon;
  const iW = PANEL_W - PAD * 2, iH = PANEL_H - PAD * 2;
  const scale = Math.min(iW / (maxLon - minLon), iH / (maxLat - minLat));
  const oX = PAD + (iW - (maxLon - minLon) * scale) / 2;
  const oY = PAD + (iH - (maxLat - minLat) * scale) / 2;
  const sv = (lat: number, lon: number) => ({
    x: oX + (lon - minLon) * scale,
    y: oY + (maxLat - lat) * scale,
  });
  const mapPts = track.points.map((p) => { const s = sv(p.lat, p.lon); return `${s.x},${s.y}`; }).join(" ");
  const flownIdx = track.points.findIndex((p) => p.t > currentTrackSec);
  const flownPts = (flownIdx <= 0 ? track.points : track.points.slice(0, flownIdx + 1))
    .map((p) => { const s = sv(p.lat, p.lon); return `${s.x},${s.y}`; }).join(" ");
  const dot = pos ? sv(pos.lat, pos.lon) : null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const rounded = Math.round(offsetSec * 10) / 10;
      await (client.models.flightAudio as any).update({ id: audio.id, kmlOffsetSec: rounded });
      onSaved(rounded);
    } catch (e: any) {
      alert(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-darkSurface border border-darkBorder rounded-lg w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col"
        style={{ maxHeight: "90vh" }}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-darkBorder">
          <div>
            <span className="text-sm font-semibold text-gray-100">Sync Audio to Track</span>
            <span className="text-xs text-gray-500 font-mono ml-3">{audio.label ?? audio.s3Key.split("/").pop()}</span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
        </div>

        <div className="flex gap-4 p-4 items-start">
          {/* Audio player */}
          <div className="flex-1 flex flex-col gap-2">
            <audio ref={audioRef} src={audio.signedUrl} controls
              className="w-full rounded border border-darkBorder bg-darkBg" />
            <div className="text-[10px] font-mono text-gray-600 text-center">
              audio {audioTime.toFixed(1)}s → track {currentTrackSec.toFixed(1)}s
            </div>
          </div>

          {/* Map panel */}
          <svg width={PANEL_W} height={PANEL_H}
            style={{ background: "rgba(10,14,26,0.95)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
            <polyline points={mapPts} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
            <polyline points={flownPts} fill="none" stroke="#facc15" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
            {dot && (
              <>
                <circle cx={dot.x} cy={dot.y} r={7} fill="#facc15" opacity={0.18} />
                <circle cx={dot.x} cy={dot.y} r={4} fill="#facc15" />
              </>
            )}
          </svg>
        </div>

        {/* Offset slider */}
        <div className="px-4 pb-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-gray-500 uppercase tracking-wider">
              offset — where on the track does sample 0 land?
            </span>
            <span className="text-sm font-mono text-gold tabular-nums">{fmtOffset(offsetSec)}</span>
          </div>
          <input type="range" min={0} max={track.durationSec} step={1} value={offsetSec}
            onChange={(e) => setOffsetSec(Number(e.target.value))}
            className="w-full accent-yellow-400" />
          <div className="flex justify-between text-[10px] font-mono text-gray-700">
            <span>track start</span>
            <span>{fmtDuration(track.durationSec)} (track end)</span>
          </div>
        </div>

        <div className="flex items-center justify-between px-4 pb-4">
          <button onClick={() => setOffsetSec(savedOffset)} disabled={!isDirty}
            className="text-xs font-mono text-gray-600 hover:text-gray-300 disabled:opacity-30 transition-colors">
            ↺ reset ({fmtOffset(savedOffset)})
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors">Cancel</button>
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-1.5 text-sm rounded border border-green-500/50 text-green-400 hover:bg-green-950/30 transition-colors disabled:opacity-40">
              {saving ? "Saving…" : "Save offset"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Mix Modal ─────────────────────────────────────────────────────────────────
// Side-by-side audio sources with Web Audio API gain control.
// One AudioContext; each track is a MediaElementAudioSourceNode → GainNode → destination.
// Gain is persisted to flightAudio.mixGain on save.

function MixModal({ tracks, onClose, onGainSaved }: {
  tracks: FlightAudio[];
  onClose: () => void;
  onGainSaved: (id: string, gain: number) => void;
}) {
  const ctxRef    = useRef<AudioContext | null>(null);
  const gainNodes = useRef<Map<string, GainNode>>(new Map());
  const sourceNodes = useRef<Map<string, MediaElementAudioSourceNode>>(new Map());
  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());

  const [gains, setGains] = useState<Record<string, number>>(
    Object.fromEntries(tracks.map((t) => [t.id, t.mixGain ?? 1]))
  );
  const [saving, setSaving] = useState<Set<string>>(new Set());

  const getCtx = useCallback(() => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  }, []);

  const connectAudio = useCallback((id: string, el: HTMLAudioElement) => {
    if (sourceNodes.current.has(id)) return; // already connected
    const ctx = getCtx();
    const source = ctx.createMediaElementSource(el);
    const gain   = ctx.createGain();
    gain.gain.value = gains[id] ?? 1;
    source.connect(gain);
    gain.connect(ctx.destination);
    sourceNodes.current.set(id, source);
    gainNodes.current.set(id, gain);
  }, [gains, getCtx]);

  const setGain = (id: string, val: number) => {
    setGains((prev) => ({ ...prev, [id]: val }));
    const node = gainNodes.current.get(id);
    if (node) node.gain.value = val;
  };

  const saveGain = async (id: string) => {
    setSaving((s) => new Set(s).add(id));
    try {
      const val = Math.round((gains[id] ?? 1) * 100) / 100;
      await (client.models.flightAudio as any).update({ id, mixGain: val });
      onGainSaved(id, val);
    } catch (e: any) {
      alert(`Save failed: ${e.message}`);
    } finally {
      setSaving((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  useEffect(() => {
    return () => {
      ctxRef.current?.close();
    };
  }, []);

  const SPEAKER_COLOR: Record<string, string> = { PILOT: "#facc15", ATC: "#60a5fa", UNKNOWN: "#6b7280" };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-darkSurface border border-darkBorder rounded-lg w-full max-w-4xl shadow-2xl overflow-hidden flex flex-col"
        style={{ maxHeight: "90vh" }}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-darkBorder">
          <span className="text-sm font-semibold text-gray-100">Audio Mix Preview</span>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
        </div>

        <div className="p-4 overflow-y-auto flex flex-col gap-4">
          <p className="text-xs text-gray-500 font-mono">
            All tracks share one audio context. Adjust gain per track; click ✓ to persist.
          </p>

          {tracks.map((t) => (
            <div key={t.id} className="flex flex-col gap-2 p-3 rounded border border-darkBorder bg-darkBg">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-semibold text-gray-200">{t.label ?? "Unlabeled"}</span>
                  {t.frequency && (
                    <span className="text-xs font-mono text-gray-500 ml-2">{t.frequency} MHz</span>
                  )}
                  <span className="text-xs text-gray-600 ml-2">
                    {SOURCE_LABEL[t.sourceType ?? ""] ?? ""}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-gray-500 w-8 text-right">
                    {Math.round((gains[t.id] ?? 1) * 100)}%
                  </span>
                  <button onClick={() => saveGain(t.id)} disabled={saving.has(t.id)}
                    className="text-xs text-green-500/80 hover:text-green-400 disabled:opacity-40 transition-colors"
                    title="Save gain">
                    {saving.has(t.id) ? "…" : "✓"}
                  </button>
                </div>
              </div>

              {/* Gain slider */}
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-mono text-gray-600 w-4">0</span>
                <input type="range" min={0} max={1} step={0.01}
                  value={gains[t.id] ?? 1}
                  onChange={(e) => setGain(t.id, Number(e.target.value))}
                  className="flex-1 accent-yellow-400" />
                <span className="text-[10px] font-mono text-gray-600 w-4">1</span>
              </div>

              {/* Audio element — connected to Web Audio on first play */}
              {t.signedUrl && (
                <audio
                  ref={(el) => {
                    if (el) {
                      audioRefs.current.set(t.id, el);
                      el.onplay = () => {
                        getCtx().resume();
                        connectAudio(t.id, el);
                      };
                    }
                  }}
                  src={t.signedUrl}
                  controls
                  className="w-full rounded border border-darkBorder/50 mt-1"
                  style={{ height: 32 }}
                />
              )}
            </div>
          ))}
        </div>

        <div className="px-4 pb-4 flex justify-end">
          <button onClick={onClose}
            className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Transcript Modal (with inline editing + AI assistant pane) ─────────────────

const SPEAKER_CYCLE: TranscriptSegment["speaker"][] = ["PILOT", "ATC", "UNKNOWN"];

const SPEAKER_COLOR: Record<string, string> = {
  PILOT:   "text-gold border-gold/30 bg-gold/5",
  ATC:     "text-blue-400 border-blue-400/30 bg-blue-950/20",
  UNKNOWN: "text-gray-500 border-gray-700 bg-darkBg",
};
const SPEAKER_BADGE: Record<string, string> = {
  PILOT:   "bg-gold/20 text-gold hover:bg-gold/30",
  ATC:     "bg-blue-900/50 text-blue-300 hover:bg-blue-900",
  UNKNOWN: "bg-gray-800 text-gray-500 hover:bg-gray-700",
};

type AiMessage = { role: "user" | "assistant"; content: string };

function TranscriptModal({ audio, onClose, onSaved, onNeedSignedUrl }: {
  audio: FlightAudio;
  onClose: () => void;
  onSaved: (transcript: string) => void;
  onNeedSignedUrl?: () => Promise<string>;
}) {
  const initial: TranscriptSegment[] = React.useMemo(() => {
    try { return JSON.parse(audio.transcript ?? "[]"); }
    catch { return []; }
  }, [audio.transcript]);

  // ─ editor state ─────────────────────────────────────────────────────────────
  const [segments,   setSegments]   = useState<TranscriptSegment[]>(initial);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editText,   setEditText]   = useState("");
  const [showRaw,    setShowRaw]    = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [dirty,      setDirty]      = useState(false);
  const textareaRef  = useRef<HTMLTextAreaElement>(null);

  // ─ fresh signed URL (re-fetched on mount to avoid expiry) ─────────────────
  const [freshSignedUrl, setFreshSignedUrl] = useState<string>(audio.signedUrl ?? "");
  useEffect(() => {
    if (!onNeedSignedUrl) return;
    onNeedSignedUrl().then(url => { if (url) setFreshSignedUrl(url); });
  }, []);

  // ─ playback state ───────────────────────────────────────────────────────────
  const audioRef      = useRef<HTMLAudioElement>(null);
  const segmentRefs   = useRef<(HTMLDivElement | null)[]>([]);
  const rafRef        = useRef<number>(0);
  const [playing,     setPlaying]     = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration,    setAudioDuration] = useState(0);
  const [activeSeg,   setActiveSeg]   = useState<number | null>(null);
  const lastAutoScrolled = useRef<number | null>(null);

  // RAF loop — runs only while playing
  useEffect(() => {
    if (!playing) { cancelAnimationFrame(rafRef.current); return; }
    const tick = () => {
      const el = audioRef.current;
      if (!el) return;
      const t = el.currentTime;
      setCurrentTime(t);
      // find active segment
      const idx = segments.findIndex(s => t >= s.startSec && t < s.endSec);
      setActiveSeg(idx >= 0 ? idx : null);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, segments]);

  // Auto-scroll active segment into view (only when it changes)
  useEffect(() => {
    if (activeSeg === null || activeSeg === lastAutoScrolled.current) return;
    lastAutoScrolled.current = activeSeg;
    segmentRefs.current[activeSeg]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeSeg]);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); setPlaying(false); }
    else         { el.play(); setPlaying(true); }
  };

  // Click a segment timestamp → seek there
  const seekTo = (sec: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = sec;
    setCurrentTime(sec);
    if (!playing) { el.play(); setPlaying(true); }
  };

  const fmtTime = (s: number) => {
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${ss.toString().padStart(2, "0")}`;
  };

  // ─ AI pane state ──────────────────────────────────────────────────────────
  const [aiMessages,  setAiMessages]  = useState<AiMessage[]>([]);
  const [aiInput,     setAiInput]     = useState("");
  const [aiWorking,   setAiWorking]   = useState(false);
  // pending = proposed segments from AI, waiting for accept/reject
  const [pending,     setPending]     = useState<TranscriptSegment[] | null>(null);
  const aiScrollRef  = useRef<HTMLDivElement>(null);
  const aiInputRef   = useRef<HTMLTextAreaElement>(null);

  // auto-scroll AI pane
  useEffect(() => {
    if (aiScrollRef.current) aiScrollRef.current.scrollTop = aiScrollRef.current.scrollHeight;
  }, [aiMessages, aiWorking]);

  // Auto-grow inline edit textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
    }
  }, [editText]);

  // ─ inline edit helpers ─────────────────────────────────────────────────────
  const commitEdit = useCallback(() => {
    setEditingIdx(prev => {
      if (prev === null) return null;
      setEditText(t => {
        const trimmed = t.trim();
        setSegments(segs => segs.map((s, i) =>
          i === prev && trimmed !== s.text ? { ...s, text: trimmed } : s
        ));
        if (trimmed !== segments[prev]?.text) setDirty(true);
        return t;
      });
      return null;
    });
  }, [segments]);

  const startEdit = (i: number) => {
    setEditingIdx(prev => { if (prev !== null) commitEdit(); return null; });
    setEditingIdx(i);
    setEditText(segments[i].text);
  };

  useEffect(() => {
    if (editingIdx !== null) textareaRef.current?.focus();
  }, [editingIdx]);

  const cycleSpeaker = (i: number) => {
    const cur = segments[i].speaker;
    const next = SPEAKER_CYCLE[(SPEAKER_CYCLE.indexOf(cur) + 1) % SPEAKER_CYCLE.length];
    setSegments(prev => prev.map((s, idx) => idx === i ? { ...s, speaker: next } : s));
    setDirty(true);
  };

  // ─ AI assistant ────────────────────────────────────────────────────────────
  const sendAiMessage = async () => {
    const msg = aiInput.trim();
    if (!msg || aiWorking) return;
    setAiInput("");
    setAiWorking(true);

    const userMsg: AiMessage = { role: "user", content: msg };
    setAiMessages(prev => [...prev, userMsg]);

    // Build conversation history for the API
    const history: AiMessage[] = [...aiMessages, userMsg];

    const systemPrompt = `You are an expert ATC (Air Traffic Control) transcript editor. 
The user will ask you to correct errors in a flight audio transcript.
The transcript is an array of segment objects with this shape:
  { startSec: number, endSec: number, speaker: "PILOT"|"ATC"|"UNKNOWN", raw: string, text: string }

When the user asks you to make edits:
1. Apply ONLY the requested changes. Do not alter anything else.
2. Return ONLY a valid JSON array of ALL segments (even unchanged ones), with the corrections applied.
3. Do NOT wrap in markdown code fences. Return raw JSON only.
4. If the user asks a question rather than requesting edits, answer conversationally and do NOT return JSON.

Current transcript:
${JSON.stringify(segments)}`;

    try {
      const res = await fetch("/api/anthropic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system: systemPrompt,
          messages: history.map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json();
      const raw = data.content?.find((b: any) => b.type === "text")?.text ?? "";

      // Try to parse as JSON (proposed segments)
      let parsed: TranscriptSegment[] | null = null;
      try {
        const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
        const candidate = JSON.parse(cleaned);
        if (Array.isArray(candidate) && candidate.length > 0 && "startSec" in candidate[0]) {
          parsed = candidate;
        }
      } catch { /* not JSON — conversational reply */ }

      if (parsed) {
        setPending(parsed);
        const changedCount = parsed.filter((s, i) => s.text !== segments[i]?.text || s.speaker !== segments[i]?.speaker).length;
        setAiMessages(prev => [...prev, {
          role: "assistant",
          content: `I've applied your edits. ${changedCount} segment${changedCount !== 1 ? "s" : ""} changed. Review the proposed changes below and accept or reject.`,
        }]);
      } else {
        setAiMessages(prev => [...prev, { role: "assistant", content: raw }]);
      }
    } catch (e: any) {
      setAiMessages(prev => [...prev, { role: "assistant", content: `Error: ${e.message}` }]);
    } finally {
      setAiWorking(false);
    }
  };

  const acceptPending = () => {
    if (!pending) return;
    setSegments(pending);
    setPending(null);
    setDirty(true);
    setAiMessages(prev => [...prev, { role: "assistant", content: "✔ Changes accepted and applied to the transcript." }]);
  };

  const rejectPending = () => {
    setPending(null);
    setAiMessages(prev => [...prev, { role: "assistant", content: "✕ Changes discarded. The transcript is unchanged." }]);
  };

  // ─ save / close ─────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    try {
      const json = JSON.stringify(segments);
      await (client.models.flightAudio as any).update({ id: audio.id, transcript: json });
      onSaved(json);
      setDirty(false);
    } catch (e: any) {
      alert(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (dirty && !confirm("You have unsaved changes. Discard them?")) return;
    onClose();
  };

  // ─ diff helper: which segments changed in pending vs current ──────────────────
  const changedIndices = React.useMemo(() => {
    if (!pending) return new Set<number>();
    return new Set(pending
      .map((s, i) => (s.text !== segments[i]?.text || s.speaker !== segments[i]?.speaker) ? i : -1)
      .filter(i => i >= 0)
    );
  }, [pending, segments]);

  // active segments to display (pending preview or current)
  const displaySegments = pending ?? segments;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-3">
      <div
        className="bg-darkSurface border border-darkBorder rounded-lg shadow-2xl flex flex-col"
        style={{ width: "min(1200px, 96vw)", height: "min(88vh, 900px)" }}
      >
        {/* Hidden audio element */}
        {freshSignedUrl && (
          <audio
            ref={audioRef}
            src={freshSignedUrl}
            onLoadedMetadata={() => setAudioDuration(audioRef.current?.duration ?? 0)}
            onEnded={() => { setPlaying(false); setActiveSeg(null); }}
            onPause={() => setPlaying(false)}
            onPlay={() => setPlaying(true)}
            preload="metadata"
          />
        )}

        {/* ─── Header ─── */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-darkBorder shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-gray-100">Transcript Editor</span>
            <span className="text-xs text-gray-500 font-mono">{audio.label ?? "—"}</span>
            <span className="text-xs text-gray-700 font-mono">· {segments.length} segments</span>
          </div>
          <div className="flex items-center gap-4">

            {/* ─ Playback controls ─ */}
            {freshSignedUrl && (
              <div className="flex items-center gap-2.5">
                {/* Play/Pause */}
                <button
                  onClick={togglePlay}
                  className="w-7 h-7 flex items-center justify-center rounded-full border border-gray-600
                    text-gray-300 hover:border-white hover:text-white transition-colors"
                  title={playing ? "Pause" : "Play"}>
                  {playing ? (
                    /* Pause icon */
                    <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor">
                      <rect x="0" y="0" width="3" height="12" rx="1"/>
                      <rect x="6" y="0" width="3" height="12" rx="1"/>
                    </svg>
                  ) : (
                    /* Play icon */
                    <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor">
                      <path d="M0 0 L10 6 L0 12 Z"/>
                    </svg>
                  )}
                </button>

                {/* Scrub bar */}
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-mono text-gray-500 w-8 text-right tabular-nums">
                    {fmtTime(currentTime)}
                  </span>
                  <div className="relative w-36 h-1 bg-gray-800 rounded-full cursor-pointer"
                    onClick={(e) => {
                      if (!audioRef.current || !duration) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const pct  = (e.clientX - rect.left) / rect.width;
                      audioRef.current.currentTime = pct * duration;
                    }}>
                    <div
                      className="absolute inset-y-0 left-0 bg-white/60 rounded-full pointer-events-none"
                      style={{ width: duration ? `${(currentTime / duration) * 100}%` : "0%" }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-gray-600 w-8 tabular-nums">
                    {fmtTime(duration)}
                  </span>
                </div>
              </div>
            )}

            <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
              <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)}
                className="accent-yellow-400" />
              raw ASR
            </label>
            {dirty && (
              <span className="text-xs font-mono text-yellow-500">● unsaved</span>
            )}
            <button onClick={handleSave} disabled={!dirty || saving}
              className={`px-3 py-1 text-xs rounded border transition-colors ${
                dirty && !saving
                  ? "border-green-500/50 text-green-400 hover:bg-green-950/30"
                  : "border-darkBorder text-gray-600 cursor-not-allowed"
              }`}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button onClick={handleClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
          </div>
        </div>

        {/* pending accept/reject banner */}
        {pending && (
          <div className="shrink-0 px-5 py-2 bg-yellow-950/40 border-b border-yellow-700/30 flex items-center justify-between">
            <span className="text-xs text-yellow-300">
              ⚠️ AI proposed {changedIndices.size} change{changedIndices.size !== 1 ? "s" : ""} — highlighted below
            </span>
            <div className="flex gap-2">
              <button onClick={rejectPending}
                className="px-3 py-1 text-xs border border-red-700/50 text-red-400 rounded hover:bg-red-950/30 transition-colors">
                ✕ Reject
              </button>
              <button onClick={acceptPending}
                className="px-3 py-1 text-xs border border-green-600/50 text-green-400 rounded hover:bg-green-950/30 transition-colors">
                ✔ Accept
              </button>
            </div>
          </div>
        )}

        {/* ─── Body: two panes ─── */}
        <div className="flex flex-1 min-h-0">

          {/* LEFT: segment editor */}
          <div className="flex flex-col flex-1 min-w-0 border-r border-darkBorder">
            <div className="px-4 py-2 border-b border-darkBorder/50 shrink-0">
              <span className="text-[11px] text-gray-600">
                Click <span className="font-mono bg-gray-800 px-1 rounded">speaker</span> to cycle · Click text to edit inline
              </span>
            </div>
            <div className="overflow-y-auto p-3 flex flex-col flex-1">
              {displaySegments.length === 0 ? (
                <p className="text-xs text-gray-600 font-mono text-center py-8">No segments</p>
              ) : displaySegments.map((seg, i) => {
                const isChanged = changedIndices.has(i);
                const isActive  = activeSeg === i;

                // Gap before this segment
                const prevEnd   = i === 0 ? 0 : displaySegments[i - 1].endSec;
                const gapSec    = seg.startSec - prevEnd;
                const MIN_GAP   = 0.5; // don't render tiny gaps
                // Is playhead currently in this gap?
                const gapActive = playing && currentTime >= prevEnd && currentTime < seg.startSec && gapSec > MIN_GAP;

                return (
                  <React.Fragment key={i}>
                  {/* Silence gap */}
                  {gapSec > MIN_GAP && (
                    <div
                      className={`flex items-center gap-2 px-3 transition-opacity ${
                        gapActive ? "opacity-100" : "opacity-30 hover:opacity-60"
                      }`}
                      style={{ height: Math.max(12, Math.min(40, gapSec * 1.2)) }}
                    >
                      <div className={`flex-1 border-t border-dashed transition-colors ${
                        gapActive ? "border-white/40" : "border-gray-700"
                      }`} />
                      <span className={`text-[9px] font-mono shrink-0 transition-colors ${
                        gapActive ? "text-white/50" : "text-gray-700"
                      }`}>
                        {gapSec >= 60
                          ? `${Math.floor(gapSec / 60)}m ${Math.round(gapSec % 60)}s silence`
                          : `${Math.round(gapSec)}s silence`}
                      </span>
                      <div className={`flex-1 border-t border-dashed transition-colors ${
                        gapActive ? "border-white/40" : "border-gray-700"
                      }`} />
                    </div>
                  )}

                  <div
                    ref={(el) => { segmentRefs.current[i] = el; }}
                    className={`rounded border px-3 py-2 mb-1.5 transition-all duration-150 ${
                      isActive
                        ? "border-white/80 shadow-[0_0_0_1px_rgba(255,255,255,0.25)] bg-white/[0.04]"
                        : isChanged
                          ? "border-yellow-600/60 bg-yellow-950/20"
                          : editingIdx === i
                            ? "border-gray-500 bg-gray-900"
                            : SPEAKER_COLOR[seg.speaker] ?? SPEAKER_COLOR.UNKNOWN
                    }`}>
                    <div className="flex items-center gap-2 mb-1">
                      <button
                        onClick={() => !pending && cycleSpeaker(i)}
                        disabled={!!pending}
                        title={pending ? "Accept or reject AI changes first" : "Click to change speaker"}
                        className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded transition-colors ${
                          pending ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                        } ${SPEAKER_BADGE[seg.speaker] ?? SPEAKER_BADGE.UNKNOWN}`}>
                        {seg.speaker}
                      </button>
                      <button
                        onClick={() => seekTo(seg.startSec)}
                        title="Click to seek here"
                        className={`text-[10px] font-mono transition-colors ${
                          isActive ? "text-white/80" : "text-gray-600 hover:text-gray-400"
                        }`}>
                        {fmtDuration(seg.startSec)} – {fmtDuration(seg.endSec)}
                      </button>
                      {isActive && (
                        <span className="text-[10px] font-mono text-white/50 ml-auto flex items-center gap-1">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                          playing
                        </span>
                      )}
                      {!isActive && isChanged && (
                        <span className="text-[10px] font-mono text-yellow-500 ml-auto">• changed</span>
                      )}
                    </div>

                    {!pending && editingIdx === i ? (
                      <textarea
                        ref={textareaRef}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onBlur={() => {
                          const trimmed = editText.trim();
                          if (trimmed !== segments[i].text) {
                            setSegments(prev => prev.map((s, idx) => idx === i ? { ...s, text: trimmed } : s));
                            setDirty(true);
                          }
                          setEditingIdx(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Tab") {
                            e.preventDefault();
                            const trimmed = editText.trim();
                            if (trimmed !== segments[i].text) {
                              setSegments(prev => prev.map((s, idx) => idx === i ? { ...s, text: trimmed } : s));
                              setDirty(true);
                            }
                            setEditingIdx(null);
                          }
                          if (e.key === "Escape") setEditingIdx(null);
                        }}
                        className="w-full bg-transparent text-sm text-gray-100 leading-snug resize-none focus:outline-none border-none p-0 font-sans"
                        rows={1}
                      />
                    ) : (
                      <p
                        onClick={() => !pending && startEdit(i)}
                        title={pending ? undefined : "Click to edit"}
                        className={`text-sm leading-snug ${
                          pending
                            ? "text-gray-300 cursor-default"
                            : "text-gray-200 cursor-text hover:text-white"
                        } transition-colors`}>
                        {seg.text}
                      </p>
                    )}

                    {/* Show original below changed line when in pending preview */}
                    {isChanged && segments[i] && (
                      <p className="text-xs text-gray-600 font-mono mt-1 line-through decoration-red-900/60 text-red-400/60">
                        {segments[i].text}
                      </p>
                    )}

                    {showRaw && seg.raw && seg.raw !== seg.text && (
                      <p className="text-xs text-gray-600 font-mono mt-1 italic line-through decoration-gray-700">
                        {seg.raw}
                      </p>
                    )}
                  </div>
                  </React.Fragment>
                );
              })}
            </div>
          </div>

          {/* RIGHT: AI assistant pane */}
          <div className="flex flex-col w-80 shrink-0">
            <div className="px-4 py-2 border-b border-darkBorder/50 shrink-0 flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-400">AI Editor</span>
              <span className="text-[10px] text-gray-600 font-mono">claude-sonnet</span>
            </div>

            {/* Message history */}
            <div ref={aiScrollRef} className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 min-h-0">
              {aiMessages.length === 0 && (
                <div className="text-xs text-gray-600 font-mono leading-relaxed pt-2">
                  <p className="mb-2">Describe edits in plain English. Examples:</p>
                  <ul className="space-y-1 text-gray-700">
                    <li>“Replace all mentions of Houston Tower with Easterwood Tower”</li>
                    <li>“Mark all segments where the speaker says N1232G as PILOT”</li>
                    <li>“Fix frequency 134.3 to 134.35 throughout”</li>
                  </ul>
                </div>
              )}
              {aiMessages.map((m, i) => (
                <div key={i} className={`text-xs leading-relaxed rounded px-2.5 py-2 ${
                  m.role === "user"
                    ? "bg-gray-800 text-gray-200 ml-4"
                    : "bg-darkBg border border-darkBorder text-gray-300 mr-4"
                }`}>
                  {m.content}
                </div>
              ))}
              {aiWorking && (
                <div className="text-xs text-gray-600 font-mono animate-pulse px-2 py-1">
                  thinking…
                </div>
              )}
            </div>

            {/* Input */}
            <div className="shrink-0 border-t border-darkBorder p-3">
              <div className="flex gap-2 items-end">
                <textarea
                  ref={aiInputRef}
                  value={aiInput}
                  onChange={(e) => {
                    setAiInput(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendAiMessage();
                    }
                  }}
                  disabled={aiWorking || !!pending}
                  placeholder={pending ? "Accept or reject changes first…" : "Describe an edit… (Enter to send)"}
                  rows={2}
                  className="flex-1 bg-darkBg border border-darkBorder rounded px-2.5 py-1.5 text-xs text-gray-200
                    placeholder-gray-600 resize-none focus:outline-none focus:border-gray-500
                    disabled:opacity-40 disabled:cursor-not-allowed"
                />
                <button
                  onClick={sendAiMessage}
                  disabled={!aiInput.trim() || aiWorking || !!pending}
                  className="px-2.5 py-1.5 text-xs border border-blue-500/40 text-blue-400 rounded
                    hover:bg-blue-950/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0">
                  ↑
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Audio Row ─────────────────────────────────────────────────────────────────

function AudioRow({ audio, track, allAudioForFlight, onDelete, onSynced, onGainSaved, onTranscriptUpdate, deleting }: {
  audio: FlightAudio;
  track: KmlTrack | null;
  allAudioForFlight: FlightAudio[];
  onDelete: () => void;
  onSynced: (offset: number | null) => void;
  onGainSaved: (gain: number) => void;
  onTranscriptUpdate: (status: string, transcript: string | null, error: string | null, progress?: number | null) => void;
  deleting: boolean;
}) {
  const [showSync,       setShowSync]       = useState(false);
  const [showMix,        setShowMix]        = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [triggering,     setTriggering]     = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll for transcript status when PENDING or PROCESSING
  useEffect(() => {
    if (!["PENDING", "PROCESSING"].includes(audio.transcriptStatus)) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await (client.models.flightAudio as any).get({ id: audio.id });
        if (data) {
          // Always update progress when PROCESSING, update status on any change
          if (data.transcriptStatus !== audio.transcriptStatus ||
              (data.transcriptStatus === "PROCESSING" && data.transcriptProgress !== audio.transcriptProgress)) {
            onTranscriptUpdate(
              data.transcriptStatus,
              data.transcript ?? null,
              data.transcriptError ?? null,
              data.transcriptProgress ?? null,
            );
          }
        }
        if (!["PENDING", "PROCESSING"].includes(data?.transcriptStatus)) {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        }
      } catch { /* ignore polling errors */ }
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [audio.id, audio.transcriptStatus, onTranscriptUpdate]);

  const triggerTranscription = async () => {
    if (!confirm("Start transcription? This will queue the audio for processing (takes 4-10 minutes).")) return;
    setTriggering(true);
    try {
      await (client.models.flightAudio as any).update({ id: audio.id, transcriptStatus: "PENDING" });
      onTranscriptUpdate("PENDING", null, null);
    } catch (e: any) {
      alert(`Failed to queue: ${e.message}`);
    } finally {
      setTriggering(false);
    }
  };

  const retryTranscription = async () => {
    setTriggering(true);
    try {
      // Reset to NONE first (clears the error), then PENDING to re-trigger
      await (client.models.flightAudio as any).update({
        id: audio.id, transcriptStatus: "NONE", transcriptError: null, transcript: null,
      });
      await (client.models.flightAudio as any).update({ id: audio.id, transcriptStatus: "PENDING" });
      onTranscriptUpdate("PENDING", null, null);
    } catch (e: any) {
      alert(`Retry failed: ${e.message}`);
    } finally {
      setTriggering(false);
    }
  };

  const transcriptAction = () => {
    if (audio.transcriptStatus === "DONE") return (
      <button onClick={() => setShowTranscript(true)}
        className="text-xs font-mono text-green-400 hover:text-green-300 underline underline-offset-2 transition-colors">
        view
      </button>
    );
    if (audio.transcriptStatus === "FAILED") return (
      <button onClick={retryTranscription} disabled={triggering}
        className="text-xs font-mono text-red-400 hover:text-red-300 underline underline-offset-2 transition-colors disabled:opacity-40"
        title={audio.transcriptError ?? ""}>
        retry
      </button>
    );
    if (["PENDING", "PROCESSING"].includes(audio.transcriptStatus)) return (
      <span className="text-xs font-mono text-gray-600">…</span>
    );
    // NONE
    return (
      <button onClick={triggerTranscription} disabled={triggering}
        className="text-xs font-mono text-gray-600 hover:text-gold/70 underline underline-offset-2 transition-colors disabled:opacity-40">
        {triggering ? "queuing…" : "transcribe"}
      </button>
    );
  };

  const syncBadge = track ? (
    <span className="flex items-center gap-1.5">
      {audio.kmlOffsetSec !== null && (
        <span className="text-xs font-mono text-green-500/80">
          ✓ {audio.kmlOffsetSec >= 0 ? "+" : ""}{audio.kmlOffsetSec.toFixed(1)}s
        </span>
      )}
      <button onClick={() => setShowSync(true)} disabled={!audio.signedUrl}
        className="text-xs font-mono text-yellow-600/70 hover:text-yellow-400 underline underline-offset-2 transition-colors disabled:opacity-40">
        {audio.kmlOffsetSec !== null ? "adjust" : "sync"}
      </button>
    </span>
  ) : (
    <span className="text-xs font-mono text-gray-600">no KML</span>
  );

  return (
    <>
      <tr className="border-b border-darkBorder hover:bg-white/[0.02] transition-colors">
        <td className="px-4 py-3 text-xs font-mono text-gray-500 whitespace-nowrap">
          {audio.flightLabel ?? audio.flightId.slice(0, 8)}
        </td>
        <td className="px-4 py-3">
          <div className="text-sm text-gray-200">
            {audio.label ?? <span className="text-gray-600 italic">no label</span>}
          </div>
          {audio.frequency && (
            <div className="text-xs font-mono text-gray-500">{audio.frequency} MHz</div>
          )}
          <div className="text-xs font-mono text-gray-700 truncate max-w-[200px]">{audio.s3Key}</div>
        </td>
        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
          {SOURCE_LABEL[audio.sourceType ?? ""] ?? "—"}
        </td>
        <td className="px-4 py-3 text-xs font-mono text-gray-500 whitespace-nowrap">
          {audio.durationSec !== null ? fmtDuration(audio.durationSec) : "—"}
        </td>
        <td className="px-4 py-3 whitespace-nowrap">{syncBadge}</td>
        <td className="px-4 py-3 whitespace-nowrap">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span className={`text-xs font-mono ${STATUS_COLOR[audio.transcriptStatus] ?? "text-gray-600"}`}>
                {audio.transcriptStatus === "PROCESSING" && audio.transcriptProgress != null
                  ? `${audio.transcriptProgress}%`
                  : STATUS_LABEL[audio.transcriptStatus] ?? "—"}
              </span>
            </div>
            {audio.transcriptStatus === "PROCESSING" && (
              <div className="w-24 h-1 bg-darkBg rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-400 rounded-full transition-all duration-700"
                  style={{ width: `${audio.transcriptProgress ?? 0}%` }}
                />
              </div>
            )}
            {transcriptAction()}
          </div>
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          <button onClick={() => setShowMix(true)} disabled={!audio.signedUrl}
            className="text-xs px-2.5 py-1 border border-darkBorder rounded text-gray-400
              hover:border-yellow-500/50 hover:text-yellow-400 transition-colors disabled:opacity-40">
            ⊕ mix
          </button>
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          <button onClick={onDelete} disabled={deleting}
            className={`text-xs px-2.5 py-1 rounded border transition-colors border-darkBorder text-gray-600
              hover:border-red-700/50 hover:text-red-400 ${deleting ? "opacity-40 cursor-wait" : ""}`}>
            {deleting ? "…" : "Delete"}
          </button>
        </td>
      </tr>

      {showSync && track && audio.signedUrl && (
        <AudioSyncModal audio={audio} track={track}
          onClose={() => setShowSync(false)}
          onSaved={(offset) => { onSynced(offset); setShowSync(false); }} />
      )}
      {showMix && (
        <MixModal
          tracks={allAudioForFlight.filter((a) => a.signedUrl)}
          onClose={() => setShowMix(false)}
          onGainSaved={(id, gain) => { if (id === audio.id) onGainSaved(gain); }} />
      )}
      {showTranscript && audio.transcript && (
        <TranscriptModal
          audio={audio}
          onClose={() => setShowTranscript(false)}
          onSaved={(transcript) => {
            onTranscriptUpdate(audio.transcriptStatus, transcript, audio.transcriptError ?? null);
          }}
          onNeedSignedUrl={async () => {
            try {
              const { url } = await getUrl({ path: audio.s3Key, options: { bucket: BUCKET_NAME, expiresIn: 3600 } });
              return url.toString();
            } catch { return audio.signedUrl ?? ""; }
          }}
        />
      )}
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminAudioPage() {
  const { authState } = useRequireAuth("admins");
  const [flights,    setFlights]    = useState<Flight[]>([]);
  const [audioTracks, setAudioTracks] = useState<FlightAudio[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [deleting,   setDeleting]   = useState<Set<string>>(new Set());
  const [kmlTracks,  setKmlTracks]  = useState<Map<string, KmlTrack>>(new Map());

  useEffect(() => {
    if (authState !== "authenticated") return;
    async function load() {
      try {
        // Flights
        const allFlights: Flight[] = [];
        let ft: string | null | undefined;
        do {
          const { data, nextToken } = await (client.models.flight as any).list({ limit: 1000, nextToken: ft });
          allFlights.push(...(data as Flight[]));
          ft = nextToken;
        } while (ft);
        allFlights.sort((a, b) => b.date.localeCompare(a.date));
        setFlights(allFlights);

        // KML tracks
        const flightsWithKml = allFlights.filter((f: any) => f.kmlS3Key);
        const trackEntries = await Promise.all(
          flightsWithKml.map(async (f: any) => {
            try {
              const { url } = await getUrl({ path: f.kmlS3Key, options: { bucket: BUCKET_NAME, expiresIn: 300 } });
              const track = await parseKmlTrack(url.toString());
              return track ? [f.id, track] as [string, KmlTrack] : null;
            } catch { return null; }
          })
        );
        const newMap = new Map<string, KmlTrack>();
        for (const entry of trackEntries) if (entry) newMap.set(entry[0], entry[1]);
        setKmlTracks(newMap);

        // Audio records
        const allAudio: FlightAudio[] = [];
        let mt: string | null | undefined;
        do {
          const { data, nextToken } = await (client.models.flightAudio as any).list({ limit: 1000, nextToken: mt });
          allAudio.push(...(data as FlightAudio[]));
          mt = nextToken;
        } while (mt);
        allAudio.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

        const flightMap = new Map(allFlights.map((f) => [f.id, f]));
        const annotated = allAudio.map((a) => {
          const f = flightMap.get(a.flightId);
          return { ...a, flightLabel: f ? `${f.date} ${f.from}→${f.to}` : a.flightId };
        });

        // Resolve signed URLs
        const withUrls = await Promise.all(
          annotated.map(async (a) => {
            try {
              const { url } = await getUrl({ path: a.s3Key, options: { bucket: BUCKET_NAME, expiresIn: 3600 } });
              return { ...a, signedUrl: url.toString() };
            } catch { return a; }
          })
        );
        setAudioTracks(withUrls);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [authState]);

  const handleDelete = async (audio: FlightAudio) => {
    if (!confirm(`Delete "${audio.label ?? audio.s3Key}"?\nThis removes the S3 file and database record.`)) return;
    setDeleting((s) => new Set(s).add(audio.id));
    try {
      await remove({ path: audio.s3Key, options: { bucket: BUCKET_NAME } });
      await (client.models.flightAudio as any).delete({ id: audio.id });
      setAudioTracks((prev) => prev.filter((a) => a.id !== audio.id));
    } catch (e: any) {
      alert(`Delete failed: ${e.message}`);
    } finally {
      setDeleting((s) => { const n = new Set(s); n.delete(audio.id); return n; });
    }
  };

  if (authState === "loading") return (
    <FlyingAdminLayout>
      <div className="flex items-center justify-center h-64">
        <span className="text-gray-600 font-mono text-xs animate-pulse">Checking auth…</span>
      </div>
    </FlyingAdminLayout>
  );

  return (
    <FlyingAdminLayout>
      <Head><title>Admin — Audio</title></Head>
      <div className="px-6 py-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-100">Audio</h1>
            <p className="text-xs text-gray-500 font-mono mt-0.5">
              {audioTracks.length} tracks · {audioTracks.filter((a) => a.transcriptStatus === "DONE").length} transcribed
            </p>
          </div>
          <button onClick={() => setShowUpload(true)}
            className="text-xs px-3 py-1.5 rounded border border-blue-400/50 text-blue-400 hover:bg-blue-950/30 transition-colors">
            + Upload Audio
          </button>
        </div>

        <div className="border border-darkBorder rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-darkSurface border-b border-darkBorder">
                  {["Flight", "Label / Key", "Source", "Duration", "Sync", "Transcript", "Mix", ""].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-xs font-mono text-gray-600 uppercase tracking-widest">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} className="px-4 py-12 text-center text-xs text-gray-600 font-mono animate-pulse">Loading…</td></tr>
                ) : audioTracks.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-12 text-center text-xs text-gray-600 font-mono">No audio yet — upload one to get started</td></tr>
                ) : audioTracks.map((a) => (
                  <AudioRow
                    key={a.id}
                    audio={a}
                    track={kmlTracks.get(a.flightId) ?? null}
                    allAudioForFlight={audioTracks.filter((x) => x.flightId === a.flightId)}
                    onDelete={() => handleDelete(a)}
                    onSynced={(offset) => setAudioTracks((prev) =>
                      prev.map((x) => x.id === a.id ? { ...x, kmlOffsetSec: offset ?? null } : x)
                    )}
                    onGainSaved={(gain) => setAudioTracks((prev) =>
                      prev.map((x) => x.id === a.id ? { ...x, mixGain: gain } : x)
                    )}
                    onTranscriptUpdate={(status, transcript, error, progress) => setAudioTracks((prev) =>
                      prev.map((x) => x.id === a.id
                        ? { ...x, transcriptStatus: status as FlightAudio["transcriptStatus"], transcript, transcriptError: error, transcriptProgress: progress ?? x.transcriptProgress }
                        : x
                      )
                    )}
                    deleting={deleting.has(a.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showUpload && (
        <AudioUploadModal
          flights={flights}
          kmlTracks={kmlTracks}
          onClose={() => setShowUpload(false)}
          onSuccess={(record) => {
            setAudioTracks((prev) => [...prev, record].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
            setShowUpload(false);
          }}
        />
      )}
    </FlyingAdminLayout>
  );
}
