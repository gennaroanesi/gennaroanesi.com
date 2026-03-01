/**
 * import_inventory.mjs
 * Reads inventory_import.xlsx and seeds the Gennaro A database.
 *
 * Prerequisites:
 *   npm install xlsx @aws-sdk/client-cognito-identity-provider
 *
 * Usage:
 *   node import_inventory.mjs --user=you@example.com --pass=yourpassword [--dry-run] [--sheet=Ammo]
 */

import { readFileSync } from "fs";
import { read as xlsxRead, utils as xlsxUtils } from "xlsx";
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { randomUUID } from "crypto";

// ── Config ────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const sheetArg = process.argv
  .find((a) => a.startsWith("--sheet="))
  ?.split("=")[1];
const userArg = process.argv
  .find((a) => a.startsWith("--user="))
  ?.split("=")[1];
const passArg = process.argv
  .find((a) => a.startsWith("--pass="))
  ?.split("=")[1];
const DELAY_MS = 120;

if (!userArg || !passArg) {
  console.error(
    "Usage: node import_inventory.mjs --user=you@example.com --pass=yourpassword [--dry-run] [--sheet=Ammo]",
  );
  process.exit(1);
}

const REGION = "us-east-1";
const CLIENT_ID = "2cra2mdgp22rh7813g3aq26k20";
const APPSYNC_URL =
  "https://cdglsrrdm5fhrnu6wge6533jyy.appsync-api.us-east-1.amazonaws.com/graphql";

// ── Auth: get JWT from Cognito directly via AWS SDK ───────────────────────────

async function getJwt() {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const cmd = new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
  });
  const res = await cognito.send(cmd);
  if (!res.AuthenticationResult?.IdToken) {
    throw new Error(
      "Auth failed — check username/password. Challenge: " + res.ChallengeName,
    );
  }
  return res.AuthenticationResult.IdToken;
}

// ── GraphQL client using raw fetch + JWT header ───────────────────────────────

let JWT;

async function gql(query, variables = {}) {
  const res = await fetch(APPSYNC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: JWT,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

const CREATE_ITEM = `
  mutation CreateItem($input: CreateinventoryItemInput!) {
    createinventoryItem(input: $input) { id }
  }`;

const CREATE_FIREARM = `
  mutation CreateFirearm($input: CreateinventoryFirearmInput!) {
    createinventoryFirearm(input: $input) { id }
  }`;

const CREATE_AMMO = `
  mutation CreateAmmo($input: CreateinventoryAmmoInput!) {
    createinventoryAmmo(input: $input) { id }
  }`;

const CREATE_FILAMENT = `
  mutation CreateFilament($input: CreateinventoryFilamentInput!) {
    createinventoryFilament(input: $input) { id }
  }`;

const CREATE_INSTRUMENT = `
  mutation CreateInstrument($input: CreateinventoryInstrumentInput!) {
    createinventoryInstrument(input: $input) { id }
  }`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function str(v) {
  return v != null && String(v).trim() !== "" ? String(v).trim() : null;
}
function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}
function int(v) {
  const n = parseInt(v);
  return isNaN(n) ? null : n;
}
function date(v) {
  if (!v) return null;
  if (typeof v === "number") {
    const d = xlsxUtils.format_cell({ t: "d", v });
    return d ? d.slice(0, 10) : null;
  }
  const s = String(v).trim();
  return s.match(/^\d{4}-\d{2}-\d{2}$/) ? s : null;
}
function currency(v) {
  const valid = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF", "MXN", "BRL"];
  const s = str(v);
  return s && valid.includes(s.toUpperCase()) ? s.toUpperCase() : "USD";
}
function readSheet(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) {
    console.warn(`  Sheet "${name}" not found — skipping.`);
    return [];
  }
  return xlsxUtils.sheet_to_json(ws, { defval: null });
}

let inserted = 0,
  skipped = 0,
  errors = 0;

