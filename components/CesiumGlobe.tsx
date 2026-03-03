import React, { useEffect, useRef, useState } from "react";
import { getUrl } from "aws-amplify/storage";
import type { ApproachFix } from "./approachUtils";

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
  /** Label shown on the overlay, e.g. "RNAV (GPS) RWY 18" */
  label: string;
  /** Airport ICAO, e.g. "KGTU" */
  icao: string;
  /** CIFP procedure, e.g. "R18" */
  procedure: string;
  /** Fix sequence — final segment only (empty transition) */
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

// ── Colours ───────────────────────────────────────────────────────────────────
const APPROACH_LINE_COLOR  = "#60a5fa";   // blue-400
const APPROACH_LINE_OUT    = "#1e3a5f";
const APPROACH_DOT_DEFAULT = "#93c5fd";   // blue-300
const APPROACH_DOT_IAF     = "#facc15";   // gold — IAF
const APPROACH_DOT_FAF     = "#f97316";   // orange — FAF
const APPROACH_DOT_MAP     = "#ef4444";   // red — MAP

function fixDotColor(role: string): string {
  if (role === "IAF") return APPROACH_DOT_IAF;
  if (role === "FAF") return APPROACH_DOT_FAF;
  if (role === "MAP") return APPROACH_DOT_MAP;
  return APPROACH_DOT_DEFAULT;
}

