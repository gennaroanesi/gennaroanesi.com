# TODO

## Flights (personal website)

### ~~Flying page — stats header~~ ✅
### ~~Flying page — milestones timeline~~ ✅
### ~~Flying page — highlight reel (Meta Rayban videos)~~ ✅
### ~~Per-flight media section~~ ✅

### ~~Email-triggered logbook import~~ ✅
- Set up email address `logbookimport@gennaroanesi.com` via AWS SES
- Forward a ForeFlight CSV export email to that address — SES stores it in S3, triggers Lambda
- Lambda parses the attachment (ForeFlight CSV), maps columns to the `flight` model, upserts new records
  - Upsert key: date + from + to + aircraftId (skip duplicates)
  - New flights land with `published: false`
  - Run `archiveChartsForFlight` for any new approach flights
- Tech stack: SES receipt rule → S3 → Lambda (Node) → AppSync mutations
- Steps: verify `gennaroanesi.com` domain in SES, add MX record pointing to SES inbound endpoint, configure receipt rule set, write Lambda handler reusing existing `import_flights.mjs` logic

### ~~KML upload flow~~ ✅

### Full-screen replay mode ← next after email import
- Dedicated flight replay view: cockpit video fills the screen, Cesium globe animates alongside at full size (not PiP)
- Globe camera follows the plane in real time — heading, altitude, bank angle driving the 3D view
- Transcript scrolls in sync on the side (once subtitle feature is built)
- Vertical profile strip at the bottom scrubbing with playback
- Shareable URL per flight for instructor review

### Transcript as searchable index
- Search across all flight transcripts by keyword or phrase
- e.g. "go around", "descend and maintain 3000", "traffic alert"
- Results show flight, timestamp, and speaker; clicking jumps to that moment in the audio (+ synced video if available)
- Requires transcripts to be indexed — could be a simple DynamoDB scan or a dedicated search layer

### Flight debrief view
- Single-flight page combining all data into a produced narrative
- Timeline scrubber across the top driving everything
- Cesium globe below, transcript on the side in sync, video playing when available, vertical profile at the bottom
- Shareable with an instructor as a read-only link (token-gated route)
- Natural endpoint of the video + audio + track system

### Approach analysis / scoring
- Automatically score each approach using KML track + fix coordinates + procedure data
- Questions: was aircraft stabilized at FAF? Did it intercept glideslope from below? How close was MAP crossing to published DA?
- Display as a grade card in the flight detail panel
- All data already available — just needs analysis logic

### Instructor sharing / review links
- Generate time-limited shareable link for a specific flight
- Read-only view of replay + transcript for a non-authenticated user
- Simple token-gated route, no new infra needed

### Cross-flight pattern recognition
- Aggregate dashboard layer: how often flight following requested, approaches by type over time, IMC hours by month
- Requires enough transcribed flights to be meaningful
- Low priority until transcript coverage is higher

### Approach chart overlay on map (MAJOR FEATURE)
This is the most ambitious feature — plotting the FAA approach plate on the 3D map as a geo-registered overlay, with the actual flown vertical path drawn on top.

**Phase 1 — Geo-register the approach chart PDF**
- We already archive the FAA chart PDF to S3 at `public/flights/charts/{pdfname}`
- Convert PDF → SVG (server-side, e.g. via pdf2svg or Inkscape CLI in Lambda)
- Extract the plan-view bounding box: use the known fix coordinates from `approachProcedure.fixes` (we have lat/lon for IAF, FAF, MAP) as ground control points
- Compute an affine transform: map (pixel x,y) → (lon, lat) using 3+ GCP pairs
- Store the transform matrix alongside the SVG in S3
- On the Cesium globe, use `SingleTileImageryProvider` or a `GroundPrimitive` rectangle to drape the SVG over the terrain at the correct geo extent, with rotation applied

**Phase 2 — Fetch METAR for approach time**
- For each approach flown, estimate the approach time from the KML track (find the segment near the destination airport at low altitude)
- Query the NOAA METAR API (or aviationweather.gov) for the destination airport at that time
  - `https://aviationweather.gov/cgi-bin/data/metar.php?ids={ICAO}&hours=2&format=json`
  - For historical METARs: Iowa State ASOS archive or NOAA ISD
- Parse altimeter setting (QNH) from the METAR
- Store on the flight record: new fields `approachMETARs: string` (JSON array, one per approach)
- Also store raw METAR string for display in the detail panel

**Phase 3 — Plot vertical path on approach plate**
- The approach plate has a profile view (side view) section — a fixed pixel-coordinate region on the SVG
- Map the profile view's altitude axis using the published MDA/DA and step-down altitudes from the approach plate (or from CIFP data we already have)
- Use the KML track + altimeter setting (QNH from METAR) to compute pressure-altitude-corrected MSL altitudes
- Project the KML positions onto the approach course line to get a distance-from-MAP value
- Plot a colored polyline over the profile view section of the SVG
- Result: the actual flown vertical path drawn on the published approach plate

**Notes / dependencies**
- PDF→SVG conversion needs a server-side step (Lambda or build-time script) — can't run pdf2svg in the browser
- GCP extraction requires matching fix pixel coords to the SVG — may need semi-manual calibration for the first few plates, then automate
- METAR historical data: aviationweather.gov only keeps ~24h; for older flights, use NOAA's ISD Lite (hourly surface observations) or ASOS network archives
- Mobile: the overlay + vertical path should render in the Cesium mobile view; the SVG overlay may need to be rasterized to PNG at a fixed resolution for performance
- As always: test mobile version at every phase

### Ideal approach path overlay (existing TODO)
- Use `approachProcedure.fixes` (lat/lon + altitude constraints) to construct the "ideal" approach path
- Plot as a semi-transparent overlay alongside the actual KML track
- Helps visualize deviation from the published procedure
- Pairs with the chart overlay above — the ideal path and actual path shown together

## Inventory

### Beverages model
- New category `BEVERAGE` with a dedicated `inventoryBeverage` detail model
- Fields: `type` (WINE, VODKA, SCOTCH, BOURBON, TEQUILA, RUM, GIN, BEER, OTHER), `vintage` (year), `region`, `varietal`, `abv`, `volume_ml`, `quantity`
- Include a `rating` field (1–100 or 1–5) for bottles tried

### Clothes model
- New category `CLOTHING` with a dedicated `inventoryClothing` detail model
- Fields: `type` (SHIRT, PANTS, JACKET, SHOES, etc.), `size`, `color`, `brand`, `material`, `occasion` (CASUAL, FORMAL, ATHLETIC)
- Future: ML-powered outfit suggestion based on occasion, weather, or color theory
