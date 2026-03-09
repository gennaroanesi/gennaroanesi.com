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

### Barcode scanner integration (Tera HW0009)

The scanner behaves as a Bluetooth keyboard — it "types" the barcode string into whatever
has focus. No custom driver needed. Pair it to the Raspberry Pi and have the Pi relay
scans to API Gateway, same pattern as home events.

#### How the scanner connects

- **Pair to Pi via Bluetooth** — scanner sends barcode string as keyboard input
- Pi runs a small listener (`barcode-listener.ts` in `home-relay`) that captures
  the input and POSTs `{ type: "BARCODE_SCANNED", barcode: "012345678901" }` to
  `POST /home/event` on API Gateway
- Alternatively: pair to phone and use a focused input field in the website PWA
  (simpler, but requires phone nearby and browser open — Pi approach preferred)

#### Pi relay addition (`home-relay/src/barcode.ts`)

```ts
// Reads from /dev/input/eventX (the HID keyboard device the scanner presents as)
// Uses the `node-hid` or `readline` from stdin approach:
// - Set scanner to HID mode (default)
// - Run: sudo bluetoothctl pair <scanner MAC>
// - The scanner appears as a keyboard input device
// - Listen on stdin or /dev/input, buffer chars until newline, POST barcode
```

Alternative: use `evdev` on Linux to read directly from the input device without
need for a focused window.

#### Product lookup Lambda (`barcodeLookup`)

**New file:** `amplify/functions/barcodeLookup/`  
**Trigger:** called by `homeEventHandler` when event type is `BARCODE_SCANNED`  
**Timeout:** 15s

**Lookup chain (in order):**

| API | Coverage | Key | Notes |
|-----|----------|-----|-------|
| UPCitemdb | Broad retail, clothing, electronics | Free tier 100/day, paid after | Best general coverage, returns images |
| Open Food Facts | Food & drink | None needed | Open data, excellent coverage |
| Open Beauty Facts | Personal care | None needed | Same project as above |
| Google Custom Search (fallback) | Images only | Needs API key | Use if above return no image |

**Lookup response shape:**
```ts
{
  barcode: string,
  found: boolean,
  name?: string,
  brand?: string,
  category?: string,       // used to route to correct inventory model
  imageUrls?: string[],
  rawResponse?: object,
}
```

**Category → inventory model routing:**

| Detected category | Target model |
|---|---|
| Food, snack, beverage | `inventoryBeverage` (or new `inventoryFood`) |
| Wine, beer, spirits | `inventoryBeverage` |
| Clothing, apparel, shoes | `inventoryClothing` |
| Ammunition, firearms | `inventoryAmmo` |
| Personal care | future `inventoryMisc` |
| Unknown | prompt user to classify |

**Flow after lookup:**
1. Look up barcode
2. If found: create a draft record in the right model with resolved fields + image URL
3. Send WhatsApp confirmation: `"Scanned: Nike Air Max 270 (Shoes) — add to clothing inventory? Reply yes/no"`
4. On "yes": commit the record
5. If not found: `"Barcode 012345678901 not found in any database. What is it?"` → free-text reply → manual record

#### Clothing image resolution detail

For clothing specifically, the goal is to store a product image URL in the record
so the inventory UI can display it. Priority order:

1. **UPCitemdb** — often returns `images[]` array with product photos
2. **Walmart Open API** — strong apparel coverage, returns image URLs
3. **Google Custom Search API** — search `"{product name} {brand}"`, take first image result
4. **No image found** — store null, show placeholder in UI; allow manual photo upload later

Image URLs are stored on the `inventoryClothing` record as `imageUrl: a.string()`.
The UI renders them as product cards in the clothing inventory page.

#### Secrets needed

```bash
# UPCitemdb (if upgrading past free tier)
aws secretsmanager create-secret \
  --name gennaroanesi/barcode \
  --secret-string '{"upcitemdbKey":"xxx","googleSearchKey":"xxx","googleSearchCx":"xxx"}'
```

Free tier (UPCitemdb 100/day + Open Food Facts unlimited) is enough to start —
no secret needed until you exceed limits.

#### Schema additions needed

Add to `inventoryClothing` model (when built):
```ts
imageUrl:     a.string(),     // resolved product image
barcodeUpc:   a.string(),     // raw UPC/EAN scanned
scanSource:   a.string(),     // "upcitemdb" | "manual" | etc.
```

Add to `inventoryBeverage` model:
```ts
barcodeUpc:   a.string(),
scanSource:   a.string(),
```

#### Build order

1. **Pi barcode listener** (`home-relay/src/barcode.ts`) — pair scanner, capture input, POST to `/home/event`
2. **`barcodeLookup` Lambda** — UPCitemdb + Open Food Facts lookup, draft record creation
3. **Wire into `homeEventHandler`** — route `BARCODE_SCANNED` events to `barcodeLookup`
4. **WhatsApp confirmation flow** — same pending-intent pattern as agent
5. **Clothing inventory UI** — product cards with images once records are flowing
6. **Google image fallback** — add only if UPCitemdb image coverage proves insufficient

