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

