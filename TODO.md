# TODO

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
