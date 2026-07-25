# scripts/archive

One-time fixes, migrations, backfills, and debug probes that have already run
against prod. Kept for reference — the relative `../aws-config.mjs` import
breaks from this directory, so to re-run one, move it back to `scripts/` first.

| Script | What it did | Ran |
|---|---|---|
| `fix_credit_card_import_signs.mjs` | Un-flipped Chase CSV import signs + reset balance | ✔ |
| `migrate_inventory_status.mjs` | `active` boolean → `status` enum migration | ✔ |
| `migrate_transfer_recurrings.mjs` | Recurring transfer rows migration | ✔ |
| `reclassify_overdrafts.mjs` | One-time category fix | ✔ |
| `reclassify_sf_trades.mjs` | Reclassified SimpleFIN trade rows | ✔ |
| `backup_holding_lots.mjs` | Pre-migration lot backup | ✔ |
| `backfill_meta_sells.mjs` | Backfilled META sell lot consumptions | ✔ |
| `backfill_rounds_available.mjs` | Backfilled ammo FIFO counters | ✔ |
| `backfill_holdings.mjs` | Backfilled financeHolding from lots | ✔ |
| `import_401k_history.mjs` | One-time 401k history import | ✔ |
| `probe_fields.mjs` / `probe_media.mjs` / `probe_schema.mjs` | Schema debug probes | n/a |
| `introspect-inventory.mjs` | Inventory schema introspection probe | n/a |
| `debug_kml.py` | KML parsing debug helper | n/a |