async function createItem(input) {
  if (DRY_RUN) {
    console.log("  [DRY] item:", input.name, "|", input.category);
    inserted++;
    return `dry-${Date.now()}`;
  }
  try {
    const data = await gql(CREATE_ITEM, {
      input: { id: randomUUID(), ...input },
    });
    inserted++;
    return data.createinventoryItem.id;
  } catch (e) {
    console.error("  ✗ item error:", e.message);
    errors++;
    return null;
  }
}

// ── Firearms ──────────────────────────────────────────────────────────────────

async function importFirearms(wb) {
  console.log(
    "\n── Firearms ─────────────────────────────────────────────────────",
  );
  for (const r of readSheet(wb, "Firearms")) {
    const name = str(r["Name *"]);
    if (!name) {
      skipped++;
      continue;
    }
    const id = await createItem({
      name,
      brand: str(r["Brand"]),
      category: "FIREARM",
      datePurchased:
        date(r["Date Purchased\n(YYYY-MM-DD)"]) ?? date(r["Date Purchased"]),
      vendor: str(r["Vendor"]),
      pricePaid: num(r["Total Paid"]),
      currency: currency(r["Currency"]),
      description: str(r["Description"]),
      notes: str(r["Notes"]),
    });
    if (!id) continue;
    const input = {
      id: randomUUID(),
      itemId: id,
      type: str(r["Type *"]) ?? "OTHER",
      caliber: str(r["Caliber"]),
      serialNumber: str(r["Serial #"]),
      action: str(r["Action"]),
      barrelLength: str(r["Barrel Length"]),
      finish: str(r["Finish"]),
    };
    if (DRY_RUN) {
      console.log("  [DRY] firearm:", input);
      await sleep(DELAY_MS);
      continue;
    }
    try {
      await gql(CREATE_FIREARM, { input });
    } catch (e) {
      console.error("  ✗ firearm detail:", e.message);
    }
    await sleep(DELAY_MS);
  }
}

// ── Ammo ──────────────────────────────────────────────────────────────────────

async function importAmmo(wb) {
  console.log(
    "\n── Ammo ─────────────────────────────────────────────────────────",
  );
  for (const r of readSheet(wb, "Ammo")) {
    const name = str(r["Name *"]),
      caliber = str(r["Caliber *"]),
      qty = int(r["Quantity *"]);
    if (!name || !caliber || qty == null) {
      if (name)
        console.warn(`  Skipping "${name}" — missing caliber or quantity`);
      skipped++;
      continue;
    }
    const id = await createItem({
      name,
      brand: str(r["Brand"]),
      category: "AMMO",
      datePurchased:
        date(r["Date Purchased\n(YYYY-MM-DD)"]) ?? date(r["Date Purchased"]),
      vendor: str(r["Vendor"]),
      pricePaid: num(r["Total Paid"]),
      currency: currency(r["Currency"]),
      notes: str(r["Notes"]),
    });
    if (!id) continue;
    const rawUnit = str(r["Unit *"])?.toUpperCase();
    const input = {
      id: randomUUID(),
      itemId: id,
      caliber,
      quantity: qty,
      unit: ["ROUNDS", "BOX", "CASE"].includes(rawUnit) ? rawUnit : "ROUNDS",
      roundsPerUnit: int(r["Rounds / Unit"]),
      grain: int(r["Grain"]),
      bulletType: str(r["Bullet Type"]),
      velocityFps: int(r["Velocity (fps)"]),
    };
    if (DRY_RUN) {
      console.log("  [DRY] ammo:", input);
      await sleep(DELAY_MS);
      continue;
    }
    try {
      await gql(CREATE_AMMO, { input });
    } catch (e) {
      console.error("  ✗ ammo detail:", e.message);
    }
    await sleep(DELAY_MS);
  }
}

// ── Filaments ─────────────────────────────────────────────────────────────────