---

## Home Automation

Integrate household devices (UniFi, Eufy, Furbo) with the existing AWS stack.
All events flow through API Gateway → Lambda → DynamoDB / S3 (PARA notes) / WhatsApp notifications.

### Architecture overview

```
UniFi Protect ──────────────────────────────────→ API Gateway → homeEventHandler Lambda
                                                         ↑
Eufy locks ──→ Raspberry Pi relay (Node.js) ──→ API Gateway → homeEventHandler Lambda
                       ↑
UDM Pro presence ──────┘  (Pi polls UniFi controller API every 30s)
```

The Raspberry Pi is a persistent bridge between the local home network and AWS.
It runs a single Node.js service (`home-relay`) that connects to Eufy locally
and polls UniFi for presence — neither can be done from a stateless Lambda.

Furbo has no public API or local protocol. Only IFTTT applets exist (motion, barking).
Not worth building real infrastructure around — skip or add a trivial IFTTT → webhook shim later.

---

### 1. `homeEventHandler` Lambda (AWS — Amplify)

**New file:** `amplify/functions/homeEventHandler/`  
**Resource group:** `data` (same as other event-handling functions, avoids circular deps)  
**Timeout:** 30s  
**Trigger:** `POST /home/event` on API Gateway (same HTTP API as notesApi, new route)

**Auth:** Bearer token from `gennaroanesi/home` secret (same pattern as notesApi)

**Event envelope:**
```ts
{
  type: HomeEventType,   // see enum below
  source: string,        // "unifi-protect" | "eufy" | "unifi-presence"
  camera?: string,       // camera name for Protect events
  device?: string,       // lock name / MAC address
  person?: string,       // "gennaro" | "cris" — for presence events
  payload: object,       // raw event data from source
  timestamp: string,     // ISO 8601
}
```

**Event types and routing logic:**

| Event type | Action |
|---|---|
| `PACKAGE_DETECTED` | WhatsApp alert + create task "Check for package" |
| `PERSON_AT_DOOR` | WhatsApp alert with camera name |
| `DOORBELL_RING` | WhatsApp alert |
| `MOTION_GARAGE` | WhatsApp alert if after midnight |
| `CAMERA_OFFLINE` | WhatsApp alert |
| `DOOR_UNLOCKED` | Log to DynamoDB `homeEvent` table |
| `DOOR_LOCKED` | Log to DynamoDB `homeEvent` table |
| `DOOR_UNLOCKED_TOO_LONG` | WhatsApp reminder ("Front door still unlocked") |
| `LOCK_BATTERY_LOW` | WhatsApp alert |
| `PRESENCE_ARRIVAL` | Log + WhatsApp ("Gennaro arrived home") |
| `PRESENCE_DEPARTURE` | Log event |
| `PRESENCE_ALL_AWAY` | Log + optionally trigger auto-lock |
| `UNKNOWN_DEVICE` | WhatsApp security alert |

**New DynamoDB model** (add to `amplify/data/resource.ts`):
```ts
homeEvent: a.model({
  type:      a.string().required(),
  source:    a.string().required(),
  camera:    a.string(),
  device:    a.string(),
  person:    a.string(),
  payload:   a.string(),   // JSON blob
  timestamp: a.string().required(),
}).authorization(owners => [owners.owner()])
  .secondaryIndexes(idx => [idx("type"), idx("timestamp")])
```

**New API Gateway route** (add to the notesApi CDK block in `backend.ts`):
```ts
new CfnRoute(notesScope, "HomeEventRoute", {
  apiId:    cfnApi.ref,
  routeKey: "POST /home/event",
  target:   `integrations/${homeEventIntegration.ref}`,
});
```

**IAM:** `homeEventHandler` needs:
- `dynamodb:PutItem` on `homeEvent` table
- `lambda:InvokeFunction` on `sendNotification` (for WhatsApp alerts)
- Read `gennaroanesi/home` secret

**Post-deploy:** Create the secret:
```bash
TOKEN=$(openssl rand -base64 32)
aws secretsmanager create-secret \
  --name gennaroanesi/home \
  --secret-string "{\"token\":\"$TOKEN\"}"
```

---

### 2. UniFi Protect webhook

**No Pi needed** — Protect POSTs webhooks directly to API Gateway.

**Setup (in UniFi Protect UI):**
1. Settings → Notifications → Webhooks → Add Webhook
2. URL: `https://<api-gw-id>.execute-api.us-east-1.amazonaws.com/home/event`
3. Events to enable:
   - Smart detections: `package`, `person`, `vehicle`
   - Doorbell ring
   - Camera connectivity (offline/online)
   - Motion (optionally — noisy, filter by camera in Lambda)

**In `homeEventHandler`:** parse Protect's webhook payload shape:
```ts
// Protect sends: { event: { type, smartDetectTypes, camera, start, end, ... } }
// Map to HomeEventType based on event.type + event.smartDetectTypes
```

**Note:** Protect webhooks require the camera/NVR to have internet access to reach API Gateway.
Alternatively, the Pi can subscribe to the local Protect WebSocket (port 7441) and relay events —
use this if you want to avoid exposing the NVR to outbound internet.

