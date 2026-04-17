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

