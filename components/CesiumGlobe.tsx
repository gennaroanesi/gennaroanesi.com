import React, { useEffect, useRef, useState } from "react";
import { getUrl } from "aws-amplify/storage";
import type { ApproachFix } from "./approachUtils";
import { flightColor } from "./flightColors";

const BUCKET_NAME = "gennaroanesi.com";

export type Flight = {
  id: string;
  date: string;
  from: string;
  to: string;
  route: string | null;
  aircraftId: string | null;
  aircraftType: string | null;
  totalTime: number | null;
  flightType: string | null;
  conditions: string | null;
  approaches: number | null;
  approachTypes: string | null;
  night: number | null;
  actualIMC: number | null;
  simulatedIMC: number | null;
  crossCountry: number | null;
  solo: number | null;
  dualReceived: number | null;
  dayLandings: number | null;
  nightLandings: number | null;
  kmlS3Key: string | null;
  approachChartKeys: string[] | null;
  title: string | null;
  milestone: string | null;
  notes: string | null;
  published: boolean | null;
};

export type AirportMarker = {
  id: string;
  icaoId: string | null;
  faaId: string;
  name: string;
  city: string;
  stateCode: string;
  latDecimal: number;
  lonDecimal: number;
  elevationFt: number | null;
  hasTower: boolean | null;
  airspaceClass: string | null;
};

export type ActiveApproach = {
  label: string;
  icao: string;
  procedure: string;
  fixes: ApproachFix[];
};

const AIRPORT_COORDS: Record<string, [number, number]> = {
  KGTU: [30.6788, -97.6794],
  KAUS: [30.1975, -97.6664],
  KGRK: [31.0672, -97.8291],
  KILE: [31.0858, -97.6865],
  KBMQ: [30.8858, -97.4196],
  KLZZ: [30.7285, -98.7032],
  KTPL: [31.1525, -97.4078],
  KEDC: [30.3978, -97.5726],
  KBAZ: [29.7003, -98.0281],
  T82:  [29.8875, -97.9317],
  KSGR: [29.6223, -95.6565],
  KSSF: [29.3369, -98.4711],
  KSAT: [29.5337, -98.4698],
  KDAL: [32.8471, -96.8517],
  KDFW: [32.8998, -97.0403],
  KHOU: [29.6454, -95.2789],
  KIAH: [29.9902, -95.3368],
};

const APPROACH_LINE_COLOR  = "#60a5fa";
const APPROACH_LINE_OUT    = "#1e3a5f";
const APPROACH_DOT_DEFAULT = "#93c5fd";
const APPROACH_DOT_IAF     = "#facc15";
const APPROACH_DOT_FAF     = "#f97316";
const APPROACH_DOT_MAP     = "#ef4444";
const AIRPORT_COLOR_TOWERED   = "#6ee7b7";
const AIRPORT_COLOR_UNTOWERED = "#34d399";

function fixDotColor(role: string): string {
  if (role === "IAF") return APPROACH_DOT_IAF;
  if (role === "FAF") return APPROACH_DOT_FAF;
  if (role === "MAP") return APPROACH_DOT_MAP;
  return APPROACH_DOT_DEFAULT;
}