---

### 3. Raspberry Pi relay service (`home-relay`)

**Location:** `~/home-relay/` on the Pi (not in this repo — separate project)
**Runtime:** Node.js 20 + TypeScript
**Process manager:** `systemd` (auto-restart on reboot)

**Directory structure:**
```
home-relay/
  src/
    index.ts          — starts all modules
    eufy.ts           — eufy-security-client event listener
    presence.ts       — UniFi controller API poller (30s interval)
    protect.ts        — optional: local UniFi Protect WS listener (alt to webhooks)
    client.ts         — shared HTTP client → POST to API Gateway /home/event
    config.ts         — reads from .env
  .env                — API_URL, HOME_API_TOKEN, EUFY_*, UNIFI_*
  package.json
  tsconfig.json
  home-relay.service  — systemd unit file
```

**Key dependencies:**
```json
"eufy-security-client": "^3.x",
"axios": "^1.x",
"dotenv": "^16.x"
```

**`eufy.ts` — what it does:**
- Connects to Eufy homebase on the local network using `eufy-security-client`
- Listens for: `lock_status_changed`, `battery_low`
- Maps to `DOOR_LOCKED`, `DOOR_UNLOCKED`, `LOCK_BATTERY_LOW` events
- Tracks unlock time; if door still unlocked after N minutes → emits `DOOR_UNLOCKED_TOO_LONG`
- POSTs each event to `client.ts`

**`presence.ts` — what it does:**
- Polls UniFi controller API (`https://192.168.1.1/proxy/network/api/s/default/stat/sta`) every 30s
- Maintains a local set of "currently connected" devices
- Config maps MAC addresses to people: `{ "aa:bb:cc:dd:ee:ff": "gennaro", ... }`
- On new device seen → emit `PRESENCE_ARRIVAL`
- On device gone → emit `PRESENCE_DEPARTURE`
- When both known phones gone → emit `PRESENCE_ALL_AWAY`
- On unknown device → emit `UNKNOWN_DEVICE` (opt-in, can be noisy)

**`protect.ts` (optional — alternative to Protect webhooks):**
- Subscribes to local Protect WebSocket at `wss://192.168.1.1:7441/proxy/protect/ws/updates`
- Same event mapping as webhook approach but purely local (no outbound NVR internet needed)
- Use one or the other — not both

**`.env` shape:**
```
API_URL=https://<id>.execute-api.us-east-1.amazonaws.com
HOME_API_TOKEN=<token from gennaroanesi/home secret>
EUFY_USERNAME=<eufy account email>
EUFY_PASSWORD=<eufy account password>
EUFY_COUNTRY=US
UNIFI_HOST=192.168.1.1
UNIFI_USERNAME=<unifi local admin>
UNIFI_PASSWORD=<unifi local admin password>
KNOWN_DEVICES={"aa:bb:cc:dd:ee:ff":"gennaro","11:22:33:44:55:66":"cris"}
DOOR_UNLOCK_TIMEOUT_MINUTES=10
```

**`systemd` unit file (`home-relay.service`):**
```ini
[Unit]
Description=Home relay service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/home-relay
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**Install:**
```bash
sudo cp home-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable home-relay
sudo systemctl start home-relay
```

---

### 4. WhatsApp agent tools (add to `whatsappAgent/handler.ts`)

Once `homeEventHandler` is logging to DynamoDB, expose these tools in the agent:

| Tool | Description |
|---|---|
| `check_door_lock` | Query latest `DOOR_LOCKED`/`DOOR_UNLOCKED` event for a named lock |
| `lock_door` | POST a lock command to Pi relay (needs a `/home/command` endpoint on Pi) |
| `get_presence` | Return who is currently home based on latest presence events |
| `recent_home_events` | List last N home events, optionally filtered by type |

**`lock_door` note:** requires a reverse channel — API Gateway → Pi. Options:
- Pi polls a "pending commands" endpoint every 10s (simple, no open port)
- AWS IoT Core MQTT (cleaner, more complex)
- Start with polling; migrate to IoT Core if latency matters

---

### 5. Build order

1. **`homeEventHandler` Lambda + `homeEvent` DynamoDB model** — AWS side first, can test with `curl`
2. **UniFi Protect webhook** — easiest integration, no Pi needed, immediate value (package detection)
3. **Pi relay — presence detection** — find your phone MACs, configure `presence.ts`, deploy
4. **Pi relay — Eufy locks** — connect `eufy-security-client`, test lock/unlock events
5. **WhatsApp agent tools** — `check_door_lock`, `get_presence` once events are flowing
6. **`lock_door` reverse channel** — polling endpoint or IoT Core, last because it needs the Pi ↔ AWS reverse path

---

### 6. Furbo (skip for now)

Furbo has no local API and no official webhook support. The only integration path is IFTTT
(motion detected, barking detected) which is fragile and limited. A UniFi camera pointed
at Dolce's usual spots gives better coverage with the stack you already own.
Revisit if Furbo ever opens an API.
