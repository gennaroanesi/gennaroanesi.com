import React, { useEffect, useRef } from "react";
import { getUrl } from "aws-amplify/storage";

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

async function fetchKmlPositions(Cesium: any, kmlS3Key: string): Promise<any[] | null> {
  try {
    console.log("[KML] fetching:", kmlS3Key);
    const { url } = await getUrl({
      path:    kmlS3Key,
      options: { bucket: BUCKET_NAME, expiresIn: 300 },
    });
    console.log("[KML] signed url:", url.toString());
    const res  = await fetch(url.toString());
    console.log("[KML] fetch status:", res.status);
    const text = await res.text();
    console.log("[KML] text preview:", text.slice(0, 200));
    const parser = new DOMParser();
    const doc    = parser.parseFromString(text, "application/xml");

    const positions: any[] = [];

    // ForeFlight exports use <gx:Track> with individual <gx:coord> elements
    // Format: lon lat alt (space-separated, NOT comma-separated)
    const gxCoords = Array.from(doc.getElementsByTagNameNS(
      "http://www.google.com/kml/ext/2.2", "coord"
    ));

    if (gxCoords.length > 0) {
      console.log("[KML] gx:coord elements found:", gxCoords.length);
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
      // Fallback: standard <coordinates> LineString format (lon,lat,alt tuples)
      const coordEls = Array.from(doc.querySelectorAll("coordinates"));
      console.log("[KML] <coordinates> elements found:", coordEls.length);
      for (const coordEl of coordEls) {
        const tuples = coordEl.textContent?.trim().split(/\s+/).filter(Boolean) ?? [];
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

    console.log("[KML] total positions parsed:", positions.length);
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
  numPoints = 80,
  maxAlt    = 6000,
) {
  const pts = [];
  for (let i = 0; i <= numPoints; i++) {
    const t   = i / numPoints;
    const lat = lat1 + (lat2 - lat1) * t;
    const lon = lon1 + (lon2 - lon1) * t;
    const alt = maxAlt * 4 * t * (1 - t);
    pts.push(Cesium.Cartesian3.fromDegrees(lon, lat, alt));
  }
  return pts;
}

export default function CesiumGlobe({
  flights,
  selectedId,
  onSelect,
}: {
  flights: Flight[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef    = useRef<any>(null);
  const entityMap    = useRef<Map<string, any>>(new Map());
  const [cesiumLoaded, setCesiumLoaded] = React.useState(!!(window as any).Cesium);

  useEffect(() => {
    async function init() {
    if (!containerRef.current || flights.length === 0) return;

    // If Cesium isn't on window yet, load it then re-trigger via state
    if (!(window as any).Cesium) {
      const base = "https://cesium.com/downloads/cesiumjs/releases/1.111/Build/Cesium";

      if (!document.querySelector(`link[href*="Cesium/Widgets"]`)) {
        const link = document.createElement("link");
        link.rel  = "stylesheet";
        link.href = `${base}/Widgets/widgets.css`;
        document.head.appendChild(link);
      }

      if (!document.querySelector(`script[src*="Cesium.js"]`)) {
        const script = document.createElement("script");
        script.src   = `${base}/Cesium.js`;
        script.onload = () => {
          // Force a re-render once Cesium is ready
          setCesiumLoaded(true);
        };
        document.head.appendChild(script);
      }
      return;
    }

    const Cesium = (window as any).Cesium;

    Cesium.Ion.defaultAccessToken = process.env.NEXT_PUBLIC_CESIUM_TOKEN ?? "";

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayerPicker:      false,
      geocoder:             false,
      homeButton:           false,
      sceneModePicker:      false,
      navigationHelpButton: false,
      animation:            false,
      timeline:             false,
      fullscreenButton:     false,
      infoBox:              false,
      selectionIndicator:   false,
    });

    viewer.imageryLayers.removeAll();
    // Base: Bing Maps Aerial
    viewer.imageryLayers.addImageryProvider(
      await Cesium.IonImageryProvider.fromAssetId(2)
    );
    // Overlay: Stadia Stamen Toner Lines — roads + labels only, transparent background
    const labelOverlay = viewer.imageryLayers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url:            "https://tiles.stadiamaps.com/tiles/stamen_toner_lines/{z}/{x}/{y}.png",
        credit:         "Stadia Maps",
        minimumLevel:   0,
        maximumLevel:   20,
      })
    );
    labelOverlay.alpha          = 0.18;
    labelOverlay.brightness     = 2.5;
    labelOverlay.contrast       = 1.0;
    viewer.scene.backgroundColor            = Cesium.Color.fromCssColorString("#1e1e2e");
    viewer.scene.globe.baseColor            = Cesium.Color.fromCssColorString("#1a2535");
    viewer.scene.globe.enableLighting       = false;
    viewer.scene.globe.showGroundAtmosphere = false;
    viewer.scene.skyBox                     = undefined as any;
    viewer.scene.sun                        = undefined as any;
    viewer.scene.moon                       = undefined as any;
    (viewer.cesiumWidget.creditContainer as HTMLElement).style.display = "none";

    viewerRef.current = viewer;

    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(-97.5, 29.5, 650000),
      orientation: {
        heading: Cesium.Math.toRadians(0),
        pitch:   Cesium.Math.toRadians(-40),
        roll:    0,
      },
    });

    const DIMMED = Cesium.Color.fromCssColorString("#DEBA0235");

    let i = 0;
    const drawNext = async () => {
      if (i >= flights.length || viewer.isDestroyed()) return;
      const f = flights[i++];

      let positions: any[] | null = null;

      if (f.kmlS3Key) {
        positions = await fetchKmlPositions(Cesium, f.kmlS3Key);
      }
      if (!positions) {
        const from = AIRPORT_COORDS[f.from];
        const to   = AIRPORT_COORDS[f.to];
        if (from && to) {
          positions = generateArc(Cesium, from[0], from[1], to[0], to[1]);
        }
      }

      if (positions && !viewer.isDestroyed()) {
        const entity = viewer.entities.add(
          f.kmlS3Key
            ? {
                id: f.id,
                polyline: {
                  positions,
                  width:             3,
                  material:          new Cesium.PolylineGlowMaterialProperty({
                    glowPower: 0.25,
                    color:     DIMMED,
                  }),
                  clampToGround:     false,
                },
                wall: {
                  positions,
                  material:          Cesium.Color.fromCssColorString("#DEBA0218"),
                  minimumHeights:    new Array(positions.length).fill(0),
                },
              }
            : {
                id: f.id,
                polyline: {
                  positions,
                  width:    1.5,
                  material: new Cesium.PolylineGlowMaterialProperty({
                    glowPower: 0.2,
                    color:     DIMMED,
                  }),
                },
              }
        );
        entityMap.current.set(f.id, entity);
      }

      setTimeout(drawNext, f.kmlS3Key ? 0 : 40);
    };
    setTimeout(drawNext, 300);

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((e: any) => {
      const picked = viewer.scene.pick(e.position);
      if (picked?.id?.id) onSelect(picked.id.id);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    } // end init
    init();

    return () => {
      const v = viewerRef.current;
      if (v && !v.isDestroyed()) v.destroy();
      viewerRef.current = null;
      entityMap.current.clear();
    };
  }, [flights, cesiumLoaded]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = (window as any).Cesium;
    if (!viewer || !Cesium) return;

    const GOLD   = Cesium.Color.fromCssColorString("#DEBA02");
    const DIMMED = Cesium.Color.fromCssColorString("#DEBA0235");

    entityMap.current.forEach((entity, id) => {
      const sel = id === selectedId;
      const hasKml = flights.find((f) => f.id === id)?.kmlS3Key;
      entity.polyline.width    = sel ? 5 : (hasKml ? 3 : 1.5);
      entity.polyline.material = new Cesium.PolylineGlowMaterialProperty({
        glowPower: sel ? 0.6 : 0.2,
        color:     sel ? GOLD : DIMMED,
      });
      if (entity.wall) {
        entity.wall.material = sel
          ? Cesium.Color.fromCssColorString("#DEBA0240")
          : Cesium.Color.fromCssColorString("#DEBA0218");
      }
    });

    if (selectedId) {
      const f      = flights.find((x) => x.id === selectedId);
      const entity = entityMap.current.get(selectedId);

      if (f?.kmlS3Key && entity) {
        try {
          viewer.flyTo(entity, {
            duration: 1.2,
            offset: new Cesium.HeadingPitchRange(
              Cesium.Math.toRadians(0),
              Cesium.Math.toRadians(-45),
              80000,
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
  }, [selectedId, flights]);

  return (
    <div ref={containerRef} className="w-full h-full" style={{ background: "#1e1e2e" }} />
  );
}