async function fetchKmlPositions(Cesium: any, kmlS3Key: string): Promise<any[] | null> {
  try {
    const { url } = await getUrl({
      path: kmlS3Key,
      options: { bucket: BUCKET_NAME, expiresIn: 300 },
    });

    const res = await fetch(url.toString(), { mode: "cors", credentials: "omit" });
    if (!res.ok) {
      console.error(`[KML] HTTP ${res.status} for ${kmlS3Key}`);
      return null;
    }
    const text = await res.text();
    console.log(`[KML] fetched ${kmlS3Key}, ${text.length} chars`);

    // Try both XML mime types — Safari sometimes rejects application/xml
    let doc: Document | null = null;
    for (const mime of ["application/xml", "text/xml"] as DOMParserSupportedType[]) {
      try {
        const candidate = new DOMParser().parseFromString(text, mime);
        // A parse error produces a <parsererror> root element
        if (!candidate.querySelector("parsererror")) { doc = candidate; break; }
      } catch { /* try next */ }
    }
    if (!doc) {
      console.error("[KML] failed to parse XML");
      return null;
    }

    const positions: any[] = [];

    // Strategy 1: gx:coord (ForeFlight / Google Earth extended KML)
    const gxCoords = Array.from(
      doc.getElementsByTagNameNS("http://www.google.com/kml/ext/2.2", "coord"),
    );
    if (gxCoords.length > 0) {
      for (const el of gxCoords) {
        const parts = el.textContent?.trim().split(/\s+/);
        if (!parts || parts.length < 2) continue;
        const lon = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        const alt = parts[2] ? parseFloat(parts[2]) : 0;
        if (!isNaN(lon) && !isNaN(lat))
          positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, alt));
      }
    }

    // Strategy 2: standard <coordinates> (lon,lat,alt tuples)
    if (positions.length === 0) {
      for (const coordEl of Array.from(doc.querySelectorAll("coordinates"))) {
        const tuples = coordEl.textContent?.trim().split(/\s+/).filter(Boolean) ?? [];
        for (const tuple of tuples) {
          const parts = tuple.split(",");
          if (parts.length < 2) continue;
          const lon = parseFloat(parts[0]);
          const lat = parseFloat(parts[1]);
          const alt = parts[2] ? parseFloat(parts[2]) : 0;
          if (!isNaN(lon) && !isNaN(lat))
            positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, alt));
        }
      }
    }

    console.log(`[KML] parsed ${positions.length} positions from ${kmlS3Key}`);
    return positions.length > 1 ? positions : null;
  } catch (e) {
    console.error("[KML] fetch/parse error:", e);
    return null;
  }
}

function generateArc(
  Cesium: any,
  lat1: number, lon1: number,
  lat2: number, lon2: number,
  numPoints = 80, maxAlt = 6000,
) {
  const pts = [];
  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints;
    const lat = lat1 + (lat2 - lat1) * t;
    const lon = lon1 + (lon2 - lon1) * t;
    const alt = maxAlt * 4 * t * (1 - t);
    pts.push(Cesium.Cartesian3.fromDegrees(lon, lat, alt));
  }
  return pts;
}

