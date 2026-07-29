/**
 * import_electronics.mjs
 *
 * Bulk-imports ELECTRONICS inventory from a JSON file. Each entry is a pair
 * of objects:
 *
 *   {
 *     "inventoryItem":      { name, brand, description, category, datePurchased, vendor, url, currency, notes, active, ... },
 *     "inventoryElectronic":{ type, partNumber, packaging, quantity, valueText, voltageRating, currentRatingA, powerRatingW, tolerancePct, color }
 *   }
 *
 * For each pair we create the inventoryItem first, then the inventoryElectronic
 * row linked by itemId.
 *
 * Dedup: skips entries whose `name + vendor` already exists on an active item,
 * so you can re-run safely after a partial failure. Pass --force to disable.
 *
 * Prerequisites:
 *   npm install @aws-sdk/client-cognito-identity-provider
 *
 * Usage:
 *   node scripts/import_electronics.mjs --user=you@example.com --pass=yourpass
 *   node scripts/import_electronics.mjs --user=you@example.com --pass=yourpass --dry-run
 *   node scripts/import_electronics.mjs --user=you@example.com --pass=yourpass --file=scripts/data/mouser_inventory.json
 */

import { readFileSync } from "fs";
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { randomUUID } from "crypto";

// ── Args ──────────────────────────────────────────────────────────────────────

const argv     = process.argv.slice(2);
const DRY_RUN  = argv.includes("--dry-run");
const FORCE    = argv.includes("--force");
const userArg  = argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const passArg  = argv.find((a) => a.startsWith("--pass="))?.split("=")[1];
const fileArg  = argv.find((a) => a.startsWith("--file="))?.split("=")[1]
                 ?? "./scripts/data/mouser_inventory.json";
const DELAY_MS = 80;

if (!userArg || !passArg) {
  console.error("Usage: node scripts/import_electronics.mjs --user=you@example.com --pass=yourpass [--file=path] [--dry-run] [--force]");
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────

const outputs     = JSON.parse(readFileSync("./amplify_outputs.json", "utf8"));
const REGION      = outputs.auth.aws_region;
const CLIENT_ID   = outputs.auth.user_pool_client_id;
const APPSYNC_URL = outputs.data.url;

// ── Auth ──────────────────────────────────────────────────────────────────────

let JWT;

async function getJwt() {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const res = await cognito.send(new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
  }));
  if (!res.AuthenticationResult?.IdToken) {
    throw new Error("Auth failed. Challenge: " + res.ChallengeName);
  }
  return res.AuthenticationResult.IdToken;
}

// ── GraphQL ───────────────────────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const res = await fetch(APPSYNC_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": JWT },
    body:    JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

// Pull existing electronics items for the dedup pre-check. Pages through the
// full list because Amplify's default limit is 100 — silently ignoring later
// pages would let dupes through.
const LIST_ITEMS = `
  query ListItems($next: String) {
    listInventoryItems(filter: { category: { eq: ELECTRONICS } }, limit: 1000, nextToken: $next) {
      items   { id name vendor active }
      nextToken
    }
  }`;

async function fetchExistingSignatures() {
  const sigs = new Set();
  let next  = null;
  let page  = 0;
  do {
    const data = await gql(LIST_ITEMS, { next });
    page++;
    for (const it of data.listInventoryItems.items) {
      if (it.active === false) continue;
      const sig = `${(it.name ?? "").trim()}|${(it.vendor ?? "").trim()}`;
      sigs.add(sig);
    }
    next = data.listInventoryItems.nextToken;
  } while (next);
  console.log(`  fetched ${sigs.size} existing electronics signatures across ${page} page(s)`);
  return sigs;
}

const CREATE_ITEM = `
  mutation CreateItem($input: CreateInventoryItemInput!) {
    createInventoryItem(input: $input) { id }
  }`;

const CREATE_ELEC = `
  mutation CreateElec($input: CreateInventoryElectronicInput!) {
    createInventoryElectronic(input: $input) { id }
  }`;

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// AppSync rejects empty strings for nullable enum/scalar fields; normalise to null.
function clean(v) { return v === "" ? null : v; }

