# Gennaro website

[https://gennaroanesi.com](https://gennaroanesi.com)

---

## FAA Aviation Data — Seeding Airports & Instrument Approaches

The `airport` and `instrumentApproach` models are seeded from FAA NASR and d-TPP data. These files are updated every **56 days** on the FAA's aeronautical chart cycle.

### Step 1 — Download FAA source files

You need two files, both placed in `scripts/nasr/`:

```
scripts/
  nasr/
    APT_BASE.csv          ← from FAA NASR subscription
    d-TPP_Metafile.xml    ← from FAA d-TPP current cycle
```

#### APT_BASE.csv (airport data)

1. Go to [https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/](https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/)
2. Click the current cycle date to download the ZIP
3. Extract the ZIP — find `APT_BASE.csv` inside the `APT_Data/` folder
4. Copy it to `scripts/nasr/APT_BASE.csv`

> Direct ZIP URL pattern (update the date for the current cycle):
> `https://nfdc.faa.gov/webContent/56DaySub/56DySubscription_YYYY-MM-DD_CSV.zip`

#### d-TPP_Metafile.xml (instrument approach procedures)

1. Go to [https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dtpp/)
2. Under **Terminal Procedures Publication (d-TPP)**, find the current cycle
3. Download `d-TPP_Metafile.xml` directly:
   `https://aeronav.faa.gov/d-tpp/YYMM/d-TPP_Metafile.xml`
   where `YYMM` is the current cycle (e.g. `2603` for the March 2026 cycle)
4. Copy it to `scripts/nasr/d-TPP_Metafile.xml`

> You can always get the current cycle metafile at:
> `https://nfdc.faa.gov/webContent/dtpp/current.xml`
> (redirects to the current cycle automatically)

---

### Step 2 — Parse & seed

Once both files are in `scripts/nasr/`, run in order:

```bash
npm run parse-nasr       # generates scripts/data/airports.full.json
npm run parse-dtpp       # generates scripts/data/iaps.json
npm run seed-airports    # seeds Airport table via GraphQL API
npm run seed-iaps        # seeds InstrumentApproach table via GraphQL API
```

Alternatively, pass file paths directly instead of placing them in `scripts/nasr/`:

```bash
# parse-nasr: [apt_base_csv] [output_dir]
npm run parse-nasr -- /path/to/APT_BASE.csv /path/to/output/dir

# parse-dtpp: [dtpp_metafile_xml] [output_iaps_json]
npm run parse-dtpp -- /path/to/d-TPP_Metafile.xml /path/to/output/iaps.json

# seed-airports: [airports_full_json] [amplify_outputs_json]
npm run seed-airports -- /path/to/airports.full.json /path/to/amplify_outputs.json

# seed-iaps: [iaps_json] [airports_full_json] [amplify_outputs_json]
npm run seed-iaps -- /path/to/iaps.json /path/to/airports.full.json /path/to/amplify_outputs.json
```

Prerequisites before seeding:
- `amplify_outputs.json` must exist (run `npm run sandbox` or deploy first)
- The Amplify schema must be deployed with the `airport` and `instrumentApproach` models

---

## FAA CIFP — Seeding Approach Procedure Fixes

The `approachProcedure` model is seeded from the FAA CIFP (Coded Instrument Flight Procedures) file in ARINC 424-18 format. Each record stores a full approach procedure with its fix sequence, lat/lon coordinates, and altitude constraints. The CIFP is updated every **28 days** on the AIRAC cycle.

### Step 1 — Download CIFP

1. Go to [https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/)
2. Accept the terms and download the current cycle ZIP (`CIFP_YYYYMMDD.zip`)
3. Extract the ZIP — find the file named `FAACIFP18` inside
4. Copy it to `scripts/nasr/FAACIFP18`

### Step 2 — Parse & seed

```bash
npm run parse-cifp    # generates scripts/data/cifp-fixes.json
npm run seed-cifp     # seeds ApproachProcedure table (airports in your Airport table only)
```

By default `seed-cifp` only seeds procedures for airports already in your `Airport` table. To seed all ~65k procedures across every US airport:

```bash
node scripts/seed-cifp.mjs --all
```

Alternatively, pass file paths directly:

```bash
# parse-cifp: <FAACIFP18_path> [output_json]
npm run parse-cifp -- /path/to/FAACIFP18
npm run parse-cifp -- /path/to/FAACIFP18 /path/to/output/cifp-fixes.json

# seed-cifp: [cifp_fixes_json] [amplify_outputs_json]
node scripts/seed-cifp.mjs /path/to/cifp-fixes.json
node scripts/seed-cifp.mjs /path/to/cifp-fixes.json /path/to/amplify_outputs.json
```

Prerequisites before seeding:
- `amplify_outputs.json` must exist (run `npm run sandbox` or deploy first)
- The Amplify schema must be deployed with the `approachProcedure` model
- Airports must already be seeded (`npm run seed-airports`) if using the default filtered mode

---

### Re-seeding on a new cycle

| Dataset | Cycle | Scripts |
|---|---|---|
| Airports + IAPs (NASR / d-TPP) | Every 56 days | `parse-nasr`, `parse-dtpp`, `seed-airports`, `seed-iaps` |
| Approach fixes (CIFP) | Every 28 days | `parse-cifp`, `seed-cifp` |

Duplicate records are skipped automatically (the seed scripts ignore `ConditionalCheckFailedException`).

