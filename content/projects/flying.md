# Building a 3D flight log site with Claude

A personal flight log built around a Cesium 3D globe. ForeFlight exports get imported via email, KML tracks get archived to S3, FAA approach charts get pulled from the current dTPP cycle, and cockpit videos sync to the live track during playback.

## What it is

Not just a logbook. The page renders flights as 3D paths over real terrain — every track stacked on the globe, color-coded, clickable. Click a flight and the camera flies to it, the track highlights, the FAA approach charts I flew show up as chips, and any cockpit videos for that flight appear alongside. Hit play and the globe's camera follows the airplane in real time while the video plays — heading, altitude, ground speed, vertical-speed, all derived from the track segment around the current playhead.

Roughly:

- **~1,200 flights** in the logbook, imported from ForeFlight CSV via SES → S3 → Lambda
- **~200 KML tracks** archived from FlightAware, parsed at render time to drive the globe
- **~300 archived FAA approach plates** mirrored from the current dTPP cycle to S3 — FAA cycles roll every 28 days and old ones disappear, so we archive at import time
- **~15 cockpit videos** with KML-offset metadata so the playhead maps to the right point on the track

## The map layer

Cesium does the heavy lifting — terrain, imagery, camera, primitives — but the layer composition is mine. Every flight is a `PolylineCollection` entry, color-keyed by flight ID so a specific path is pickable in a tangle. Active flight is highlighted; inactive flights are dimmed. Airport icons (a separate `BillboardCollection`) show bullets at airfields you've been to, sized by frequency.

The performance lesson: drawing 200 polylines naively kills the framerate. Cesium's collection primitives batch them into a single GPU draw call — the difference between 60 fps and 8 fps on a laptop. Same lesson applied to airport icons.

## KML routes and derived stats

ForeFlight's per-flight KML has hundreds-to-thousands of track points with lat/lon/alt/time. From that I derive heading, ground speed, and vertical speed at any timestamp by looking at the segment surrounding `t` (three-point central difference). That's what feeds the in-video PiP overlay — heading rose, altitude tape, VSI needle.

The KML never goes to the database. It's parsed in-browser at view time and cached in memory; the S3 archive is the source of truth. Flight metadata in the model is just enough to find and display the flight; the geometry stays in S3.

## FAA APIs (and the cron archive)

Two FAA datasets matter:

- **NASR** (airports) — quarterly download, parsed once into an `airport` table with lat/lon/name. The 3D globe's airport layer reads from this. The parser normalizes coordinates from FAA's degree-minute-second format to decimal.
- **dTPP** (approach charts) — 28-day cycles. PDFs at `https://aeronav.faa.gov/d-tpp/{CYCLE}/{name}.pdf`. Old cycles disappear after 1–2 rotations, so each chart is mirrored to S3 at flight-import time keyed by filename (cycle-independent — same plate name across cycles is the same chart). The flight's `approachChartKeys` array stores the S3 keys; the UI renders them as chips.

The "archive at import" decision turned out to matter. An earlier version fetched live from FAA at view time, but a chart referenced in a 6-month-old flight would 404 because the cycle had rotated. Now every chart I might ever want to display is mine.

## Video–route sync

The trickiest piece. Cockpit videos carry a `kmlOffsetSec` field — the offset between the video's `t=0` and the KML's `t=0`. When the user scrubs the video, the player emits the playhead time; I map that to a KML timestamp via the offset, find the surrounding track points, and update Cesium's camera + the PiP overlay.

Two non-obvious bits:

- **Camera smoothing** — naive "set camera to current track point each frame" jitters because consecutive points are noisy. `Cesium.Cartesian3.lerp` between adjacent points based on sub-second progress is smooth enough to look like real flight.
- **Vertical profile strip** — a small SVG bar under the video shows the full flight's altitude profile with a moving cursor at the playhead. Built once per flight from the KML, then only the cursor's x position updates per frame. Drawing the SVG every frame would be wasteful.

The `kmlOffsetSec` itself is hand-tuned per video (find a recognizable moment in both the video and the KML, subtract). Annoying but one-time per video.

## Honest assessment

This site exists because I wanted to actually *look at* my flight history, not just read a CSV. Building it taught me Cesium, the FAA's quirky bulk-data formats, and how much state can hide inside a single video player. The thing I'm most pleased with is the end-to-end import flow: I forward a ForeFlight email to `logbookimport@gennaroanesi.com`, an SES rule writes the CSV to S3, a Lambda parses + diffs + creates flight rows + archives the approach charts, and an hour later the new flight is on the globe. Zero manual steps after the email.