// Whitelist of fields we'll send to createInventoryItem. Anything outside this
// list (including unknown keys in the JSON) is dropped before the mutation.
const ITEM_FIELDS = [
  "name", "brand", "description", "category", "datePurchased", "vendor",
  "url", "pricePaid", "currency", "notes", "active",
];

const ELEC_FIELDS = [
  "type", "partNumber", "packaging", "quantity", "valueText",
  "voltageRating", "currentRatingA", "powerRatingW", "tolerancePct", "color",
];

const VALID_ELEC_TYPES = new Set([
  "RESISTOR", "CAPACITOR", "INDUCTOR", "DIODE", "LED", "TRANSISTOR",
  "IC", "MODULE", "BREADBOARD", "WIRE_CONNECTOR", "TOOL", "CONSUMABLE", "OTHER",
]);

function pickItem(raw) {
  const out = {};
  for (const k of ITEM_FIELDS) if (raw[k] !== undefined) out[k] = clean(raw[k]);
  // Enforce ELECTRONICS even if the JSON drops the field.
  out.category = "ELECTRONICS";
  // Default active=true if the source omits it.
  if (out.active == null) out.active = true;
  return out;
}

function pickElec(raw, itemId) {
  const out = { itemId };
  for (const k of ELEC_FIELDS) if (raw[k] !== undefined) out[k] = clean(raw[k]);
  // Coerce unknown enum values to OTHER so the mutation doesn't error out.
  if (!VALID_ELEC_TYPES.has(out.type)) {
    console.warn(`    ! unknown electronic type "${out.type}" — coercing to OTHER`);
    out.type = "OTHER";
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Electronics inventory importer${DRY_RUN ? " (DRY RUN)" : ""}`);
  console.log(`  source: ${fileArg}`);

  const raw = JSON.parse(readFileSync(fileArg, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error("Expected the JSON root to be an array of {inventoryItem, inventoryElectronic} pairs.");
  }
  console.log(`  parsed ${raw.length} entr${raw.length === 1 ? "y" : "ies"}`);

  if (!DRY_RUN) {
    process.stdout.write(`Authenticating as ${userArg}… `);
    JWT = await getJwt();
    console.log("✓");
  }

  let existing = new Set();
  if (!DRY_RUN && !FORCE) {
    process.stdout.write("Fetching existing electronics signatures for dedup… ");
    existing = await fetchExistingSignatures();
  }

  let inserted = 0, skipped = 0, errors = 0, dupes = 0;

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const item  = entry.inventoryItem;
    const elec  = entry.inventoryElectronic;
    const tag   = `[${i + 1}/${raw.length}]`;

    if (!item?.name) { console.warn(`${tag} skipping — missing inventoryItem.name`); skipped++; continue; }
    if (!elec?.type) { console.warn(`${tag} skipping "${item.name}" — missing inventoryElectronic.type`); skipped++; continue; }

    const sig = `${item.name.trim()}|${(item.vendor ?? "").trim()}`;
    if (!FORCE && existing.has(sig)) {
      console.log(`${tag} ✓ dedup "${item.name}" already present — skipping`);
      dupes++;
      continue;
    }

    const itemInput = { id: randomUUID(), ...pickItem(item) };

    if (DRY_RUN) {
      console.log(`${tag} [DRY] item ${itemInput.name} (${item.brand ?? "—"}) → elec ${elec.type} qty=${elec.quantity ?? "?"}`);
      inserted++;
      continue;
    }

    try {
      const itemRes = await gql(CREATE_ITEM, { input: itemInput });
      const itemId  = itemRes.createInventoryItem.id;
      const elecInput = { id: randomUUID(), ...pickElec(elec, itemId) };
      await gql(CREATE_ELEC, { input: elecInput });
      console.log(`${tag} ✓ ${item.name}`);
      existing.add(sig);
      inserted++;
    } catch (e) {
      console.error(`${tag} ✗ ${item.name}: ${e.message}`);
      errors++;
    }
    await sleep(DELAY_MS);
  }

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`  Inserted: ${inserted}  |  Dupes: ${dupes}  |  Skipped: ${skipped}  |  Errors: ${errors}`);
  if (DRY_RUN) console.log("  (Dry run — nothing was written to the database)");
}

main().catch((e) => { console.error(e); process.exit(1); });