export default function CesiumGlobe({
  flights,
  airports = [],
  selectedId,
  activeApproach = null,
  onSelect,
}: {
  flights: Flight[];
  airports?: AirportMarker[];
  selectedId: string | null;
  activeApproach?: ActiveApproach | null;
  onSelect: (id: string) => void;
}) {
  const containerRef     = useRef<HTMLDivElement>(null);
  const viewerRef        = useRef<any>(null);
  const entityMap        = useRef<Map<string, any>>(new Map());
  const airportEntities  = useRef<any[]>([]);
  const approachEntities = useRef<any[]>([]);
  const initAttempted    = useRef(false);

  // Always start false — never read window at module/render time (breaks iOS SSR hydration)
  const [cesiumLoaded, setCesiumLoaded] = useState(false);
  const [viewerReady, setViewerReady]   = useState(false);
  const [overlayMode, setOverlayMode]   = useState<"none" | "sectional">("none");

  // ── Step 1: inject Cesium script ────────────────────────────────────────────
  useEffect(() => {
    // Already available (e.g. hot reload or script already ran)
    if ((window as any).Cesium) {
      setCesiumLoaded(true);
      return;
    }

    const base = "https://cesium.com/downloads/cesiumjs/releases/1.111/Build/Cesium";

    if (!document.querySelector(`link[href*="Cesium/Widgets"]`)) {
      const link = document.createElement("link");
      link.rel  = "stylesheet";
      link.href = `${base}/Widgets/widgets.css`;
      document.head.appendChild(link);
    }

    const existing = document.querySelector(`script[src*="Cesium.js"]`);
    if (!existing) {
      const script = document.createElement("script");
      script.src    = `${base}/Cesium.js`;
      script.onload = () => setCesiumLoaded(true);
      script.onerror = () => console.error("[Cesium] failed to load script");
      document.head.appendChild(script);
    } else {
      // Script tag already injected but may still be loading — poll
      const poll = setInterval(() => {
        if ((window as any).Cesium) {
          clearInterval(poll);
          setCesiumLoaded(true);
        }
      }, 50);
      return () => clearInterval(poll);
    }
  }, []);

  // ── Step 2: init viewer once Cesium ready AND container has real dimensions ─
  // On iOS Safari, fixed-positioned elements may have 0x0 dimensions when the
  // first effect fires. ResizeObserver waits until the element is actually painted.
  useEffect(() => {
    if (!cesiumLoaded || flights.length === 0 || initAttempted.current) return;
    const container = containerRef.current;
    if (!container) return;

    const tryInit = () => {
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return false;
      initAttempted.current = true;
      doInit(container);
      return true;
    };

    if (!tryInit()) {
      const ro = new ResizeObserver(() => { if (tryInit()) ro.disconnect(); });
      ro.observe(container);
      return () => ro.disconnect();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cesiumLoaded, flights]);

  async function doInit(container: HTMLDivElement) {
    const Cesium = (window as any).Cesium;
    if (!Cesium) return;

    Cesium.Ion.defaultAccessToken = process.env.NEXT_PUBLIC_CESIUM_TOKEN ?? "";

    const viewer = new Cesium.Viewer(container, {
      baseLayerPicker: false, geocoder: false, homeButton: false,
      sceneModePicker: false, navigationHelpButton: false,
      animation: false, timeline: false, fullscreenButton: false,
      infoBox: false, selectionIndicator: false,
      sceneMode: Cesium.SceneMode.SCENE2D,
    });

    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(
      await Cesium.IonImageryProvider.fromAssetId(2),
    );
    viewer.scene.backgroundColor           = Cesium.Color.fromCssColorString("#1e1e2e");
    viewer.scene.globe.baseColor           = Cesium.Color.fromCssColorString("#1a2535");
    viewer.scene.globe.enableLighting      = false;
    viewer.scene.globe.showGroundAtmosphere = false;
    viewer.scene.skyBox = undefined as any;
    viewer.scene.sun    = undefined as any;
    viewer.scene.moon   = undefined as any;
    (viewer.cesiumWidget.creditContainer as HTMLElement).style.display = "none";

    viewerRef.current = viewer;
    setViewerReady(true);

    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(-97.5, 38.0, 4500000),
    });

    let i = 0;
    const drawNext = async () => {
      if (i >= flights.length || viewer.isDestroyed()) return;
      const f = flights[i];
      const color = flightColor(i);
      i++;
      if (!f.kmlS3Key) { setTimeout(drawNext, 0); return; }

      const positions = await fetchKmlPositions(Cesium, f.kmlS3Key);
      if (positions && !viewer.isDestroyed()) {
        const entity = viewer.entities.add({
          id: f.id,
          polyline: {
            positions,
            width: 10,
            material: new Cesium.PolylineOutlineMaterialProperty({
              color:        Cesium.Color.fromCssColorString(color + "dd"),
              outlineWidth: 3,
              outlineColor: Cesium.Color.fromCssColorString("#1a1a2e99"),
            }),
            clampToGround: false,
          },
          wall: {
            positions,
            material: Cesium.Color.fromCssColorString(color + "22"),
            minimumHeights: new Array(positions.length).fill(0),
          },
        });
        entityMap.current.set(f.id, entity);
      }

      if (i < flights.length) {
        setTimeout(drawNext, 0);
      } else if (!viewer.isDestroyed() && viewer.entities.values.length > 0) {
        viewer.flyTo(viewer.entities, {
          duration: 1.5,
          offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-40), 120000),
        });
      }
    };
    setTimeout(drawNext, 300);

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((e: any) => {
      const picked = viewer.scene.pick(e.position);
      if (picked?.id?.id) onSelect(picked.id.id);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Cleanup stored on ref so the destroy effect can use it
    (viewerRef as any)._cleanup = () => {
      if (!viewer.isDestroyed()) viewer.destroy();
      viewerRef.current = null;
      entityMap.current.clear();
    };
  }

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      const cleanup = (viewerRef as any)._cleanup;
      if (cleanup) cleanup();
    };
  }, []);

  // ── Overlay layer ─────────────────────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = (window as any).Cesium;
    if (!viewer || !Cesium) return;
    while (viewer.imageryLayers.length > 1) {
      viewer.imageryLayers.remove(viewer.imageryLayers.get(1));
    }
    if (overlayMode === "sectional") {
      const layer = viewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: "https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}",
          credit: "FAA", minimumLevel: 8, maximumLevel: 12,
        }),
      );
      layer.alpha = 0.9;
    }
  }, [overlayMode, viewerReady]);

  // ── Airport markers ───────────────────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = (window as any).Cesium;
    if (!viewer || !Cesium || !viewerReady) return;

    airportEntities.current.forEach((e) => viewer.entities.remove(e));
    airportEntities.current = [];

    for (const apt of airports) {
      const label     = apt.icaoId ?? apt.faaId;
      const isTowered = apt.hasTower;
      const entity = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(
          apt.lonDecimal, apt.latDecimal, (apt.elevationFt ?? 0) * 0.3048,
        ),
        point: {
          pixelSize: isTowered ? 10 : 7,
          color: Cesium.Color.fromCssColorString(
            isTowered ? AIRPORT_COLOR_TOWERED + "dd" : AIRPORT_COLOR_UNTOWERED + "99"
          ),
          outlineColor: Cesium.Color.fromCssColorString("#1a1a2e"),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text:        label,
          font:        "bold 13px 'source-sans-pro', sans-serif",
          fillColor:   Cesium.Color.fromCssColorString(isTowered ? AIRPORT_COLOR_TOWERED : AIRPORT_COLOR_UNTOWERED),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style:        Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset:  new Cesium.Cartesian2(0, -16),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      airportEntities.current.push(entity);
    }
  }, [airports, viewerReady]);

  // ── Approach path rendering ───────────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = (window as any).Cesium;
    if (!viewer || !Cesium || !viewerReady) return;

    approachEntities.current.forEach((e) => viewer.entities.remove(e));
    approachEntities.current = [];

    if (!activeApproach) return;

    const validFixes = activeApproach.fixes.filter(
      (f) => f.lat !== null && f.lon !== null,
    );
    if (validFixes.length < 2) return;

    const ALT_M = 600;

    const lineEntity = viewer.entities.add({
      polyline: {
        positions: validFixes.map((f) => Cesium.Cartesian3.fromDegrees(f.lon!, f.lat!, ALT_M)),
        width: 3,
        material: new Cesium.PolylineOutlineMaterialProperty({
          color:        Cesium.Color.fromCssColorString(APPROACH_LINE_COLOR + "dd"),
          outlineWidth: 2,
          outlineColor: Cesium.Color.fromCssColorString(APPROACH_LINE_OUT + "99"),
        }),
        clampToGround: false,
      },
    });
    approachEntities.current.push(lineEntity);

    for (const fix of validFixes) {
      const dotColor = fixDotColor(fix.role);
      const isKeyFix = fix.role !== "";
      const fixEntity = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(fix.lon!, fix.lat!, ALT_M + 50),
        point: {
          pixelSize:                isKeyFix ? 10 : 6,
          color:                    Cesium.Color.fromCssColorString(dotColor + "ee"),
          outlineColor:             Cesium.Color.fromCssColorString("#0f172a"),
          outlineWidth:             2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text:         fix.role ? `${fix.fixId}\n${fix.role}` : fix.fixId,
          font:         `bold ${isKeyFix ? 12 : 10}px monospace`,
          fillColor:    Cesium.Color.fromCssColorString(dotColor),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style:        Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset:  new Cesium.Cartesian2(0, -18),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground:    isKeyFix,
          backgroundColor:   Cesium.Color.fromCssColorString("#0f172acc"),
          backgroundPadding: new Cesium.Cartesian2(4, 3),
        },
      });
      approachEntities.current.push(fixEntity);
    }

    const lats = validFixes.map((f) => f.lat!);
    const lons = validFixes.map((f) => f.lon!);
    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(
        Math.min(...lons) - 0.05, Math.min(...lats) - 0.05,
        Math.max(...lons) + 0.05, Math.max(...lats) + 0.05,
      ),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
      duration: 1.4,
    });
  }, [activeApproach, viewerReady]);

  // ── Selection highlight ───────────────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = (window as any).Cesium;
    if (!viewer || !Cesium) return;

    const hasSelection = selectedId !== null;
    entityMap.current.forEach((entity, id) => {
      const sel    = id === selectedId;
      const idx    = flights.findIndex((f) => f.id === id);
      const color  = flightColor(idx >= 0 ? idx : 0);
      const hasKml = flights[idx]?.kmlS3Key;
      const dimmed = hasSelection && !sel;
      entity.polyline.width    = sel ? 14 : hasKml ? 10 : 1.5;
      entity.polyline.material = new Cesium.PolylineOutlineMaterialProperty({
        color:        Cesium.Color.fromCssColorString(dimmed ? color + "33" : sel ? color : color + "dd"),
        outlineWidth: sel ? 4 : dimmed ? 1 : 3,
        outlineColor: Cesium.Color.fromCssColorString("#1a1a2e99"),
      });
      if (entity.wall) {
        entity.wall.material = Cesium.Color.fromCssColorString(
          sel ? color + "40" : dimmed ? color + "08" : color + "18"
        );
      }
    });

    if (selectedId && !activeApproach) {
      const f      = flights.find((x) => x.id === selectedId);
      const entity = entityMap.current.get(selectedId);
      if (f?.kmlS3Key && entity) {
        try {
          viewer.flyTo(entity, {
            duration: 1.2,
            offset: new Cesium.HeadingPitchRange(
              Cesium.Math.toRadians(0), Cesium.Math.toRadians(-45), 80000,
            ),
          });
        } catch { /* ignore */ }
      } else {
        const from = f && AIRPORT_COORDS[f.from];
        const to   = f && AIRPORT_COORDS[f.to];
        if (from && to) {
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(
              (from[1] + to[1]) / 2,
              (from[0] + to[0]) / 2 - 1.5,
              280000,
            ),
            orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
            duration: 1.0,
          });
        }
      }
    }
  }, [selectedId, flights, activeApproach]);

  const OVERLAY_MODES: { key: "none" | "sectional"; label: string }[] = [
    { key: "none",      label: "Satellite" },
    { key: "sectional", label: "VFR Sectional" },
  ];

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="absolute inset-0" style={{ background: "#1e1e2e" }} />

      {activeApproach && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10
          flex items-center gap-2 px-3 py-1.5
          bg-blue-950/90 border border-blue-400/40 rounded-full backdrop-blur-sm
          text-blue-300 text-xs font-mono tracking-wide shadow-lg">
          <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse inline-block" />
          {activeApproach.icao} · {activeApproach.procedure} · {activeApproach.label}
        </div>
      )}

      {activeApproach && (
        <div className="absolute top-12 right-3 z-10 flex flex-col gap-1
          bg-black/60 backdrop-blur-sm rounded px-3 py-2 text-xs font-mono">
          {[
            { color: APPROACH_DOT_IAF, label: "IAF" },
            { color: APPROACH_DOT_FAF, label: "FAF" },
            { color: APPROACH_DOT_MAP, label: "MAP" },
            { color: APPROACH_DOT_DEFAULT, label: "Fix" },
          ].map(({ color, label }) => (
            <div key={label} className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: color }} />
              <span style={{ color }}>{label}</span>
            </div>
          ))}
        </div>
      )}

      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1 z-10
        bg-black/50 backdrop-blur-sm rounded-full px-2 py-1">
        {OVERLAY_MODES.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setOverlayMode(key)}
            className="px-3 py-1 rounded-full text-xs font-medium transition-all"
            style={{
              backgroundColor: overlayMode === key ? "#DEBA02" : "transparent",
              color:           overlayMode === key ? "#1a1a2e" : "#ffffff99",
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
