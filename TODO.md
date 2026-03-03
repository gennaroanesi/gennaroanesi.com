# TODO

## Flights (personal website)

### Flying page — stats header
- Add a summary bar at the top of the flying page with key logbook stats
- Total hours, total PIC, total cross-country, total night, total IMC/IFR
- Number of unique airports visited, number of instrument approaches
- Consider a "hours by year" sparkline or bar chart
- Mobile: collapse into a horizontally-scrollable pill row

### Flying page — milestones timeline
- Vertical or horizontal timeline showing flights with `milestone` set
- E.g. "First Solo", "First Solo XC", "Checkride", "IPC", etc.
- Could double as a visual logbook narrative — scroll through the story of training
- Each entry: date, from→to, milestone label, optional short notes excerpt

### Flying page — highlight reel (Meta Rayban videos)
- Curated section with 4–5 featured videos (best Meta Rayban clips)
- Each video has a caption, and optionally links to a flight detail
- Autoplaying muted loop on desktop, tap-to-play on mobile
- Could be a full-width horizontal scroll or a grid
- Uses the existing `flightMedia` model — flag certain entries as "featured" (add `isFeatured: boolean` field or use `sortOrder` convention)

### Per-flight media section
- In the flight detail panel, add a "Media" section below Approaches
- Queries `flightMedia` by `flightId`, renders embedded video players (YouTube/Vimeo)
- Shows `label`, `camera` type badge, and `offsetSec` (if set, show "starts at Xm Ys into flight")
- Admin UI: attach/remove videos per flight, set offset and label
- Mobile: media section scrolls horizontally as video cards

### Email-triggered logbook import
- Set up email address `logbookimport@gennaroanesi.com` via AWS SES
- Forward a ForeFlight CSV export email to that address — SES stores it in S3, triggers Lambda
- Lambda parses the attachment (ForeFlight CSV), maps columns to the `flight` model, upserts new records
  - Upsert key: date + from + to + aircraftId (skip duplicates)
  - New flights land with `published: false`
  - Run `archiveChartsForFlight` for any new approach flights
- Tech stack: SES receipt rule → S3 → Lambda (Node) → AppSync mutations
- Steps: verify `gennaroanesi.com` domain in SES, add MX record pointing to SES inbound endpoint, configure receipt rule set, write Lambda handler reusing existing `import_flights.mjs` logic

### KML upload flow
- After importing a flight, upload the corresponding KML to S3 and update `kmlS3Key` on the record
- Consider a drag-and-drop UI in the admin panel that matches KML filename to flight by date/route

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
