# TODO

## Flights (personal website)

### Email-triggered logbook import
- Forward a ForeFlight CSV export email to `logbookimport@gennaroanesi.com`
- SES receives the email, stores it in S3, triggers a Lambda
- Lambda parses the attachment, maps ForeFlight CSV columns to the `flight` model, upserts new records (keyed on date + from + to + aircraftId to avoid duplicates)
- New flights land with `published: false` — review and publish manually via admin UI
- Tech stack: SES → S3 → Lambda (Node) → AppSync mutation
- Need to: verify domain in SES, set up MX record for `gennaroanesi.com`, configure receipt rule

### KML upload flow
- After importing a flight, upload the corresponding KML to S3 and update `kmlS3Key` on the record
- Consider a drag-and-drop UI in the admin panel that matches KML filename to flight by date/route

### Flights page (public)
- Cesium 3D globe showing all published flight tracks
- Per-flight detail: 3D replay + video embed + ForeFlight stats
- Video/KML timestamp sync via `videoOffsetSec`
- Filters: year, flight type, conditions

## Inventory

### Beverages model
- New category `BEVERAGE` with a dedicated `inventoryBeverage` detail model
- Fields to consider: `type` (enum: WINE, VODKA, SCOTCH, BOURBON, TEQUILA, RUM, GIN, BEER, OTHER), `vintage` (year integer), `region`, `varietal` (for wines: Cabernet, Malbec, etc.), `abv`, `volume_ml`, `quantity` (bottles on hand)
- Wines will be the primary use case but the model should accommodate spirits without forcing wine-specific fields
- Could include a `rating` field (1–100 or 1–5) for bottles you've tried

### Clothes model
- New category `CLOTHING` with a dedicated `inventoryClothing` detail model
- Fields to consider: `type` (SHIRT, PANTS, JACKET, SHOES, etc.), `size`, `color`, `brand`, `material`, `occasion` (CASUAL, FORMAL, ATHLETIC, etc.)
- Future: ML-powered outfit suggestion — feed wardrobe into a model that suggests combinations based on occasion, weather, or color theory
