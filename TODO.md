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

## Finance

### Statement import (PDF/CSV/XLS → transactions + balance sync)

Current CSV import (Chase, BofA, Amex, generic) works but is limited. Goal: upload *any*
statement in *any* common format, have Claude extract transactions, apply them to the
right account, and reconcile the account's current balance to the statement's ending
balance in one pass.

#### Inputs to support

| Format | Typical source | Difficulty |
|---|---|---|
| CSV  | Chase, BofA, Amex, Fidelity exports | Easy (done) |
| XLSX | Some banks, brokerages | Easy — SheetJS/xlsx skill handles it |
| PDF (text layer) | Most modern statements | Medium — pdf skill + Claude extraction |
| PDF (scanned/image) | Older or community bank statements | Hard — needs OCR |

#### Flow

1. User opens Finance → Transactions → **Import Statement** (expanded from today's "Import CSV")
2. Uploads a file; UI shows "Detecting format…"
3. Backend path:
   - CSV/XLSX → deterministic parser first; if headers don't match a known format,
     fall back to Claude extraction with the file contents
   - PDF → text extraction (via `pdf` skill); send text + prompt to Claude asking for
     a structured JSON response: `{ accountHint, statementPeriod, endingBalance,
     transactions: [{ date, description, amount, category? }] }`
4. Preview screen (reuse the existing import table UI):
   - Detected format + account hint (so we can auto-select the target account)
   - Statement period
   - **Ending balance** displayed prominently next to the account's *current* balance in
     our DB, with the delta highlighted
   - Transaction list with dup detection (existing `importHash` logic)
5. On confirm:
   - Insert selected transactions
   - Update `financeAccount.currentBalance` to match statement ending balance (not just
     summed deltas — the statement is authoritative)
   - Record an `importHash` set + a reconciliation audit note

#### Schema additions

Consider a new `financeStatementImport` model to keep an audit trail:
```ts
financeStatementImport: a.model({
  accountId:       a.id().required(),
  sourceFileName:  a.string(),
  s3Key:           a.string(),            // archive the original statement
  format:          a.string(),            // "chase-csv", "pdf-extracted", etc.
  statementStart:  a.date(),
  statementEnd:    a.date(),
  endingBalance:   a.float(),
  balanceBefore:   a.float(),             // account balance before reconcile
  balanceAfter:    a.float(),             // after reconcile
  transactionCount: a.integer(),
  importedAt:      a.datetime(),
})
```

#### Open questions

- **Where does extraction run?** Simplest: client-side for CSV/XLSX, API call to Claude
  for PDFs. Alternative: Lambda with the pdf skill + Claude SDK. API-in-artifact pattern
  (Claude API from the browser) works and keeps it serverless but sends the whole
  statement to the client.
- **Scanned PDFs**: punt for v1. Detect when text extraction yields < N tokens and tell
  the user "this looks like a scanned statement, OCR isn't supported yet."
- **Balance-vs-sum mismatch**: if applying the extracted transactions to the previous
  balance doesn't equal the stated ending balance, warn the user — probably means some
  transactions were missed or duplicated. Let them proceed or abort.
- **Pending vs posted**: statements only show posted transactions. Our DB might have
  `PENDING` rows for the same underlying charges. Reconcile by promoting matched
  `PENDING` → `POSTED` instead of creating duplicates.

#### Build order

1. XLSX support in the existing import flow (easy win, uses SheetJS already in artifacts skill)
2. PDF text extraction path — single-step: extract text, send to Claude API, structured JSON out
3. Account auto-selection from extracted account hint (last 4 digits, account name)
4. Balance reconciliation step (the actually-new behavior vs today)
5. `financeStatementImport` audit model + history page
6. OCR fallback (last priority — most users have text-layer PDFs)

### Auto-allocation of account balances to savings goals

Today: `financeSavingsGoal.currentAmount` is maintained manually — user edits it or
tags transactions with `goalId`. Painful and out of sync with reality.

Goal: user maps specific accounts to specific goals (many-to-many), with per-mapping
priority to resolve shared accounts. The system derives how much of each account's
balance flows to each goal. `currentAmount` becomes a *computed view* rather than a
stored value. Surplus (balance beyond a goal's target) stays visible as a signal, not
absorbed silently.

#### Mental model

- An account funds a goal **if and only if** there's a mapping row between them
- No global "eligibility" flag — the mapping itself is the eligibility
- One account can fund many goals; one goal can be funded by many accounts (N:N)
- When an account funds multiple goals, per-mapping priority determines fill order
- Goals cap at their `targetAmount` — surplus stays as unallocated cash on the account
  and is displayed to the user as a nudge (move it, or map it to another goal)

#### Schema changes

**New model** `financeGoalFundingSource`:
```ts
financeGoalFundingSource: a.model({
  goalId:    a.id().required(),
  accountId: a.id().required(),
  priority:  a.integer().default(100),  // lower = funded first FROM THIS ACCOUNT
}).secondaryIndexes((index) => [index("accountId"), index("goalId")])
```

**`financeSavingsGoal`** — `currentAmount` stays in the schema for migration safety,
but transitions from source-of-truth to last-computed cache. UI stops writing to it
directly. Eventually deprecate or repurpose as "manual override" for goals funded
outside the system (e.g. a 529 not tracked in the app).

**`financeAccount`** — no changes. Eligibility is implicit in the mapping table.

#### Allocation algorithm

Per-account iteration, priority-ordered, goals cap at target:

```
for each account with any funding mappings:
  remaining = account.currentBalance
  mappings  = sources where accountId = account.id, sorted by priority asc
  for mapping in mappings:
    goal        = goals[mapping.goalId]
    still_needed = max(0, goal.targetAmount - goal.allocated_so_far)
    take        = min(remaining, still_needed)
    goal.allocated_so_far += take
    remaining   -= take
  account.surplus = remaining  // shown as unallocated cash on this account
```

Key properties:
- Exclusive accounts (HYSA → emergency fund only): goal gets `min(balance, target)`,
  anything extra displays as surplus on the account
- Shared accounts (checking funds house@1 and vacation@2): checking fills house first
  up to its target, remainder goes to vacation, then surplus
- Goal funded by multiple accounts: contributions sum across accounts until target hit

**Tiebreaker**: if two mappings share an account *and* the same priority, iterate in
stable order (mapping creation time). This only matters when the combined pool
under-funds both goals; when it over-funds, order doesn't affect the outcome since
both hit their targets.

Implement as a pure function `computeGoalAllocations(accounts, goals, mappings)` in
`_shared.tsx`. Returns `{ goalAllocations: Map<goalId, number>, accountSurplus:
Map<accountId, number> }`. Easy to unit-test; no side effects.

#### UI changes

**Account edit panel** — new section "Funds these goals":
- Shows the current mapped goals as a ranked list
- Drag-to-reorder sets priority
- "+ Add goal" picker shows unmapped goals
- Remove button per row

**Goal edit panel** — new section "Funded by these accounts":
- Shows the mapped accounts (informational; priority lives on the account side)
- "+ Add account" picker; when adding an account already mapped to other goals,
  show the existing priority list with a "where should this goal slot in?" UI

**Goals page**:
- Each goal card shows `allocated` (computed from algorithm) instead of editable currentAmount
- Progress bar = `allocated / targetAmount`
- Remove the manual `currentAmount` input from the form (or hide behind a "Manual override"
  toggle for goals funded outside the app)
- Complete badge when `allocated >= target` works as today

**Accounts / Transactions page**:
- Account chips/cards get a surplus badge when `surplus > 0`: e.g. "HYSA · $20,000 ·
  $5,000 unallocated" in a subdued color
- Clicking the surplus badge could offer "Map to a goal" as a shortcut

**Dashboard**:
- Savings Goals section reads `allocated` instead of `currentAmount`
- New summary line: "Unallocated cash: $X across Y accounts" — links to a detail
  view listing which accounts hold surplus

#### Migration

1. Deploy schema with the new `financeGoalFundingSource` model; no existing records affected
2. Leave `currentAmount` populated so the dashboard doesn't go blank before mappings exist
3. One-time onboarding banner on Goals page: "Map accounts to your goals to enable
   auto-allocation" with a CTA to the mapping UI
4. Once a goal has at least one mapping, UI switches to computed `allocated` for that
   goal; goals with no mappings fall back to stored `currentAmount` (transitional)
5. Eventually: drop `currentAmount` writes entirely; keep read as manual-override fallback

#### Open questions

- **Credit card accounts**: should never be mapped to a goal (negative balances would
  subtract from the goal's funding). Enforce in the mapping UI: only non-CREDIT account
  types appear in the account picker
- **Brokerage accounts**: technically liquid but volatile. Allow mapping, but consider a
  "volatile" flag on the account type so the UI can show allocations as approximate
- **Over-funded goals**: if `allocated > target` somehow (shouldn't happen with the cap,
  but defensive): display as 100% complete, log a warning. Should never surface
- **Deleting an account or goal**: cascade-delete the mapping rows. Straightforward
- **Deactivated accounts** (`active: false`): skip in the algorithm. Their mappings stay
  in case they're reactivated
- **Goal-tagged transactions**: still allowed via `goalId` on transactions, but purely
  informational ("this transfer was earmarked for the house fund") — the ledger for
  goal progress is derived, not summed from transactions
- **Allocation visible on the account side**: when showing an account, do we list how
  much of its balance is allocated to each goal, or just the total surplus? Probably
  both — an expandable breakdown. Nice-to-have, not v1

#### Build order

1. Schema: add `financeGoalFundingSource` model with GSIs on `accountId` and `goalId`
2. Pure allocation function `computeGoalAllocations(accounts, goals, mappings)` in `_shared.tsx`
3. Mapping CRUD UI: account edit panel "Funds these goals" section with priority reorder
4. Goal edit panel "Funded by these accounts" informational list
5. Goals page: switch progress math from stored `currentAmount` to computed `allocated`
6. Dashboard: switch to computed allocations + unallocated cash summary
7. Surplus badge on account chips in Transactions page
8. Deprecate `currentAmount` writes (keep read path for manual-override mode)

### Brokerage holdings & live prices

`financeAccount.currentBalance` is a flat scalar, which doesn't fit brokerage
accounts. A brokerage's total value = cash balance + Σ(lots × current price). Holdings
need their own model with per-lot tracking and live prices.

#### Status

**✅ v1 complete** (schema + shared helpers + quotes API + account detail UI + dashboard):
- Per-lot model `financeHoldingLot` deployed
- Separate `financeTickerQuote` model (PK=ticker) for price cache
- `yahoo-finance2` ^3.14.0 integrated via `/api/quotes` server route
- Account detail page `/finance/accounts/[id].tsx` with holdings table grouped by ticker,
  expandable lot rows, add/edit/delete lot flow, and global "Refresh prices" button
- Dashboard account cards link to `/finance/accounts/{id}` and show cash + positions
  breakdown for brokerage; net worth uses `accountTotalValue` including positions

**⏳ Pending**:
- Statement/positions CSV import for lots (Schwab)
- Cron-based price refresh (Lambda + EventBridge)
- BUY/SELL transaction flow (compound cash + lot adjustment in one action)
- Retirement accounts as a new account type (see separate section below)

#### Mental model

- For brokerage accounts, `currentBalance` means **cash only** (uninvested money)
- Each purchase of a ticker creates one `financeHoldingLot` record (accountId, ticker,
  quantity, optional costBasis, optional purchaseDate)
- `financeTickerQuote` has one row per distinct ticker (PK = ticker) holding
  `price`, `currency`, `fetchedAt`, `source`
- Total account value = cash + Σ(lot.quantity × tickerQuote.price)
- Net worth uses total account value (cash + positions), not just cash

#### Schema (as-built)

```ts
financeHoldingLot: a.model({
  accountId:    a.id().required(),
  ticker:       a.string().required(),
  assetType:    a.enum(["STOCK", "ETF", "MUTUAL_FUND", "CRYPTO", "BOND", "OTHER"]),
  quantity:     a.float().required(),
  costBasis:    a.float(),      // total $ paid for THIS lot (optional)
  purchaseDate: a.date(),       // optional, distinguishes lots
  notes:        a.string(),
}).secondaryIndexes((index) => [index("accountId"), index("ticker")])

financeTickerQuote: a.model({
  ticker:    a.string().required(),
  price:     a.float(),
  currency:  a.string(),
  fetchedAt: a.datetime(),
  source:    a.string(),
}).identifier(["ticker"])
```

#### Key helpers in `components/finance/_shared.tsx`

- `buildQuoteMap(quotes)` — `Map<ticker, TickerQuoteRecord>` for O(1) lookup
- `tickerAggregate(ticker, lots, quotes)` — `{ totalQty, totalCost, price, marketValue,
  gainLoss, gainLossPct, lots, fetchedAt }`. `totalCost` is null if any lot missing cost
  basis (so aggregate gain/loss goes null too — honest handling of partial data)
- `uniqueTickers(lots)` — distinct uppercase tickers
- `accountTotalValue(acc, lots, quotes)` — cash + Σ(lot qty × quote price) for
  brokerage/retirement; just cash otherwise. Lots without quotes contribute 0
- `isQuoteStale(q, hours=24)`

#### Price feeds (Yahoo Finance)

Unofficial but reliable, free, works for stocks/ETFs/mutual funds (including Schwab funds
like SWPPX, SWISX). Uses `yahoo-finance2` ^3.14.0 via `new YahooFinance()`.

v1 (done): manual "Refresh prices" button on the account detail page. Global refresh —
fetches all tickers across all brokerage accounts in one batched API call, upserts each
ticker's quote row.
v2: Lambda + EventBridge cron, every 15 min during market hours, once daily on weekends.

#### Pending follow-ons

**Schwab CSV import for lots**
- Schwab's positions CSV is aggregated (one row per ticker with average cost basis) —
  doesn't give per-lot data. Needs transactions CSV instead for true lot tracking.
- For v2: import flow reads Schwab transactions CSV, creates one lot per BUY action,
  collapses DIVIDEND/REINVEST into new lots or separate income transactions.

**BUY/SELL transaction flow (v3)**
- New transaction types `BUY` / `SELL` that atomically adjust cash + lot in one action
- Realized gain/loss on SELL using FIFO or average cost basis (user pref)
- Dividends/interest as regular income transactions to the cash side

**Cron price refresh**
- Lambda + EventBridge, every 15 min during market hours, once daily weekends
- Upserts `financeTickerQuote` rows for all held tickers. Independent of UI

**Race condition in refresh upsert** (minor)
- Current pattern: `update`-then-catch-fallback-`create`. If two refreshes fire
  simultaneously, both could fail update + both try create. Rare; not worth solving
  until it bites

**Account filter chip on Transactions page**
- Currently opens the account edit panel. Should probably link to
  `/finance/accounts/{id}` now that the detail page exists

#### Open questions (still relevant)

- **FX**: non-USD tickers need FX rates. Punt — all USD for now
- **Options/complex instruments**: out of scope. `quantity` is float but assumed
  shares, not contracts
- **Dividends/reinvestment**: v1 treats as manual quantity bumps + income tx. v3
  automates
- **Stale price handling**: > 24h flagged on account page; no special styling yet
  for > 1 week. Could improve
- **Holdings on savings/checking**: UI only shows the holdings section for BROKERAGE
  and (future) RETIREMENT types. Schema doesn't enforce — integrity is UI-only

### Retirement accounts (401k, IRA, etc.)

Retirement accounts are structurally identical to brokerage accounts — cash + holdings,
value moves with market prices. Reuse the brokerage infrastructure with a new account
type so retirement balances contribute to net worth without duplicating code.

#### Mental model

- A 401k, IRA, Roth IRA, HSA, etc. is a brokerage account with a different tax wrapper
- Same lot model, same quote system, same refresh flow, same detail UI
- The only new thing is an account type tag and (optional) a retirement-subtype field
- Cash balance usually 0 in practice (401k providers auto-invest contributions) but
  the field remains for completeness

#### Schema changes

**Add `RETIREMENT` to `ACCOUNT_TYPES`** enum in `_shared.tsx` and the amplify schema.

**Optional**: add a `retirementType` field to `financeAccount`:
```ts
retirementType: a.enum(["401K", "TRAD_IRA", "ROTH_IRA", "HSA", "SEP_IRA", "OTHER"])
```
Purely informational — drives labels on the account card, not math. Nullable; only
populated for RETIREMENT-type accounts.

#### UI changes

- Account badge gets a "Retirement" label with the same emerald styling
- Account detail page shows the same holdings section for RETIREMENT as for BROKERAGE
  (extend the existing `isBrokerage` check to `isBrokerageOrRetirement`)
- `accountTotalValue(...)` includes RETIREMENT in the cash+positions branch
- Dashboard card shows cash + positions breakdown for RETIREMENT same as brokerage
- If `retirementType` is set, append it to the badge: "Retirement · 401K"

#### Net worth math

Retirement accounts contribute their full value (cash + positions) to net worth.
The money is yours; it's just locked until retirement age. Don't discount for taxes —
the app tracks pre-tax balances because that's what the provider shows.

#### Open questions

- **Employer match tracking**: could live as a separate lot with `notes: "employer
  match"`, or ignored entirely. Start by ignoring; revisit if tracking vesting matters
- **Vested vs unvested**: if vesting schedules become important, add a
  `vestedPercent` field to lots and a `vestingDate`. Out of scope for v1
- **Contribution limits / year-to-date contributed**: not net-worth-relevant, belongs
  in a tax-planning view if ever built. Skip
- **Rollovers** (401k → IRA): handled as a TRANSFER between two RETIREMENT accounts.
  Existing transfer logic works since both are accounts. The lots themselves would
  need to be moved/recreated — manual step for now

#### Build order

1. Add `RETIREMENT` to `ACCOUNT_TYPES` in `_shared.tsx` and schema
2. Add `retirementType` field to `financeAccount` model (nullable enum)
3. Update `accountTotalValue(...)` branch to include RETIREMENT
4. Update account detail page to show holdings section for RETIREMENT
5. Update dashboard card rendering (cash + positions for RETIREMENT too)
6. Update `ACCOUNT_TYPE_LABELS` and badge display
7. Add `retirementType` dropdown on the account edit form (only shown when type=RETIREMENT)

### Assets (house, car, collectibles)

Non-financial holdings whose value depends on appraisal/market, not transactions.
Contribute to net worth; don't have a ledger. Purely a scalar that the user updates
manually (v1; future: Zestimate API, KBB, etc.).

#### Mental model

- An asset has a name, type, purchase value, current value, and optionally a link to
  an active loan that finances it
- Net worth sums `currentValue` across active assets (loans subtract separately — see
  Loans section below)
- Assets do NOT contribute to savings-goal allocation. They're illiquid and shouldn't
  absorb cash intended for emergency funds etc.

#### Schema

```ts
financeAsset: a.model({
  name:          a.string().required(),     // "Primary home", "2019 Honda Civic"
  type:          a.enum(["REAL_ESTATE", "VEHICLE", "COLLECTIBLE", "OTHER"]),
  purchaseValue: a.float(),                   // original cost (optional)
  currentValue:  a.float().required(),        // current estimated value
  purchaseDate:  a.date(),                    // optional
  notes:         a.string(),                  // "appraised 2024-03", "VIN: xxxx"
  active:        a.boolean().default(true),   // sold/disposed = inactive
})
```

No GSIs needed — the table will stay small (realistically < 20 rows).

#### UI changes

**New "Assets" tab** in the finance layout sidebar, between Goals and (future) Loans.

**`/finance/assets` page**:
- Grid of asset cards: name, type badge, current value, gain/loss since purchase
  (when purchase value known), linked loan (when present) with equity calculation
- Add/edit/delete flow similar to accounts
- For an asset linked to a loan: show `currentValue − loanBalance = equity`

**Dashboard**:
- New "Assets" section below or next to account cards, showing total asset value and
  individual cards with current value. Collapsible if many assets
- Net worth formula updates to include `Σ active_assets.currentValue`

**`fetchAll` in dashboard** needs to pull `financeAsset` records.

#### Helpers

```ts
// Total value of active assets
totalAssetValue(assets: AssetRecord[]): number

// Equity on an asset given linked loans
assetEquity(asset: AssetRecord, loans: LoanRecord[]): number
  // = asset.currentValue + Σ(loans where assetId = asset.id && active).currentBalance
  // (loans stored with negative currentBalance, so + works)
```

#### Net worth formula update

```
netWorth =
    Σ accounts.totalValue (existing calc, covers brokerage/retirement lots)
  + Σ active_assets.currentValue
  + Σ active_loans.currentBalance     // already negative, so effectively subtracted
```

Credit cards remain negative `financeAccount` balances. Loans are separate.

#### Open questions

- **Depreciation of vehicles**: no automation. User updates `currentValue` manually
  when they feel like it. Could later wire up KBB/Edmunds API for VIN-based estimates
- **Real estate**: Zillow Zestimate has a public API but TOS is sketchy. Manual for v1
- **Collectibles tracked in inventory**: separate system (`inventoryItem` etc.). Don't
  merge — those have sale prices, not appraised value. If a guitar becomes valuable
  enough to matter for net worth (> $5k), add it as a standalone asset; otherwise it
  stays in inventory only
- **Multiple owners**: out of scope. If the house is jointly owned with Cris, record
  the full value and handle the split externally
- **Asset not contributing to net worth**: a boolean `includeInNetWorth` flag? Skip
  for v1 — `active: false` covers the "sold" case, which is the common one

#### Build order

1. Schema: add `financeAsset` model
2. Shared types + helpers: `AssetRecord`, `totalAssetValue`, `assetEquity` (stub
  until loans land)
3. Assets page `/finance/assets` with CRUD
4. Finance layout: add "Assets" nav item
5. Dashboard: fetch assets, show section, include in net worth
6. Linked loan display (after loans land)

### Loans (mortgage, auto, student)

Loans need more structure than accounts because a payment splits into principal /
interest / escrow — a single ledger transaction can't express this. Hybrid approach:
a loan is backed by a `financeAccount` (type LOAN) for ledger integration, plus a
separate `financeLoan` record for structured metadata and payment breakdowns.

**Key insight from Gennaro's existing tracking spreadsheet**: real payments are highly
irregular. Total payment amounts vary month-to-month ($1,745 → $2,000 → $1,800 → $1,300
→ $1,250 → $1,800 → $2,000...) with ad-hoc extra principal contributions. The bank
reports the actual principal/interest split per payment; we should NOT try to
auto-compute it from theoretical amortization. Users enter what the bank tells them.

#### Mental model

- Every loan has:
  - A `financeAccount` with `type: LOAN` and `currentBalance` (negative = owed)
  - A `financeLoan` record with structured metadata (rate, term, original amount,
    linked asset) referencing the account via `accountId`
- A payment generates three linked records:
  - EXPENSE transaction on the paying account (e.g. checking) for `totalAmount`
  - INCOME transaction on the loan account for `principalAmount` (positive, since it
    moves balance toward zero)
  - `financeLoanPayment` record linking the two and carrying interest/escrow breakdown
- Interest is neither lost nor double-counted: it's the delta between the two
  transactions, captured as metadata on the payment record. Year-to-date interest for
  tax prep = `Σ loan_payments.interestAmount filtered by year`
- Loan balance is derived from `originalAmount − Σ payments.principalAmount`, cached
  on the loan as `currentBalance` for cheap reads, recomputed on every payment
  insert/edit/delete. A "Reconcile" button recomputes from scratch if it ever drifts

#### Schema

**New `LOAN` account type**:
```ts
// In ACCOUNT_TYPES and financeAccount.type enum
"LOAN"
```

**New `financeLoan` model**:
```ts
financeLoan: a.model({
  name:           a.string().required(),        // "Primary mortgage", "Civic auto loan"
  type:           a.enum(["MORTGAGE", "AUTO", "STUDENT", "PERSONAL", "HELOC", "OTHER"]),
  accountId:      a.id().required(),             // FK → financeAccount.id (type=LOAN)
  originalAmount: a.float().required(),          // positive; what was borrowed
  currentBalance: a.float().required(),          // cached: originalAmount − Σ principal paid
  interestRate:   a.float(),                     // annual APR, decimal (0.0675). Informational
  termMonths:     a.integer(),                   // informational (for reference amortization)
  startDate:      a.date(),
  assetId:        a.id(),                        // FK → financeAsset.id (optional)
  notes:          a.string(),
  active:         a.boolean().default(true),
}).secondaryIndexes((index) => [index("accountId"), index("assetId")])
```

Notes:
- `monthlyPayment` dropped — real payments vary too much to be a stable field. For
  display ("Typical payment: $2,000"), compute as median of last N payments or show
  the last payment amount
- `interestRate` and `termMonths` remain for informational display and for the
  **reference amortization** feature ("if you'd paid the minimum, you'd be at $X
  balance today" vs actual)
- `currentBalance` is a cached derived value, not an independent source of truth.
  Store it for O(1) reads from dashboard; recompute on write

**New `financeLoanPayment` model**:
```ts
financeLoanPayment: a.model({
  loanId:          a.id().required(),
  date:            a.date().required(),
  totalAmount:     a.float().required(),         // what came out of checking (positive)
  principalAmount: a.float().required(),         // reduced the loan balance (from bank statement)
  interestAmount:  a.float().required(),         // informational (from bank statement)
  escrowAmount:    a.float(),                    // optional (mortgage: taxes + insurance)
  fromAccountId:   a.id().required(),            // FK → financeAccount.id (paying account)
  expenseTxId:     a.id(),                       // FK → financeTransaction.id (checking side)
  loanTxId:        a.id(),                       // FK → financeTransaction.id (loan side)
  notes:           a.string(),
}).secondaryIndexes((index) => [index("loanId"), index("date")])
```

The `expenseTxId` / `loanTxId` FKs let us navigate between views (click a loan payment
→ see the two ledger transactions) and let payment deletion cascade-delete both
transactions.

#### Payment flow

**Recording a payment** (new panel on loan detail page):
1. User enters all fields manually from their bank statement:
   - Date, paying account
   - Total amount
   - Principal amount (from statement)
   - Interest amount (from statement)
   - Escrow amount (optional, mortgage only)
2. Validation: `principal + interest + (escrow ≓ 0) ≈ total`. If the check fails by
   more than $1, warn the user ("These don't add up — check your statement"). Allow
   proceeding anyway — rounding errors and fees occasionally cause minor drift
3. On save:
   - Create EXPENSE transaction on `fromAccountId` for `-totalAmount`
     (description: "Loan payment: {loan.name}", category: "Loan")
   - Create INCOME transaction on `loan.accountId` for `+principalAmount`
     (description: "Principal: {loan.name}", category: "Loan")
   - Create `financeLoanPayment` with both tx IDs
   - Update `loan.currentBalance -= principalAmount`
   - Update `loan.accountId` account's `currentBalance` to match (both sides of the
     ledger move)
4. If the transactions or payment record fails to create, roll back the others
   (client-side orchestration). AWS doesn't give us real transactions across models;
   best we can do is "try-all-then-cleanup" — acceptable for a personal app

**No auto-computed principal/interest split.** The bank's split is authoritative and
varies based on actual balance, fees, date of payment. Any schedule we compute will
be wrong most months. Don't pretend.

**Recurring payment support** — optional, integrates with existing `financeRecurring`:
- User can mark a loan payment recurring for the "typical" amount, but recurring only
  creates the EXPENSE side (from checking). When the bank statement arrives, user
  edits the auto-posted transaction into a proper loan payment with the real split.
- Alternatively, skip recurring for loans entirely — user manually records each
  payment when the statement arrives. Simpler and aligns with the "bank tells us the
  split" principle

#### CSV import for payment history

Critical for v1 because Gennaro has 40+ rows of existing payment history in a
spreadsheet. Without import, loan rollout means hours of manual data entry.

**Import flow**:
- On loan detail page: "Import payment history" button
- CSV expected columns (case-insensitive, flexible header matching):
  `date, payment | total, principal, interest, escrow (optional)`
- Preview table shows parsed rows with any validation warnings
- On confirm: create one `financeLoanPayment` per row, PLUS the two linked ledger
  transactions per row (same as manual entry)
- Dedup: hash(loanId + date + totalAmount) as `importHash` on the payment record.
  Re-importing the same CSV is a no-op
- Recompute `loan.currentBalance` and `loan.accountId` balance at the end as
  `originalAmount − Σ principal` (don't trust row-by-row drift)

**Important**: historical imports may predate the checking account's existence in
this system. Let the user pick a paying account, or create a special "Historical"
account for payments made before migration. Transactions on the Historical account
don't affect net worth (mark it inactive or filter it out).

#### Reference amortization view

Motivating display: "If you'd paid the minimum only, you'd owe $X today. You actually
owe $Y. You've saved $Z in interest by paying extra."

Pure computed function `referenceAmortization(loan)` in `_shared.tsx`:
```ts
// Given originalAmount, interestRate, termMonths, startDate, produces:
// [{ installmentNumber, scheduledDate, scheduledPayment, scheduledPrincipal,
//    scheduledInterest, scheduledBalance }]
// Stops at termMonths or when balance hits 0
```

On loan detail page, side-by-side comparison:
- Actual (from `financeLoanPayment` records): current balance, payments made,
  interest paid to date
- Reference (from `referenceAmortization`): what the balance would be if paying
  minimum since `startDate`
- Delta: principal ahead of schedule, interest saved

If `interestRate` or `termMonths` is null, skip the reference view — can't compute

#### UI changes

**New "Loans" tab** in the finance sidebar.

**`/finance/loans` page**:
- List of loan cards: name, type badge, current balance, rate, last payment amount,
  linked asset (when present), progress bar (principal paid / original)
- Quick "Record payment" button per loan
- Add/edit/delete loan flow

**`/finance/loans/[id]` page** (detail):
- Header: current balance, original amount, rate, term, payoff date projection
  (based on current payment rate)
- Reference amortization comparison (if rate + term are set)
- Payment history: all `financeLoanPayment` records, newest first, with:
  - Date, total, principal, interest, escrow (if any)
  - Running balance column (computed left-to-right from oldest to newest, not stored)
  - YTD interest total at the top (current calendar year)
- Record new payment button
- Import payment history button

**Account detail for LOAN accounts** (`/finance/accounts/[id]` already exists):
- Shows ledger transactions as usual. Works out of the box
- Add a "This is a loan" card at the top with summary metadata if a `financeLoan`
  points to this account. Click-through to `/finance/loans/[id]`

**Dashboard**:
- New "Loans" section (or combined "Debts" with credit cards?) showing total debt,
  principal paid this year, YTD interest, upcoming payment dates if using recurring
- Net worth formula already handles this since loan accounts have negative balances

**Assets page**:
- Asset cards linked to a loan show equity: `currentValue + loanBalance = equity`
  (loan balance already negative)

#### Net worth formula (final)

```
netWorth =
    Σ active_accounts.totalValue   // includes LOAN accounts (negative)
  + Σ active_assets.currentValue
```

No separate loan subtraction needed — LOAN accounts carry negative balances and are
already summed in the first term. Clean.

#### Open questions

- **Split mismatch > $1**: warn, don't block. Rounding errors are real; let the user
  proceed with a note. Track in a "split discrepancy" counter on the loan if we
  want to flag persistent issues
- **Extra principal payments**: naturally supported — user just enters a principal
  amount larger than typical for that month. No special UI needed
- **Fixed vs variable rate**: `interestRate` is a single float. For variable rate
  loans, user updates it when it changes. Don't track rate history for v1. Reference
  amortization only accurate for fixed-rate loans; note this in UI
- **Rate changes on variable loans**: the reference amortization would need to
  recompute. Skip — variable rate users won't rely on the reference view
- **Prepaid interest / points at closing**: out of scope — those happen before v1
  starts tracking, user just enters the post-closing balance as `originalAmount`
- **Loans without an account?**: could model as a loan without an accountId, pure
  metadata. Not worth the complexity — every loan gets a LOAN-type account
- **Credit cards vs loans**: credit cards stay as CREDIT accounts with no
  `financeLoan` backing record. Structurally similar (revolving debt) but categorically
  different — no fixed term, no amortization, balance fluctuates with spending
- **Deleting a loan**: should we delete the backing account too? Propose a confirmation:
  "Delete loan + close the linked account? The account has N transactions." Soft-delete
  both (set active=false) is safer than hard delete
- **Asset / loan 1:N**: one asset could have multiple loans (HELOC + mortgage on same
  house). `financeLoan.assetId` is a FK, so many loans → one asset works naturally.
  Equity calc sums all loans for that asset
- **Loan payoff**: when `currentBalance` hits 0, suggest marking `active: false`. Don't
  auto-inactivate — user might want to keep a $0-balance loan visible briefly
- **Balance drift**: cached `currentBalance` can drift from Σ payments if bugs creep
  in. Add a "Reconcile" button that recomputes from `originalAmount − Σ principal`
  and updates both the loan and its linked account

#### Build order

1. Schema: add `LOAN` to ACCOUNT_TYPES, add `financeLoan` and `financeLoanPayment` models
2. Shared helpers: `totalLoanBalance`, `assetEquity` (update to use real loan data),
   `referenceAmortization(loan)` pure function
3. Loans page `/finance/loans` with CRUD
4. Loan detail page `/finance/loans/[id]` with payment history + YTD interest + running balance
5. Record payment flow: user enters all amounts manually, two transactions + loan
   payment record orchestrated client-side, split validation warning
6. **CSV import for payment history** (critical to onboard existing spreadsheet data)
7. Reference amortization comparison view (principal ahead, interest saved)
8. Loan-linked asset display on Assets page (equity calc)
9. "This is a loan" summary card on LOAN-type account detail page
10. Reconcile button (recompute balance from Σ payments)
11. Recurring payment integration (optional — may skip in favor of manual entry)