async function fetchKmlPositions(
  Cesium: any,
  kmlS3Key: string,
): Promise<any[] | null> {
  try {
    const { url } = await getUrl({
      path: kmlS3Key,
      options: { bucket: BUCKET_NAME, expiresIn: 300 },
    });
    const res = await fetch(url.toString());
    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "application/xml");

    const positions: any[] = [];

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
        if (!isNaN(lon) && !isNaN(lat)) {
          positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, alt));
        }
      }
    } else {
      const coordEls = Array.from(doc.querySelectorAll("coordinates"));
      for (const coordEl of coordEls) {
        const tuples =
          coordEl.textContent?.trim().split(/\s+/).filter(Boolean) ?? [];
        for (const tuple of tuples) {
          const parts = tuple.split(",");
          if (parts.length < 2) continue;
          const lon = parseFloat(parts[0]);
          const lat = parseFloat(parts[1]);
          const alt = parts[2] ? parseFloat(parts[2]) : 0;
          if (!isNaN(lon) && !isNaN(lat)) {
            positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, alt));
          }
        }
      }
    }

    return positions.length > 1 ? positions : null;
  } catch (e) {
    console.error("[KML] error:", e);
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
  const containerRef       = useRef<HTMLDivElement>(null);
  const viewerRef          = useRef<any>(null);
  const entityMap          = useRef<Map<string, any>>(new Map());
  const airportEntities    = useRef<any[]>([]);
  const approachEntities   = useRef<any[]>([]);
  const [cesiumLoaded, setCesiumLoaded] = React.useState(!!(window as any).Cesium);
  const [viewerReady, setViewerReady]   = useState(false);
  const [overlayMode, setOverlayMode]   = useState<"none" | "sectional">("none");

  // ── Init viewer ───────────────────────────────────────────────────────────
  useEffect(() => {
    async function init() {
      if (!containerRef.current || flights.length === 0) return;

      if (!(window as any).Cesium) {
        const base = "https://cesium.com/downloads/cesiumjs/releases/1.111/Build/Cesium";
        if (!document.querySelector(`link[href*="Cesium/Widgets"]`)) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = `${base}/Widgets/widgets.css`;
          document.head.appendChild(link);
        }
        if (!document.querySelector(`script[src*="Cesium.js"]`)) {
          const script = document.createElement("script");
          script.src = `${base}/Cesium.js`;
          script.onload = () => setCesiumLoaded(true);
          document.head.appendChild(script);
        }
        return;
      }

      const Cesium = (window as any).Cesium;
      Cesium.Ion.defaultAccessToken = process.env.NEXT_PUBLIC_CESIUM_TOKEN ?? "";

      const viewer = new Cesium.Viewer(containerRef.current, {
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
      viewer.scene.backgroundColor     = Cesium.Color.fromCssColorString("#1e1e2e");
      viewer.scene.globe.baseColor      = Cesium.Color.fromCssColorString("#1a2535");
      viewer.scene.globe.enableLighting = false;
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
        const f = flights[i++];
        if (!f.kmlS3Key) { setTimeout(drawNext, 0); return; }

        const positions = await fetchKmlPositions(Cesium, f.kmlS3Key);
        if (positions && !viewer.isDestroyed()) {
          const entity = viewer.entities.add({
            id: f.id,
            polyline: {
              positions,
              width: 10,
              material: new Cesium.PolylineOutlineMaterialProperty({
                color:        Cesium.Color.fromCssColorString("#DEBA02dd"),
                outlineWidth: 3,
                outlineColor: Cesium.Color.fromCssColorString("#1a1a2e99"),
              }),
              clampToGround: false,
            },
            wall: {
              positions,
              material: Cesium.Color.fromCssColorString("#DEBA0228"),
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
    }
    init();
    return () => {
      const v = viewerRef.current;
      if (v && !v.isDestroyed()) v.destroy();
      viewerRef.current = null;
      entityMap.current.clear();
    };
  }, [flights, cesiumLoaded]);

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
          color: Cesium.Color.fromCssColorString(isTowered ? "#DEBA02dd" : "#ffffff88"),
          outlineColor: Cesium.Color.fromCssColorString("#1a1a2e"),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text:        label,
          font:        "bold 13px 'source-sans-pro', sans-serif",
          fillColor:   Cesium.Color.fromCssColorString(isTowered ? "#DEBA02" : "#ffffffcc"),
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

    // Clear old approach entities
    approachEntities.current.forEach((e) => viewer.entities.remove(e));
    approachEntities.current = [];

    if (!activeApproach) return;

    const validFixes = activeApproach.fixes.filter(
      (f) => f.lat !== null && f.lon !== null,
    );
    if (validFixes.length < 2) return;

    const ALT_M = 600; // display altitude for approach path (metres above ground)

    // Polyline connecting all fixes
    const linePositions = validFixes.map((f) =>
      Cesium.Cartesian3.fromDegrees(f.lon!, f.lat!, ALT_M),
    );
    const lineEntity = viewer.entities.add({
      polyline: {
        positions: linePositions,
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

    // Fix waypoint dots + labels
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
          showBackground:     isKeyFix,
          backgroundColor:    Cesium.Color.fromCssColorString("#0f172acc"),
          backgroundPadding:  new Cesium.Cartesian2(4, 3),
        },
      });
      approachEntities.current.push(fixEntity);
    }

    // Fly to the approach path
    const lats = validFixes.map((f) => f.lat!);
    const lons = validFixes.map((f) => f.lon!);
    const minLat = Math.min(...lats); const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons); const maxLon = Math.max(...lons);
    const padDeg = 0.05;

    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(
        minLon - padDeg, minLat - padDeg,
        maxLon + padDeg, maxLat + padDeg,
      ),
      orientation: {
        heading: 0,
        pitch:   Cesium.Math.toRadians(-55),
        roll:    0,
      },
      duration: 1.4,
    });
  }, [activeApproach, viewerReady]);

  // ── Selection highlight ───────────────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = (window as any).Cesium;
    if (!viewer || !Cesium) return;

    const GOLD   = Cesium.Color.fromCssColorString("#DEBA02");

    entityMap.current.forEach((entity, id) => {
      const sel    = id === selectedId;
      const hasKml = flights.find((f) => f.id === id)?.kmlS3Key;
      entity.polyline.width    = sel ? 14 : hasKml ? 10 : 1.5;
      entity.polyline.material = new Cesium.PolylineOutlineMaterialProperty({
        color:        sel ? GOLD : Cesium.Color.fromCssColorString("#DEBA02dd"),
        outlineWidth: sel ? 4 : 3,
        outlineColor: Cesium.Color.fromCssColorString("#1a1a2e99"),
      });
      if (entity.wall) {
        entity.wall.material = sel
          ? Cesium.Color.fromCssColorString("#DEBA0240")
          : Cesium.Color.fromCssColorString("#DEBA0218");
      }
    });

    // Only fly to the flight if no approach is active
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
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" style={{ background: "#1e1e2e" }} />

      {/* Active approach badge */}
      {activeApproach && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10
          flex items-center gap-2 px-3 py-1.5
          bg-blue-950/90 border border-blue-400/40 rounded-full backdrop-blur-sm
          text-blue-300 text-xs font-mono tracking-wide shadow-lg">
          <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse inline-block" />
          {activeApproach.icao} · {activeApproach.procedure} · {activeApproach.label}
        </div>
      )}

      {/* Legend when approach active */}
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
              <span className="w-2.5 h-2.5 rounded-full inline-block"
                style={{ backgroundColor: color }} />
              <span style={{ color }}>{label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Overlay toggle */}
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
