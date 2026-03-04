# CLAUDE.md — Project Notes & Gotchas

Guidelines and hard-won lessons for working in this repository.

---

## 1. Detect the environment before running commands

Before executing any shell commands or file operations, determine which machine you're on:

| Machine | OS | Path style | How to tell |
|---|---|---|---|
| **Home PC** | Windows + Ubuntu WSL | `\\wsl.localhost\Ubuntu\home\gennaroanesi\repositories\gennaroanesi.com\` | Filesystem paths start with `\\wsl.localhost\Ubuntu` |
| **Work PC** | macOS (MacBook) | `/Users/gennaroanesi/repositories/gennaroanesi.com/` | Filesystem paths start with `/Users/` |

On the **home PC (WSL)**, file edits via the Filesystem tool write to the Windows-side path `\\wsl.localhost\Ubuntu\...`. Shell commands run inside WSL see the same files at `~/repositories/gennaroanesi.com/`. Confirm writes actually landed before telling the user the file is updated — WSL path writes can silently fail if the mount is stale.

On the **MacBook**, everything is native Unix and paths behave normally.

---

## 2. Always implement a mobile version for UI changes

Every UI change must be tested and designed for mobile. This app is frequently viewed on phones.

- Use Tailwind responsive prefixes: `sm:`, `md:`, `lg:` — default styles are mobile-first
- Navigation on mobile collapses into a hamburger / bottom sheet — don't assume a sidebar is visible
- Font sizes: use `text-sm` or `text-base` on mobile; avoid fixed `px` sizes
- Touch targets must be at least 44×44px (use `p-3` minimum on interactive elements)
- Horizontal scroll is acceptable for dense data (e.g. flight stat pills), but full-page horizontal scroll is not
- The Cesium 3D globe has a separate mobile rendering path — test KML overlays on narrow viewports
- The design system is **navy / cream / amber** — keep this consistent across breakpoints

---

## 3. AWS environments: sandbox vs. prod

There are two AppSync environments. **Always confirm which env you're targeting before mutations.**

| Env | AppSync URL fragment | Used for |
|---|---|---|
| `sandbox` | `xaictck6irbbzfa6n5lsayukwq` | Local development, schema iteration |
| `prod` | `cdglsrrdm5fhrnu6wge6533jyy` | Live site at gennaroanesi.com |

- Scripts in `scripts/` accept `--env=sandbox|prod` (default: `prod`)
- Config lives in `scripts/aws-config.mjs` — both the AppSync URL **and** the API key must match the env
- The repo's `amplify_outputs.json` points to **sandbox** — do not use it as a source of truth for prod API keys
- Prod API key: stored in `aws-config.mjs` under `prod.apiKey`. If it's `null`, retrieve it with:
  ```bash
  aws appsync list-api-keys --api-id cdglsrrdm5fhrnu6wge6533jyy --region us-east-1
  ```

---

## 4. Amplify Gen2 typed client drops array fields

**Bug**: When using the Amplify Gen2 typed client (`.list()`, `.get()`), array fields like `approachChartKeys: string[]` are silently omitted from the response.

**Fix**: Use raw GraphQL queries for any model that has array fields:
```ts
const result = await client.graphql({
  query: `query { listFlights { items { id approachChartKeys ... } } }`,
  authMode: "apiKey",
});
```
Affected models: `flight` (approachChartKeys), any future model with `.array()` fields.

---

## 5. InstrumentApproach — no airportId GSI (yet)

The `instrumentApproach` table has no secondary index on `airportId` in the current prod schema.

- **Do not** use `listInstrumentApproachByAirportId` — it doesn't exist in prod and will return a `FieldUndefined` GraphQL error
- **Use** `listInstrumentApproaches(filter: { airportId: { eq: "KXXX" } }, limit: 200)` instead
- Once `.secondaryIndexes((index) => [index("airportId")])` is deployed and `amplify push` is run, the GSI query will exist and `archive-charts.mjs` can be updated to use it

---

## 6. FAA chart archival

- Charts are archived from `https://aeronav.faa.gov/d-tpp/{CYCLE}/{pdfName}` → S3 at `public/flights/charts/{pdfname}`
- FAA cycles are 28 days; old cycles disappear after ~1–2 rotations — archive at **import time**, not publish time
- `pdfName` is cycle-independent: same filename = same chart revision, so S3 deduplication by filename is safe
- The `archiveChartsForFlight()` function in `scripts/archive-charts.mjs` is the canonical implementation; both `import_flights.mjs` and `publish_flights.mjs` call it
- S3 bucket policy: `public/*` has guest `get` + `list` access — charts are publicly readable at `https://gennaroanesi.com.s3.amazonaws.com/public/flights/charts/{pdfname}`

---

## 7. GraphQL auth headers

Two auth modes are in use:

| Header | Used for |
|---|---|
| `Authorization: <Cognito JWT>` | Admin writes (create/update/delete on all models) |
| `x-api-key: <API key>` | Public reads (flight, flightMedia, airport, instrumentApproach, approachProcedure) |

Scripts that do both (e.g. `archive-charts.mjs`) accept a JWT for mutations and use the API key for reads against public models.

---

## 8. ForeFlight CSV import

- ForeFlight exports contain two tables in one CSV: **Aircraft Table** (top) and **Flights Table** (below)
- Approach columns are `Approach1`–`Approach6`, format: `count;type;runway;airport;;`
  - e.g. `1;ILS OR LOC RWY 33;33;KGRK;;` → stored as `ILS OR LOC RWY 33@KGRK`
- Upsert key: `date + from + to + aircraftId` — duplicate detection skips re-imports
- All flights land with `published: false`; publish manually via admin UI or `publish_flights.mjs`

---

## 9. Admin UI convention — sidebar layout

All admin sections use a **shared layout with a left sidebar** (desktop) and **top tab bar** (mobile), following the same pattern as `InventoryLayout`. Do not use in-page tab switchers or top-bar tabs for admin navigation.

- Each admin section gets its own `layouts/<section>-admin.tsx` (e.g. `flying-admin.tsx`, `inventory.tsx`)
- Pages live at `pages/admin/<section>/index.tsx`, `pages/admin/<section>/<subsection>.tsx`
- The layout handles auth gating via `useRequireAuth` at the page level, not the layout level
- Nav items use amber (`#d4a843`) as the primary accent color; subsection-specific accents (e.g. blue for videos) are fine within pages
- Mobile: horizontal scrollable tab bar pinned to top, `border-b border-darkBorder`
- Desktop: `w-48` sidebar, `border-r border-darkBorder`, section label in `font-mono uppercase tracking-widest`
- Use `@heroui/listbox` + `ListboxItem` for the sidebar nav items (matches inventory pattern)

---

## 10. Design system

- **Colors**: navy (`#1e2d4a` range), cream (`#f5f0e8` range), amber (`#d4a843` range)
- **Font**: serif headings, sans-serif body
- Tailwind classes in use — no custom CSS files; everything inline via Tailwind utility classes
- Amber is used for interactive/highlight elements (approach chip links, active states)
- Dark backgrounds (`bg-navy-*`) are standard for cards and overlays