async function importFilaments(wb) {
  console.log(
    "\n── Filaments ────────────────────────────────────────────────────",
  );
  for (const r of readSheet(wb, "Filaments")) {
    const name = str(r["Name *"]);
    if (!name) {
      skipped++;
      continue;
    }
    const id = await createItem({
      name,
      brand: str(r["Brand"]),
      category: "FILAMENT",
      datePurchased:
        date(r["Date Purchased\n(YYYY-MM-DD)"]) ?? date(r["Date Purchased"]),
      vendor: str(r["Vendor"]),
      pricePaid: num(r["Total Paid"]),
      currency: currency(r["Currency"]),
      notes: str(r["Notes"]),
    });
    if (!id) continue;
    const rawMat = str(r["Material *"])?.toUpperCase();
    const validMats = ["PLA", "ABS", "PETG", "TPU", "ASA", "NYLON", "OTHER"];
    const rawDiam = str(r["Diameter (mm) *"]);
    const input = {
      id: randomUUID(),
      itemId: id,
      material: validMats.includes(rawMat) ? rawMat : "OTHER",
      color: str(r["Color"]),
      weightG: int(r["Weight (g)"]),
      diameter: rawDiam === "2.85" ? "d285" : "d175",
    };
    if (DRY_RUN) {
      console.log("  [DRY] filament:", input);
      await sleep(DELAY_MS);
      continue;
    }
    try {
      await gql(CREATE_FILAMENT, { input });
    } catch (e) {
      console.error("  ✗ filament detail:", e.message);
    }
    await sleep(DELAY_MS);
  }
}

// ── Instruments ───────────────────────────────────────────────────────────────

async function importInstruments(wb) {
  console.log(
    "\n── Instruments ──────────────────────────────────────────────────",
  );
  for (const r of readSheet(wb, "Instruments")) {
    const name = str(r["Name *"]);
    if (!name) {
      skipped++;
      continue;
    }
    const id = await createItem({
      name,
      brand: str(r["Brand"]),
      category: "INSTRUMENT",
      datePurchased:
        date(r["Date Purchased\n(YYYY-MM-DD)"]) ?? date(r["Date Purchased"]),
      vendor: str(r["Vendor"]),
      pricePaid: num(r["Total Paid"]),
      currency: currency(r["Currency"]),
      description: str(r["Description"]),
      notes: str(r["Notes"]),
    });
    if (!id) continue;
    const rawType = str(r["Type *"])?.toUpperCase();
    const validTypes = [
      "GUITAR",
      "BASS",
      "AMPLIFIER",
      "PEDAL",
      "KEYBOARD",
      "OTHER",
    ];
    const input = {
      id: randomUUID(),
      itemId: id,
      type: validTypes.includes(rawType) ? rawType : "OTHER",
      color: str(r["Color"]),
      strings: int(r["Strings"]),
      tuning: str(r["Tuning"]),
      bodyMaterial: str(r["Body Material"]),
      finish: str(r["Finish"]),
    };
    if (DRY_RUN) {
      console.log("  [DRY] instrument:", input);
      await sleep(DELAY_MS);
      continue;
    }
    try {
      await gql(CREATE_INSTRUMENT, { input });
    } catch (e) {
      console.error("  ✗ instrument detail:", e.message);
    }
    await sleep(DELAY_MS);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Gennaro A — Inventory Importer${DRY_RUN ? " (DRY RUN)" : ""}`);

  if (!DRY_RUN) {
    process.stdout.write(`Authenticating as ${userArg}… `);
    JWT = await getJwt();
    console.log("✓");
  }

  console.log("Reading inventory_import.xlsx…");
  const wb = xlsxRead(readFileSync("./inventory_import.xlsx"), {
    type: "buffer",
    cellDates: true,
  });

  const run = (name, fn) =>
    !sheetArg || sheetArg === name ? fn(wb) : Promise.resolve();
  await run("Firearms", importFirearms);
  await run("Ammo", importAmmo);
  await run("Filaments", importFilaments);
  await run("Instruments", importInstruments);

  console.log(
    `\n─────────────────────────────────────────────────────────────────`,
  );
  console.log(
    `  Inserted: ${inserted}  |  Skipped: ${skipped}  |  Errors: ${errors}`,
  );
  if (DRY_RUN) console.log("  (Dry run — nothing was written to the database)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
