/**
 * gennaroAgent/handler.ts
 *
 * AppSync-invoked Lambda that runs a tool-calling loop against Claude.
 * Starts with a read-only finance surface (accounts, transactions, recurrences,
 * savings goals, holdings, quotes, assets, loans) — more domains will be
 * added over time. Writes are intentionally out of scope for this iteration;
 * the frontend still handles mutations directly through the typed client.
 */

import Anthropic from "@anthropic-ai/sdk";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/gennaroAgent";
import type { Schema } from "../../data/resource";
// Pure-TS helpers shared with the dashboard / tax-outlook UI — bundled by
// esbuild at deploy time. Keep this import surface minimal so a future
// frontend-only refactor doesn't accidentally bring browser-only deps into
// the Lambda bundle.
import {
  projectFromPaychecks, project401kWithCap, contribPctToReachCap,
  irs401kElectiveLimit, taxOwedFederal, taxGap,
  additionalMedicareTaxOwed, additionalMedicareTaxWithheld,
  project415cTotal, extractEmployerMatchYtd, extractEmployerMatchPeriod,
  type FilingStatus, type RsuVestCadence,
} from "../../../components/finance/planning";

const MODEL_ID   = "claude-sonnet-4-6";
const MAX_TURNS  = 10;    // safety cap on the tool-calling loop
const MAX_TOKENS = 1024;

// ANTHROPIC_API_KEY is injected by CDK (backend.ts) from the existing
// gennaroanesi/transcribe secret, so it's not part of the $amplify/env type
// surface. Read it from process.env to keep the rest of env typed-safe.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.warn("[gennaroAgent] ANTHROPIC_API_KEY is missing — Anthropic calls will fail.");
}
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Data client (lazy init) ──────────────────────────────────────────────────

type DataClient = ReturnType<typeof generateClient<Schema>>;
let _client: DataClient | null = null;

async function getClient(): Promise<DataClient> {
  if (_client) return _client;
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  _client = generateClient<Schema>();
  return _client;
}

// Load inventoryItem rows into a Map keyed by id, optionally filtered by
// category + active state. Used by the per-category list_* tools to join
// detail rows (which only have itemId) back to the base item for its name
// and brand. For the scale of a personal inventory, listing all items in a
// category is cheaper than issuing one .get per detail row.
async function buildItemMap(category: string, activeOnly: boolean): Promise<Map<string, any>> {
  const c = await getClient();
  const filter: any = { category: { eq: category } };
  if (activeOnly) filter.active = { ne: false };
  const items = await listAll(c.models.inventoryItem, filter);
  const m = new Map<string, any>();
  for (const item of items) if (item.id) m.set(item.id, item);
  return m;
}

// Amplify.list() caps at 100 per page. This helper follows nextToken until the
// cap is reached, keeping the agent from chewing through giant tables.
async function listAll<T>(
  model: { list: (args?: any) => Promise<{ data: T[]; nextToken?: string | null }> },
  filter?: any,
  cap = 500,
): Promise<T[]> {
  const { items } = await listAllWithMeta(model, filter, cap);
  return items;
}

// Same as listAll but returns whether the cap truncated the result so the
// caller can warn the user / agent rather than silently lying about totals.
async function listAllWithMeta<T>(
  model: { list: (args?: any) => Promise<{ data: T[]; nextToken?: string | null }> },
  filter?: any,
  cap = 500,
): Promise<{ items: T[]; truncated: boolean }> {
  const out: T[] = [];
  let nextToken: string | null | undefined;
  do {
    const args: any = { limit: 100, nextToken };
    if (filter) args.filter = filter;
    const { data, nextToken: nt } = await model.list(args);
    out.push(...(data ?? []));
    nextToken = nt ?? null;
  } while (nextToken && out.length < cap);
  // If we stopped because we hit the cap AND there is still a continuation
  // token, results were truncated. If we stopped because nextToken ran out,
  // we have everything.
  return { items: out.slice(0, cap), truncated: !!nextToken };
}

// Shared transaction fetch for list_/sum_/count_transactions. Server-side
// filters use the typed client (accountId, goalId, category, status, date
// range). descriptionContains is applied CLIENT-SIDE with a lowercased
// substring match — DynamoDB `contains` is case-sensitive, so a server-side
// filter for "Genesis" silently misses "GENESIS AERO" rows.
async function fetchTransactionsForAgent(
  c: any,
  input: any,
  cap: number,
): Promise<{ items: any[]; truncated: boolean }> {
  const serverFilter: any = {};
  if (input.accountId) serverFilter.accountId = { eq: input.accountId };
  if (input.goalId)    serverFilter.goalId    = { eq: input.goalId };
  if (input.category)  serverFilter.category  = { eq: input.category };
  if (input.status)    serverFilter.status    = { eq: input.status };
  if (input.from && input.to) serverFilter.date = { between: [input.from, input.to] };
  else if (input.from)        serverFilter.date = { ge: input.from };
  else if (input.to)          serverFilter.date = { le: input.to };

  const hasServerFilter = Object.keys(serverFilter).length > 0;
  const { items, truncated } = await listAllWithMeta(
    c.models.financeTransaction,
    hasServerFilter ? serverFilter : undefined,
    cap,
  );

  if (!input.descriptionContains) return { items, truncated };
  const needle = String(input.descriptionContains).toLowerCase();
  const filtered = items.filter((t: any) =>
    typeof t?.description === "string" && t.description.toLowerCase().includes(needle),
  );
  return { items: filtered, truncated };
}

// Inventory write helper. Splits the agent's flat input into base inventoryItem
// fields + category detail fields, creates the item first, then the detail row
// keyed on the new itemId. If the detail create fails we delete the orphan item
// so the failure is atomic from the user's point of view.
async function createInventory(
  c: any,
  input: Record<string, any>,
  category: string,
  detailModel: { create: (args: any) => Promise<any>; },
  detailFields: readonly string[],
): Promise<string> {
  if (!input.name || typeof input.name !== "string" || !input.name.trim()) {
    return stringify({ ok: false, error: "name is required" });
  }
  // Carve the base inventoryItem fields out of the flat input.
  const itemPayload: any = {
    name:          input.name.trim(),
    brand:         input.brand        ?? null,
    description:   input.description  ?? null,
    category,
    datePurchased: input.datePurchased ?? null,
    vendor:        input.vendor        ?? null,
    url:           input.url           ?? null,
    pricePaid:     input.pricePaid     ?? null,
    currency:      input.currency      ?? "USD",
    notes:         input.notes         ?? null,
    active:        true,
  };
  const { data: newItem, errors: itemErrors } =
    await c.models.inventoryItem.create(itemPayload);
  if (itemErrors?.length || !newItem) {
    return stringify({ ok: false, error: itemErrors?.[0]?.message ?? "inventoryItem create failed" });
  }

  // Build the detail payload from the agreed-on field list.
  const detailPayload: Record<string, any> = { itemId: newItem.id };
  for (const k of detailFields) {
    if (input[k] !== undefined) detailPayload[k] = input[k];
  }

  const { data: newDetail, errors: detailErrors } = await detailModel.create(detailPayload);
  if (detailErrors?.length || !newDetail) {
    // Roll back the orphan item so the user retains the chance to fix and retry.
    try { await c.models.inventoryItem.delete({ id: newItem.id }); } catch { /* best-effort */ }
    return stringify({
      ok: false,
      error: detailErrors?.[0]?.message ?? "detail create failed",
    });
  }

  return stringify({
    ok: true,
    data: { itemId: newItem.id, detailId: newDetail.id, name: newItem.name },
  });
}

// ── Tool definitions ────────────────────────────────────────────────────────
// Shape matches Anthropic.Tool[]. Descriptions teach the model when each tool
// applies — keep them specific.

// Properties shared by all create_<category> tools — the base inventoryItem
// fields. Each create tool spreads this in then layers its category-specific
// detail fields on top.
const BASE_ITEM_PROPS = {
  name:          { type: "string", description: "Display name. Required." },
  brand:         { type: "string" },
  description:   { type: "string" },
  vendor:        { type: "string" },
  url:           { type: "string", description: "Product URL." },
  pricePaid:     { type: "number", description: "Price per unit in `currency`." },
  currency:      { type: "string", description: "ISO 4217 code. Defaults to USD." },
  datePurchased: { type: "string", description: "YYYY-MM-DD." },
  notes:         { type: "string" },
} as const;

const tools: Anthropic.Tool[] = [
  {
    name: "list_accounts",
    description:
      "List finance accounts (checking, savings, brokerage, retirement, credit, loan, cash, other). Includes balances, credit limits, APR/APY, and favorite status.",
    input_schema: {
      type: "object" as const,
      properties: {
        includeInactive: { type: "boolean", description: "Include accounts marked active=false. Default false." },
        type: { type: "string", description: "Filter to one type: CHECKING, SAVINGS, BROKERAGE, RETIREMENT, CREDIT, LOAN, CASH, OTHER." },
      },
    },
  },
  {
    name: "get_account",
    description: "Fetch a single account by id.",
    input_schema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_transactions",
    description:
      "List transactions with optional filters. Transactions have type INCOME/EXPENSE/TRANSFER, a status (POSTED or PENDING), optional category and goalId, and a date (YYYY-MM-DD). Always push merchant / payee searches down via descriptionContains rather than fetching everything and filtering yourself. The response includes a `truncated` flag — if true, narrow the filter (date range, account, etc.) and call again. If the user only wants a total or count, prefer sum_transactions / count_transactions — they share this filter shape, return aggregates instead of rows, and have a much higher cap so they won't truncate on broad queries.",
    input_schema: {
      type: "object" as const,
      properties: {
        accountId:           { type: "string", description: "Filter to one account." },
        goalId:              { type: "string", description: "Filter to one savings goal." },
        category:            { type: "string", description: "Exact match on category string." },
        descriptionContains: { type: "string", description: "Case-insensitive substring match on description. Use this for merchant/payee searches — e.g. 'genesis' will match 'IN *GENESIS AERO', 'Genesis Aero', etc. Pick a short distinctive fragment that's stable across imports." },
        from:                { type: "string", description: "Inclusive start date, YYYY-MM-DD." },
        to:                  { type: "string", description: "Inclusive end date, YYYY-MM-DD." },
        status:              { type: "string", description: "POSTED or PENDING." },
      },
    },
  },
  {
    name: "sum_transactions",
    description:
      "Sum the `amount` field of transactions matching the given filters. Returns total, count, and a per-month breakdown (total + count per YYYY-MM). Same filter shape as list_transactions. Prefer this over list_transactions when the user asks for a total, monthly spend, year-to-date, etc. — it returns numbers, not rows, and uses a much higher cap so a broad query like 'all Genesis Aero in 2026' won't truncate. Note: amounts are signed (negative = expense, positive = income), so a sum of EXPENSE-type rows will be negative.",
    input_schema: {
      type: "object" as const,
      properties: {
        accountId:           { type: "string" },
        goalId:              { type: "string" },
        category:            { type: "string" },
        descriptionContains: { type: "string", description: "Case-insensitive substring match on description." },
        from:                { type: "string", description: "Inclusive start date, YYYY-MM-DD." },
        to:                  { type: "string", description: "Inclusive end date, YYYY-MM-DD." },
        status:              { type: "string", description: "POSTED or PENDING." },
      },
    },
  },
  {
    name: "count_transactions",
    description:
      "Count transactions matching the given filters. Returns total count and a per-month breakdown. Same filter shape as list_transactions. Use this when the user asks 'how many' rather than 'how much'.",
    input_schema: {
      type: "object" as const,
      properties: {
        accountId:           { type: "string" },
        goalId:              { type: "string" },
        category:            { type: "string" },
        descriptionContains: { type: "string", description: "Case-insensitive substring match on description." },
        from:                { type: "string", description: "Inclusive start date, YYYY-MM-DD." },
        to:                  { type: "string", description: "Inclusive end date, YYYY-MM-DD." },
        status:              { type: "string", description: "POSTED or PENDING." },
      },
    },
  },
  {
    name: "get_transaction",
    description: "Fetch a single transaction by id.",
    input_schema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_recurrences",
    description:
      "List recurring transactions. Each has a cadence (WEEKLY/BIWEEKLY/MONTHLY/QUARTERLY/SEMIANNUALLY/ANNUALLY), start/end dates, a next occurrence date, and may be active or paused.",
    input_schema: {
      type: "object" as const,
      properties: {
        accountId:  { type: "string" },
        activeOnly: { type: "boolean", description: "Only include active=true. Default true." },
      },
    },
  },
  {
    name: "get_recurrence",
    description: "Fetch a single recurring rule by id.",
    input_schema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_savings_goals",
    description:
      "List savings goals. Each has a target amount, current amount, optional target date, and priority.",
    input_schema: {
      type: "object" as const,
      properties: {
        activeOnly: { type: "boolean", description: "Only include active=true. Default true." },
      },
    },
  },
  {
    name: "get_savings_goal",
    description: "Fetch a single savings goal by id.",
    input_schema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_goal_funding_sources",
    description:
      "List mappings that declare which accounts fund which goals. Can be filtered by goalId or accountId.",
    input_schema: {
      type: "object" as const,
      properties: {
        goalId:    { type: "string" },
        accountId: { type: "string" },
      },
    },
  },
  {
    name: "list_goal_milestones",
    description: "List milestones associated with savings goals.",
    input_schema: {
      type: "object" as const,
      properties: {
        goalId: { type: "string" },
      },
    },
  },
  {
    name: "list_loans",
    description: "List loans. Each loan has a principal, interest rate (APR as decimal), term, monthly payment, and links to a LOAN-type account.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_loan",
    description: "Fetch a single loan by id.",
    input_schema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_loan_payments",
    description: "List loan payments. Can be filtered by loanId.",
    input_schema: {
      type: "object" as const,
      properties: {
        loanId: { type: "string" },
      },
    },
  },
  {
    name: "list_assets",
    description:
      "List physical assets (vehicles, real estate, collectibles, etc). Each has a type, purchase value, current value, and active flag.",
    input_schema: {
      type: "object" as const,
      properties: {
        activeOnly: { type: "boolean", description: "Only include active=true. Default true." },
        assetType:  { type: "string", description: "Optional type filter." },
      },
    },
  },
  {
    name: "get_asset",
    description: "Fetch a single asset by id.",
    input_schema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_holding_lots",
    description:
      "List purchase lots in brokerage/retirement accounts. Each lot records a ticker, quantity, cost basis, and purchase date. Aggregate by ticker for total positions.",
    input_schema: {
      type: "object" as const,
      properties: {
        accountId: { type: "string" },
        ticker:    { type: "string" },
      },
    },
  },
  {
    name: "list_ticker_quotes",
    description:
      "List the latest known market prices for tickers. Each row is keyed by ticker symbol; source is 'yahoo' for auto-refreshed quotes or 'manual' for user overrides.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_ticker_quote",
    description: "Fetch the current quote for a specific ticker symbol.",
    input_schema: {
      type: "object" as const,
      properties: { ticker: { type: "string" } },
      required: ["ticker"],
    },
  },

  // ── Inventory ────────────────────────────────────────────────────────────
  // Inventory has a base `item` record (name, brand, price, category) and one
  // category-specific detail table per category (firearms, ammo, instruments,
  // filaments, photography). Each list_<category> tool returns the details
  // joined with their base items, so the agent can answer name + spec questions
  // in a single turn.
  {
    name: "list_inventory_items",
    description:
      "List base inventory items across all categories. Useful for name/brand searches that span categories. For category-specific detail (caliber, instrument type, etc.) call the matching list_<category> tool instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        category:      { type: "string", description: "Filter to one category: FIREARM, AMMO, FILAMENT, INSTRUMENT, PHOTOGRAPHY, OTHER." },
        nameContains:  { type: "string", description: "Case-insensitive substring match on name." },
        brandContains: { type: "string", description: "Case-insensitive substring match on brand." },
        activeOnly:    { type: "boolean", description: "Only items with active=true. Default true." },
      },
    },
  },
  {
    name: "list_firearms",
    description:
      "List firearms with their base item data joined in. Each row has type (HANDGUN/RIFLE/SHOTGUN/SBR/SUPPRESSOR/OTHER), caliber, serial number, and the parent item's name/brand/notes.",
    input_schema: {
      type: "object" as const,
      properties: {
        type:       { type: "string", description: "Filter to a firearm type." },
        caliber:    { type: "string", description: "Substring match on caliber (e.g. '9mm', '5.56', '.45')." },
        activeOnly: { type: "boolean", description: "Only active items. Default true." },
      },
    },
  },
  {
    name: "list_ammo",
    description:
      "List ammo with base item data joined in. Each row has caliber, quantity, unit (ROUNDS/BOX/CASE), roundsPerUnit, grain, bulletType, and roundsAvailable (current on-hand). When a caliber filter is provided, the result also includes totalRoundsAvailable summed across matching rows — use that for 'how many X do I have' style questions.",
    input_schema: {
      type: "object" as const,
      properties: {
        caliber:       { type: "string", description: "Substring match on caliber (e.g. '9mm', '5.56')." },
        onlyAvailable: { type: "boolean", description: "Exclude rows where roundsAvailable <= 0. Default false." },
        activeOnly:    { type: "boolean", description: "Only active items. Default true." },
      },
    },
  },
  {
    name: "list_instruments",
    description:
      "List musical instruments (guitars, basses, amps, pedals, keyboards). Rows join the detail record with the base item. Filter by type=GUITAR to answer 'list all my guitars'.",
    input_schema: {
      type: "object" as const,
      properties: {
        type:       { type: "string", description: "Filter to one type: GUITAR, BASS, AMPLIFIER, PEDAL, KEYBOARD, OTHER." },
        activeOnly: { type: "boolean", description: "Only active items. Default true." },
      },
    },
  },
  {
    name: "list_filaments",
    description:
      "List 3D-printer filaments with base item data joined in. Each row has material (PLA, ABS, PETG, TPU, …), variant, color, diameter (d175/d285), weightG per spool, and quantity (spools).",
    input_schema: {
      type: "object" as const,
      properties: {
        material:      { type: "string", description: "Filter to one material enum value." },
        colorContains: { type: "string", description: "Substring match on color." },
        activeOnly:    { type: "boolean", description: "Only active items. Default true." },
      },
    },
  },
  {
    name: "list_photography",
    description:
      "List photography gear (cameras, lenses, drones, gimbals, tripods, lights, accessories). Rows include mount, sensor format, focal-length range, max aperture, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        type:       { type: "string", description: "Filter to one type: CAMERA, LENS, DRONE, GIMBAL, TRIPOD, LIGHT, ACCESSORY, OTHER." },
        mount:      { type: "string", description: "Exact match on mount (e.g. 'E', 'RF', 'EF')." },
        activeOnly: { type: "boolean", description: "Only active items. Default true." },
      },
    },
  },
  {
    name: "list_electronics",
    description:
      "List electronics inventory (components, modules, breadboards, wires, tools, consumables). Each row has type, partNumber, packaging, valueText, quantity, electrical ratings, color, joined with the base item.",
    input_schema: {
      type: "object" as const,
      properties: {
        type:           { type: "string", description: "Filter to one type: RESISTOR, CAPACITOR, INDUCTOR, DIODE, LED, TRANSISTOR, IC, MODULE, BREADBOARD, WIRE_CONNECTOR, TOOL, CONSUMABLE, OTHER." },
        partContains:   { type: "string", description: "Substring match on partNumber (e.g. '2N3904', 'NE555')." },
        valueContains:  { type: "string", description: "Substring match on valueText (e.g. '10k', '100µF')." },
        activeOnly:     { type: "boolean", description: "Only active items. Default true." },
      },
    },
  },

  // ── Inventory writes ────────────────────────────────────────────────────
  // Each create_<category> tool atomically creates the base inventoryItem +
  // its category-specific detail row. Use ONLY after the user has explicitly
  // confirmed a preview — see the "Bulk import flow" section of the system
  // prompt.
  {
    name: "create_firearm",
    description:
      "Create one firearm: writes the base inventoryItem (category=FIREARM) and the matching inventoryFirearm detail row in one operation. Returns the new IDs.",
    input_schema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        ...BASE_ITEM_PROPS,
        type:         { type: "string", description: "HANDGUN, RIFLE, SHOTGUN, SBR, SUPPRESSOR, OTHER." },
        caliber:      { type: "string" },
        serialNumber: { type: "string" },
        action:       { type: "string", description: "semi-auto, bolt, revolver, etc." },
        finish:       { type: "string" },
        barrelLength: { type: "string" },
      },
    },
  },
  {
    name: "create_ammo",
    description:
      "Create one ammo entry: base inventoryItem (category=AMMO) + inventoryAmmo detail. Returns the new IDs.",
    input_schema: {
      type: "object" as const,
      required: ["name", "caliber", "quantity"],
      properties: {
        ...BASE_ITEM_PROPS,
        caliber:         { type: "string" },
        quantity:        { type: "integer", description: "Number of units purchased." },
        unit:            { type: "string", description: "ROUNDS, BOX, or CASE." },
        roundsPerUnit:   { type: "integer", description: "Rounds per box/case (1 if unit=ROUNDS)." },
        grain:           { type: "integer", description: "Bullet weight in grains." },
        bulletType:      { type: "string", description: "FMJ, HP, SP, etc." },
        velocityFps:     { type: "integer" },
        roundsAvailable: { type: "integer", description: "Current on-hand round count. Defaults to quantity*roundsPerUnit if omitted." },
      },
    },
  },
  {
    name: "create_filament",
    description:
      "Create one 3D-printer filament spool entry: base inventoryItem (category=FILAMENT) + inventoryFilament detail.",
    input_schema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        ...BASE_ITEM_PROPS,
        material: { type: "string", description: "PLA, ABS, PETG, TPU, ASA, NYLON, PC, PLA_CF, PETG_CF, PA, PA_CF, PA6_GF, PVA, HIPS, OTHER." },
        variant:  { type: "string", description: "HF, CF, Translucent, Matte, Silk, etc." },
        color:    { type: "string" },
        weightG:  { type: "integer", description: "Spool weight in grams." },
        diameter: { type: "string", description: "d175 (1.75mm) or d285 (2.85mm)." },
        quantity: { type: "integer", description: "Number of spools. Default 1." },
      },
    },
  },
  {
    name: "create_instrument",
    description:
      "Create one musical instrument: base inventoryItem (category=INSTRUMENT) + inventoryInstrument detail.",
    input_schema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        ...BASE_ITEM_PROPS,
        type:         { type: "string", description: "GUITAR, BASS, AMPLIFIER, PEDAL, KEYBOARD, OTHER." },
        color:        { type: "string" },
        strings:      { type: "integer" },
        tuning:       { type: "string" },
        bodyMaterial: { type: "string" },
        finish:       { type: "string" },
      },
    },
  },
  {
    name: "create_photography",
    description:
      "Create one photography item (camera, lens, drone, etc.): base inventoryItem (category=PHOTOGRAPHY) + inventoryPhotography detail.",
    input_schema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        ...BASE_ITEM_PROPS,
        type:             { type: "string", description: "CAMERA, LENS, DRONE, GIMBAL, TRIPOD, LIGHT, ACCESSORY, OTHER." },
        serialNumber:     { type: "string" },
        mount:            { type: "string", description: "E, RF, L, EF, M4/3, DJI, etc." },
        sensorFormat:     { type: "string", description: "FF, APS-C, M43, 1\", 1/2.3\"." },
        focalLengthMin:   { type: "number", description: "mm; equal to max for primes." },
        focalLengthMax:   { type: "number", description: "mm." },
        apertureMax:      { type: "number", description: "f-stop, e.g. 2.8." },
        stabilized:       { type: "boolean" },
        weightG:          { type: "integer" },
        maxFlightTimeMin: { type: "integer", description: "Drones only." },
        subC250g:         { type: "boolean", description: "Drones: under FAA 250g registration threshold." },
      },
    },
  },
  {
    name: "create_electronic",
    description:
      "Create one electronics item (component, module, breadboard, wire, tool, consumable): base inventoryItem (category=ELECTRONICS) + inventoryElectronic detail.",
    input_schema: {
      type: "object" as const,
      required: ["name"],
      properties: {
        ...BASE_ITEM_PROPS,
        type:           { type: "string", description: "RESISTOR, CAPACITOR, INDUCTOR, DIODE, LED, TRANSISTOR, IC, MODULE, BREADBOARD, WIRE_CONNECTOR, TOOL, CONSUMABLE, OTHER." },
        partNumber:     { type: "string", description: "2N3904, NE555, ATmega328P, etc." },
        packaging:      { type: "string", description: "THT, SMD-0805, DIP-8, SOIC-14, TO-220." },
        quantity:       { type: "integer", description: "Current count on hand." },
        valueText:      { type: "string", description: "Human-readable value: '10kΩ', '100µF 25V', '5V'." },
        voltageRating:  { type: "number", description: "V (caps, diodes, regulators)." },
        currentRatingA: { type: "number", description: "A (diodes, transistors, fuses)." },
        powerRatingW:   { type: "number", description: "W (resistors, regulators)." },
        tolerancePct:   { type: "number" },
        color:          { type: "string", description: "LED color, wire jacket, etc." },
      },
    },
  },
  // ── Paychecks + tax / 401k projections (Phase 5) ─────────────────────
  {
    name: "list_paychecks",
    description:
      "List paycheck rows (one row per pay stub) with optional person and date-range filters. Heavy `lineItems` blob is omitted — call get_latest_paycheck if you need the per-deduction breakdown. Each row has gross, taxableWage, fedWh, oasdi, medicare, contrib401k, ytdGross, ytdFedWh, ytd401k, etc. `person` is ME or SPOUSE.",
    input_schema: {
      type: "object" as const,
      properties: {
        person: { type: "string", description: "ME or SPOUSE." },
        from:   { type: "string", description: "Inclusive YYYY-MM-DD." },
        to:     { type: "string", description: "Inclusive YYYY-MM-DD." },
      },
    },
  },
  {
    name: "get_latest_paycheck",
    description: "Fetch the single most recent paycheck for a person — the YTD columns on this row are the source of truth for AGI / tax / 401k projections. Returns null if no paychecks exist for that person.",
    input_schema: {
      type: "object" as const,
      properties: { person: { type: "string", description: "ME or SPOUSE." } },
      required: ["person"],
    },
  },
  {
    name: "project_agi",
    description:
      "Project year-end AGI components (gross, taxable wage, withholdings, 401k, RSU/bonus supplemental) from current-year paychecks. Use this rather than summing list_paychecks yourself — the helper handles RSU/bonus decomposition + cadence and matches the dashboard tile's numbers. Omit `person` to get both ME and SPOUSE in one call.",
    input_schema: {
      type: "object" as const,
      properties: {
        person:         { type: "string", description: "ME or SPOUSE. Omit for both." },
        year:           { type: "integer", description: "Defaults to current calendar year." },
        rsuVestCadence: { type: "string", description: "QUARTERLY | MONTHLY | SEMIANNUAL | ANNUAL | IRREGULAR. Defaults to IRREGULAR (no RSU extrapolation)." },
      },
    },
  },
  {
    name: "project_tax",
    description:
      "Estimate year-end federal tax liability and refund/owed gap. Pulls projections from project_agi, applies the §402(g) cap correction to taxable wages, runs bracket math, adds Additional Medicare Tax. `filingStatus` is SINGLE or MFJ — when MFJ and both persons have paychecks on file, the response includes a `combined` block with the joint outcome. Defaults to SINGLE.",
    input_schema: {
      type: "object" as const,
      properties: {
        person:         { type: "string", description: "ME or SPOUSE. Omit for both." },
        filingStatus:   { type: "string", description: "SINGLE or MFJ. Default SINGLE." },
        year:           { type: "integer" },
        rsuVestCadence: { type: "string" },
      },
    },
  },
  {
    name: "project_401k_progress",
    description:
      "Pace check toward the IRS §402(g) employee elective deferral cap. Returns YTD contribution, current contribution %, projected year-end 401k (capped), headroom, whether the cap will be reached, and `pctToReachCap` — the rate the user would need to contribute from now on to just hit the cap. Also returns a `megaBackdoor` block (null when the user isn't using it) with §415(c) total-additions projection: projected employee elective + employer match + after-tax employee contributions, `irsLimit` ($70k–$72k), `headroom`, and `afterTaxHeadroom` — how much more after-tax 401k they could contribute this year before hitting §415(c) (the mega-backdoor Roth limit). Use this when the user asks about being on pace, maxing out 401k, mega-backdoor headroom, or whether they should bump their contribution %.",
    input_schema: {
      type: "object" as const,
      properties: {
        person:         { type: "string", description: "ME or SPOUSE." },
        year:           { type: "integer" },
        rsuVestCadence: { type: "string" },
      },
      required: ["person"],
    },
  },
];

// ── Tool dispatcher ─────────────────────────────────────────────────────────

type ToolResult = { ok: true; data: any } | { ok: false; error: string };

function stringify(result: ToolResult): string {
  return JSON.stringify(result);
}

async function executeTool(name: string, input: Record<string, any>): Promise<string> {
  try {
    const c = await getClient();
    switch (name) {
      case "list_accounts": {
        const filter: any = {};
        if (!input.includeInactive) filter.active = { ne: false };
        if (input.type) filter.type = { eq: input.type };
        const accounts = await listAll(c.models.financeAccount, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { accounts } });
      }
      case "get_account": {
        const { data, errors } = await c.models.financeAccount.get({ id: input.id });
        if (errors?.length) return stringify({ ok: false, error: errors[0].message });
        return stringify({ ok: true, data: { account: data } });
      }
      case "list_transactions": {
        // Filtered queries get a higher cap — a "Genesis Aero" or "between
        // 2024-01 and 2024-12" search should never lose rows. Only the
        // totally unfiltered case keeps a tighter safety limit.
        const hasFilter = !!(
          input.accountId || input.goalId || input.category || input.status ||
          input.descriptionContains || input.from || input.to
        );
        const cap = hasFilter ? 5000 : 1000;
        const { items: txs, truncated } = await fetchTransactionsForAgent(c, input, cap);
        return stringify({
          ok: true,
          data: { transactions: txs, count: txs.length, truncated },
        });
      }
      case "sum_transactions": {
        // Aggregate path — only totals are returned, so the cap can be much
        // higher without blowing up the agent's context window. 20k covers any
        // realistic personal-finance query; if you have a table that exceeds
        // that, scope the query by date range or account.
        const { items, truncated } = await fetchTransactionsForAgent(c, input, 20000);
        let total = 0;
        const byMonth: Record<string, { total: number; count: number }> = {};
        for (const t of items) {
          const amt = typeof t?.amount === "number" ? t.amount : 0;
          total += amt;
          const month = typeof t?.date === "string" ? t.date.slice(0, 7) : "";
          if (!month) continue;
          const bucket = byMonth[month] ?? { total: 0, count: 0 };
          bucket.total += amt;
          bucket.count += 1;
          byMonth[month] = bucket;
        }
        return stringify({
          ok: true,
          data: { total, count: items.length, byMonth, truncated },
        });
      }
      case "count_transactions": {
        const { items, truncated } = await fetchTransactionsForAgent(c, input, 20000);
        const byMonth: Record<string, number> = {};
        for (const t of items) {
          const month = typeof t?.date === "string" ? t.date.slice(0, 7) : "";
          if (!month) continue;
          byMonth[month] = (byMonth[month] ?? 0) + 1;
        }
        return stringify({
          ok: true,
          data: { count: items.length, byMonth, truncated },
        });
      }
      case "get_transaction": {
        const { data, errors } = await c.models.financeTransaction.get({ id: input.id });
        if (errors?.length) return stringify({ ok: false, error: errors[0].message });
        return stringify({ ok: true, data: { transaction: data } });
      }
      case "list_recurrences": {
        const filter: any = {};
        if (input.accountId) filter.accountId = { eq: input.accountId };
        if (input.activeOnly !== false) filter.active = { ne: false };
        const recs = await listAll(c.models.financeRecurring, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { recurrences: recs } });
      }
      case "get_recurrence": {
        const { data, errors } = await c.models.financeRecurring.get({ id: input.id });
        if (errors?.length) return stringify({ ok: false, error: errors[0].message });
        return stringify({ ok: true, data: { recurrence: data } });
      }
      case "list_savings_goals": {
        const filter: any = {};
        if (input.activeOnly !== false) filter.active = { ne: false };
        const goals = await listAll(c.models.financeSavingsGoal, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { goals } });
      }
      case "get_savings_goal": {
        const { data, errors } = await c.models.financeSavingsGoal.get({ id: input.id });
        if (errors?.length) return stringify({ ok: false, error: errors[0].message });
        return stringify({ ok: true, data: { goal: data } });
      }
      case "list_goal_funding_sources": {
        const filter: any = {};
        if (input.goalId)    filter.goalId    = { eq: input.goalId };
        if (input.accountId) filter.accountId = { eq: input.accountId };
        const mappings = await listAll(c.models.financeGoalFundingSource, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { fundingSources: mappings } });
      }
      case "list_goal_milestones": {
        const filter: any = {};
        if (input.goalId) filter.goalId = { eq: input.goalId };
        const milestones = await listAll(c.models.financeGoalMilestone, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { milestones } });
      }
      case "list_loans": {
        const loans = await listAll(c.models.financeLoan);
        return stringify({ ok: true, data: { loans } });
      }
      case "get_loan": {
        const { data, errors } = await c.models.financeLoan.get({ id: input.id });
        if (errors?.length) return stringify({ ok: false, error: errors[0].message });
        return stringify({ ok: true, data: { loan: data } });
      }
      case "list_loan_payments": {
        const filter: any = {};
        if (input.loanId) filter.loanId = { eq: input.loanId };
        const payments = await listAll(c.models.financeLoanPayment, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { payments } });
      }
      case "list_assets": {
        const filter: any = {};
        if (input.activeOnly !== false) filter.active = { ne: false };
        if (input.assetType) filter.assetType = { eq: input.assetType };
        const assets = await listAll(c.models.financeAsset, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { assets } });
      }
      case "get_asset": {
        const { data, errors } = await c.models.financeAsset.get({ id: input.id });
        if (errors?.length) return stringify({ ok: false, error: errors[0].message });
        return stringify({ ok: true, data: { asset: data } });
      }
      case "list_holding_lots": {
        const filter: any = {};
        if (input.accountId) filter.accountId = { eq: input.accountId };
        if (input.ticker)    filter.ticker    = { eq: input.ticker.toUpperCase() };
        const lots = await listAll(c.models.financeHoldingLot, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { lots } });
      }
      case "list_ticker_quotes": {
        const quotes = await listAll(c.models.financeTickerQuote);
        return stringify({ ok: true, data: { quotes } });
      }
      case "get_ticker_quote": {
        const { data, errors } = await c.models.financeTickerQuote.get({ ticker: input.ticker.toUpperCase() });
        if (errors?.length) return stringify({ ok: false, error: errors[0].message });
        return stringify({ ok: true, data: { quote: data } });
      }

      // ── Inventory ────────────────────────────────────────────────────────
      case "list_inventory_items": {
        const activeOnly = input.activeOnly !== false;
        const filter: any = {};
        if (input.category)      filter.category = { eq: input.category };
        if (input.nameContains)  filter.name     = { contains: input.nameContains };
        if (input.brandContains) filter.brand    = { contains: input.brandContains };
        if (activeOnly)          filter.active   = { ne: false };
        const items = await listAll(c.models.inventoryItem, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { items, count: items.length } });
      }
      case "list_firearms": {
        const activeOnly = input.activeOnly !== false;
        const itemMap = await buildItemMap("FIREARM", activeOnly);
        const filter: any = {};
        if (input.type)    filter.type    = { eq: input.type };
        if (input.caliber) filter.caliber = { contains: input.caliber };
        const details = await listAll(c.models.inventoryFirearm, Object.keys(filter).length ? filter : undefined);
        const joined = details
          .map((d) => ({ ...d, item: itemMap.get(d.itemId ?? "") }))
          .filter((d) => d.item);
        return stringify({ ok: true, data: { firearms: joined, count: joined.length } });
      }
      case "list_ammo": {
        const activeOnly    = input.activeOnly !== false;
        const onlyAvailable = input.onlyAvailable === true;
        const itemMap = await buildItemMap("AMMO", activeOnly);
        const filter: any = {};
        if (input.caliber) filter.caliber = { contains: input.caliber };
        const details = await listAll(c.models.inventoryAmmo, Object.keys(filter).length ? filter : undefined);
        let joined = details
          .map((d) => ({ ...d, item: itemMap.get(d.itemId ?? "") }))
          .filter((d) => d.item);
        if (onlyAvailable) joined = joined.filter((d) => (d.roundsAvailable ?? 0) > 0);
        const totalRoundsAvailable = joined.reduce((s, d) => s + (d.roundsAvailable ?? 0), 0);
        return stringify({
          ok: true,
          data: {
            ammo: joined,
            count: joined.length,
            totalRoundsAvailable,
          },
        });
      }
      case "list_instruments": {
        const activeOnly = input.activeOnly !== false;
        const itemMap = await buildItemMap("INSTRUMENT", activeOnly);
        const filter: any = {};
        if (input.type) filter.type = { eq: input.type };
        const details = await listAll(c.models.inventoryInstrument, Object.keys(filter).length ? filter : undefined);
        const joined = details
          .map((d) => ({ ...d, item: itemMap.get(d.itemId ?? "") }))
          .filter((d) => d.item);
        return stringify({ ok: true, data: { instruments: joined, count: joined.length } });
      }
      case "list_filaments": {
        const activeOnly = input.activeOnly !== false;
        const itemMap = await buildItemMap("FILAMENT", activeOnly);
        const filter: any = {};
        if (input.material)      filter.material = { eq: input.material };
        if (input.colorContains) filter.color    = { contains: input.colorContains };
        const details = await listAll(c.models.inventoryFilament, Object.keys(filter).length ? filter : undefined);
        const joined = details
          .map((d) => ({ ...d, item: itemMap.get(d.itemId ?? "") }))
          .filter((d) => d.item);
        return stringify({ ok: true, data: { filaments: joined, count: joined.length } });
      }
      case "list_photography": {
        const activeOnly = input.activeOnly !== false;
        const itemMap = await buildItemMap("PHOTOGRAPHY", activeOnly);
        const filter: any = {};
        if (input.type)  filter.type  = { eq: input.type };
        if (input.mount) filter.mount = { eq: input.mount };
        const details = await listAll(c.models.inventoryPhotography, Object.keys(filter).length ? filter : undefined);
        const joined = details
          .map((d) => ({ ...d, item: itemMap.get(d.itemId ?? "") }))
          .filter((d) => d.item);
        return stringify({ ok: true, data: { photography: joined, count: joined.length } });
      }
      case "list_electronics": {
        const activeOnly = input.activeOnly !== false;
        const itemMap = await buildItemMap("ELECTRONICS", activeOnly);
        const filter: any = {};
        if (input.type)          filter.type       = { eq: input.type };
        if (input.partContains)  filter.partNumber = { contains: input.partContains };
        if (input.valueContains) filter.valueText  = { contains: input.valueContains };
        const details = await listAll(c.models.inventoryElectronic, Object.keys(filter).length ? filter : undefined);
        const joined = details
          .map((d) => ({ ...d, item: itemMap.get(d.itemId ?? "") }))
          .filter((d) => d.item);
        return stringify({ ok: true, data: { electronics: joined, count: joined.length } });
      }

      // ── Inventory writes ────────────────────────────────────────────────
      case "create_firearm":
        return await createInventory(c, input, "FIREARM", c.models.inventoryFirearm, [
          "type", "caliber", "serialNumber", "action", "finish", "barrelLength",
        ]);
      case "create_ammo":
        return await createInventory(c, input, "AMMO", c.models.inventoryAmmo, [
          "caliber", "quantity", "unit", "roundsPerUnit", "grain", "bulletType", "velocityFps", "roundsAvailable",
        ]);
      case "create_filament":
        return await createInventory(c, input, "FILAMENT", c.models.inventoryFilament, [
          "material", "variant", "color", "weightG", "diameter", "quantity",
        ]);
      case "create_instrument":
        return await createInventory(c, input, "INSTRUMENT", c.models.inventoryInstrument, [
          "type", "color", "strings", "tuning", "bodyMaterial", "finish",
        ]);
      case "create_photography":
        return await createInventory(c, input, "PHOTOGRAPHY", c.models.inventoryPhotography, [
          "type", "serialNumber", "mount", "sensorFormat",
          "focalLengthMin", "focalLengthMax", "apertureMax",
          "stabilized", "weightG", "maxFlightTimeMin", "subC250g",
        ]);
      case "create_electronic":
        return await createInventory(c, input, "ELECTRONICS", c.models.inventoryElectronic, [
          "type", "partNumber", "packaging", "quantity", "valueText",
          "voltageRating", "currentRatingA", "powerRatingW", "tolerancePct", "color",
        ]);

      // ── Paycheck reads + projections (Phase 5) ──────────────────────────
      case "list_paychecks": {
        const filters: any[] = [];
        if (input.person) filters.push({ person: { eq: input.person } });
        if (input.from)   filters.push({ payDate: { ge: input.from } });
        if (input.to)     filters.push({ payDate: { le: input.to } });
        const filter = filters.length === 0 ? undefined
          : filters.length === 1 ? filters[0]
          : { and: filters };
        const { items, truncated } = await listAllWithMeta(c.models.financePaycheck as any, filter, 500);
        // Strip the heavy lineItems blob from each row — listing 26 paychecks
        // would otherwise blow the agent's context. The detail tool returns
        // them when needed.
        const slim = items.map((p: any) => {
          const { lineItems: _omit, ...rest } = p;
          return rest;
        });
        return stringify({ ok: true, data: { items: slim, truncated } });
      }
      case "get_latest_paycheck": {
        if (!input.person) return stringify({ ok: false, error: "person is required" });
        const { items } = await listAllWithMeta(
          c.models.financePaycheck as any,
          { person: { eq: input.person } },
          500,
        );
        if (items.length === 0) return stringify({ ok: true, data: null });
        const sorted = (items as any[]).sort((a, b) => (b.payDate ?? "").localeCompare(a.payDate ?? ""));
        const latest = sorted[0];
        if (latest.lineItems && typeof latest.lineItems === "string") {
          try { latest.lineItems = JSON.parse(latest.lineItems); } catch { /* keep as string */ }
        }
        return stringify({ ok: true, data: latest });
      }
      case "project_agi": {
        const persons: string[] = input.person ? [input.person] : ["ME", "SPOUSE"];
        const year = input.year ?? new Date().getUTCFullYear();
        const cadence: RsuVestCadence = (input.rsuVestCadence ?? "IRREGULAR") as RsuVestCadence;
        const perPerson: any[] = [];
        for (const person of persons) {
          const { items } = await listAllWithMeta(
            c.models.financePaycheck as any,
            { and: [{ person: { eq: person } }, { payDate: { ge: `${year}-01-01` } }, { payDate: { le: `${year}-12-31` } }] },
            500,
          );
          if (items.length === 0) continue;
          const proj = projectFromPaychecks({ paychecks: items as any, rsuVestCadence: cadence });
          if (!proj) continue;
          perPerson.push({
            person,
            paychecksOnFile:        items.length,
            paychecksElapsed:       proj.paychecksElapsed,
            paychecksPerYear:       proj.paychecksPerYear,
            projectedGross:         proj.projectedGross,
            projectedTaxableWage:   proj.projectedTaxableWage,
            projectedFedWh:         proj.projectedFedWh,
            projectedOasdi:         proj.projectedOasdi,
            projectedMedicare:      proj.projectedMedicare,
            projected401k:          proj.projected401k,
            projectedRsuGross:      proj.projectedRsuGross,
            projectedBonusGross:    proj.projectedBonusGross,
            projectedTotalEarnings: proj.projectedTotalEarnings,
            projectedNet:           proj.projectedNet,
          });
        }
        return stringify({ ok: true, data: { year, rsuVestCadence: cadence, perPerson } });
      }
      case "project_tax": {
        const persons: string[] = input.person ? [input.person] : ["ME", "SPOUSE"];
        const year     = input.year ?? new Date().getUTCFullYear();
        const cadence: RsuVestCadence = (input.rsuVestCadence ?? "IRREGULAR") as RsuVestCadence;
        const filing: FilingStatus = (input.filingStatus ?? "SINGLE") as FilingStatus;
        const perPerson: any[] = [];
        for (const person of persons) {
          const { items } = await listAllWithMeta(
            c.models.financePaycheck as any,
            { and: [{ person: { eq: person } }, { payDate: { ge: `${year}-01-01` } }, { payDate: { le: `${year}-12-31` } }] },
            500,
          );
          if (items.length === 0) continue;
          const proj = projectFromPaychecks({ paychecks: items as any, rsuVestCadence: cadence });
          if (!proj) continue;
          const latest = (items as any[]).sort((a, b) => (b.payDate ?? "").localeCompare(a.payDate ?? ""))[0];
          // Salary-only YTD — latest.ytdGross is RSU/bonus-inflated; use the
          // projection's salary-only running total instead. (planning.ts:756)
          const ytdSalary  = proj.ytdSalaryGross;
          const currentPct = ytdSalary > 0 ? (latest.ytd401k ?? 0) / ytdSalary : 0;
          const capInfo    = project401kWithCap({
            ytd401k:         latest.ytd401k ?? 0,
            ytdGross:        ytdSalary,
            projectedGross:  proj.projectedGross,
            contributionPct: currentPct,
            year,
          });
          // Apply the §402(g) correction to taxable wages — when 401k caps
          // mid-year, the linear projection understates taxable income.
          const correctedTaxableWage = proj.projectedTaxableWage + capInfo.excessOverCap;
          const bracketTax  = taxOwedFederal({ projectedTaxableWage: correctedTaxableWage, filingStatus: filing, year });
          // Form 8959 net: liability − 0.9% already withheld via paycheck.
          // For SINGLE this is exactly zero (matching thresholds).
          const addlMedicareLiability = additionalMedicareTaxOwed({
            combinedMedicareWages: proj.projectedTotalEarnings,
            filingStatus:          filing,
          });
          const addlMedicareWh = additionalMedicareTaxWithheld({
            perPersonMedicareWages: [proj.projectedTotalEarnings],
          });
          const addlMedicare = addlMedicareLiability - addlMedicareWh;
          const taxOwed = bracketTax + addlMedicare;
          perPerson.push({
            person,
            projectedTaxableWage:   correctedTaxableWage,
            projectedFedWh:         proj.projectedFedWh,
            projectedTotalEarnings: proj.projectedTotalEarnings,
            taxOwed,
            gap:                    taxGap(proj.projectedFedWh, taxOwed),
          });
        }
        // MFJ combined view — only valid when both persons present + filing is MFJ.
        let combined: any = null;
        if (filing === "MFJ" && perPerson.length === 2) {
          const taxableWage = perPerson.reduce((s, p) => s + p.projectedTaxableWage, 0);
          const fedWh       = perPerson.reduce((s, p) => s + p.projectedFedWh, 0);
          const bracketTax  = taxOwedFederal({ projectedTaxableWage: taxableWage, filingStatus: "MFJ", year });
          // Form 8959 combined: liability against $250k MFJ threshold minus
          // each spouse's per-employer 0.9% WH above $200k YTD. Earlier
          // version skipped this entirely; now matches the Tax Outlook page.
          const perPersonMedicareWages = perPerson.map((p) => p.projectedTotalEarnings);
          const combinedMedicareWages  = perPersonMedicareWages.reduce((s, w) => s + w, 0);
          const addlMedicareLiability  = additionalMedicareTaxOwed({
            combinedMedicareWages,
            filingStatus: "MFJ",
          });
          const addlMedicareWh = additionalMedicareTaxWithheld({ perPersonMedicareWages });
          const addlMedicare   = addlMedicareLiability - addlMedicareWh;
          const taxOwed        = bracketTax + addlMedicare;
          combined = { taxableWage, fedWh, taxOwed, gap: taxGap(fedWh, taxOwed) };
        }
        return stringify({ ok: true, data: { year, filingStatus: filing, rsuVestCadence: cadence, perPerson, combined } });
      }
      case "project_401k_progress": {
        if (!input.person) return stringify({ ok: false, error: "person is required" });
        const year     = input.year ?? new Date().getUTCFullYear();
        const cadence: RsuVestCadence = (input.rsuVestCadence ?? "IRREGULAR") as RsuVestCadence;
        const { items } = await listAllWithMeta(
          c.models.financePaycheck as any,
          { and: [{ person: { eq: input.person } }, { payDate: { ge: `${year}-01-01` } }, { payDate: { le: `${year}-12-31` } }] },
          500,
        );
        if (items.length === 0) return stringify({ ok: true, data: null });
        const proj = projectFromPaychecks({ paychecks: items as any, rsuVestCadence: cadence });
        if (!proj) return stringify({ ok: true, data: null });
        const latest = (items as any[]).sort((a, b) => (b.payDate ?? "").localeCompare(a.payDate ?? ""))[0];
        // Salary-only YTD — see project401kWithCap's JSDoc.
        const ytdSalary  = proj.ytdSalaryGross;
        const currentPct = ytdSalary > 0 ? (latest.ytd401k ?? 0) / ytdSalary : 0;
        const capInfo = project401kWithCap({
          ytd401k:         latest.ytd401k ?? 0,
          ytdGross:        ytdSalary,
          projectedGross:  proj.projectedGross,
          contributionPct: currentPct,
          year,
        });
        const pctToCap = contribPctToReachCap({
          ytd401k:        latest.ytd401k ?? 0,
          ytdGross:       ytdSalary,
          projectedGross: proj.projectedGross,
          year,
        });
        // Mega-backdoor / §415(c) — only emit when there's actual employer
        // match or after-tax 401k YTD; otherwise this view is noise.
        let lineItems = latest.lineItems;
        if (typeof lineItems === "string") {
          try { lineItems = JSON.parse(lineItems); } catch { /* leave as string */ }
        }
        const ytdEmployerMatch  = extractEmployerMatchYtd(lineItems);
        const latestPeriodMatch = extractEmployerMatchPeriod(lineItems);
        const ytdAfterTax       = latest.ytdAfterTax401k ?? 0;
        const mega = (ytdEmployerMatch > 0 || ytdAfterTax > 0)
          ? project415cTotal({
              ytdEmployee:        latest.ytd401k ?? 0,
              ytdEmployerMatch,
              ytdAfterTax,
              ytdGross:           ytdSalary,
              projectedGross:     proj.projectedGross,
              projectedEmployee:  capInfo.projected401k,
              latestPeriodMatch,
              year,
            })
          : null;
        return stringify({ ok: true, data: {
          person:           input.person,
          year,
          rsuVestCadence:   cadence,
          ytd401k:          latest.ytd401k ?? 0,
          ytdGross:         ytdSalary,
          currentPct,
          irsLimit:         irs401kElectiveLimit(year),
          projected401k:    capInfo.projected401k,
          headroom:         capInfo.headroom,
          capReached:       capInfo.capReached,
          excessOverCap:    capInfo.excessOverCap,
          pctToReachCap:    pctToCap,
          megaBackdoor:     mega,
        } });
      }

      default:
        return stringify({ ok: false, error: `Unknown tool: ${name}` });
    }
  } catch (err: any) {
    console.error(`[gennaroAgent] tool ${name} failed:`, err);
    return stringify({ ok: false, error: err?.message ?? String(err) });
  }
}

// ── System prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(chatContext: unknown): string {
  const now = new Date();
  const TZ = "America/Chicago";
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  // chatContext arrives as a JSON string (AppSync a.json() wire format) from
  // the web UI, but future callers may pass an object. Accept both.
  let parsedCtx: unknown = chatContext;
  if (typeof chatContext === "string") {
    try { parsedCtx = JSON.parse(chatContext); } catch { parsedCtx = null; }
  }

  let ctxBlock = "";
  if (parsedCtx && typeof parsedCtx === "object") {
    try {
      const json = JSON.stringify(parsedCtx, null, 2);
      if (json && json !== "{}") {
        ctxBlock = `\n\nCurrent UI context (what the user is looking at):\n${json}`;
      }
    } catch { /* ignore */ }
  }

  return `You are the assistant for Gennaro's personal dashboard. You help summarize and explore three domains today:

1. FINANCE — accounts, transactions, recurring items, savings goals, holdings, ticker quotes, assets, loans.
2. PAYCHECKS — pay stubs (one row per check), with year-to-date columns that drive AGI / tax / 401k projections. Two persons: ME and SPOUSE.
3. INVENTORY — physical items (firearms, ammo, musical instruments, 3D-printer filaments, photography gear). A base item record holds name/brand/price; category-specific detail tables hold the specs. The list_<category> tools already join them.

Today is ${dateFmt.format(now)} (${TZ}).

Capabilities:
- Reads (list_*, get_*) cover both finance and inventory and are always safe to call.
- Writes are limited to inventory creation: create_firearm, create_ammo, create_filament, create_instrument, create_photography, create_electronic. Each creates the base inventoryItem AND its category detail row in one call. Finance writes are NOT wired up.

Bulk import flow (when the user pastes spreadsheet rows or asks to create multiple items):
1. PARSE FIRST. Extract rows, infer the category, and map columns to tool fields. Show a numbered preview (max ~30 rows shown if more, with the count); explain any column-to-field mapping decisions you made.
2. WAIT FOR EXPLICIT CONFIRMATION before calling any create_* tool. Look for "create them", "go", "confirm", "yes do it" — anything ambiguous, ask. Until then, do NOT call create_*.
3. ON CONFIRM, call the matching create_* tool once per row in sequence. Track ok vs failed counts; report a short summary at the end (e.g. "Created 47 of 50. 3 failed: …").
4. If the user wants to tweak the preview (rename a column, drop rows, change a default), do that before any create call.
5. For a single-item create ("add this resistor"), confirmation is still required but a one-line readback is enough.

Guidelines:
- Prefer concrete numbers over vague phrases. Format currency with a $ and thousands separators (e.g. $1,234.56).
- When a user asks about "this month" or "last month", translate to explicit from/to dates before calling tools.
- Tickers are uppercase. Normalize before calling get_ticker_quote.
- Manual ticker quotes (source="manual") are user-managed and may be stale even if fresh looking.
- Balances in BROKERAGE/RETIREMENT accounts are cash only — add Σ(lot.quantity × quote.price) for market value.
- Credit account balances are negative when money is owed. creditLimit and APR are informational.
- For inventory questions, pick the category-specific tool (list_firearms, list_ammo, list_instruments, list_photography, list_electronics, …) — each returns items already joined with their base record (name/brand). Only use list_inventory_items for cross-category name/brand searches.
- Ammo calibers are free-text (e.g. "9mm", "9mm Luger", "9x19 Parabellum"). Use contains-match. For "how many X do I have", list_ammo returns totalRoundsAvailable — use that directly.
- Instrument types are uppercase enums: GUITAR, BASS, AMPLIFIER, PEDAL, KEYBOARD. "Guitars" maps to type=GUITAR.
- Electronics types are uppercase enums: RESISTOR, CAPACITOR, INDUCTOR, DIODE, LED, TRANSISTOR, IC, MODULE, BREADBOARD, WIRE_CONNECTOR, TOOL, CONSUMABLE, OTHER. Pick the most specific bucket.
- For paycheck / tax / 401k questions, ALWAYS prefer the project_* tools (project_agi, project_tax, project_401k_progress) — they read the latest stub's YTD column and project to year-end correctly (RSU/bonus decomposition, §402(g) cap, Additional Medicare). Don't list all paychecks and sum manually — that's slower and skips the cap correction.
- When the user asks about refunds, AGI, taxable income, or "am I on pace", use project_tax with their household filing status (MFJ unless they say otherwise) and surface the gap and the contribution-percentage hint.
- Keep responses terse and direct. Don't narrate tool calls; just use the results.${ctxBlock}`;
}

// ── Handler ─────────────────────────────────────────────────────────────────

type HistoryMessage = { role: "user" | "assistant"; content: string };

type AgentArgs = {
  message:      string;
  history?:     HistoryMessage[] | null;
  chatContext?: unknown;
};

type AgentResponse = {
  message: string;
  actionsTaken: Array<{ tool: string; result: unknown }>;
};

export const handler = async (event: { arguments: AgentArgs }): Promise<AgentResponse> => {
  const {
    message: userMessage,
    history: rawHistory,
    chatContext,
  } = event.arguments;

  // Normalize history. History can arrive as an object (AppSync) or a JSON
  // string (if the caller serialized it); tolerate both.
  let historyArr: HistoryMessage[] = [];
  if (Array.isArray(rawHistory)) historyArr = rawHistory;
  else if (typeof rawHistory === "string") {
    try { historyArr = JSON.parse(rawHistory) ?? []; } catch { historyArr = []; }
  }

  const systemPrompt = buildSystemPrompt(chatContext);
  const messages: Anthropic.MessageParam[] = [
    ...historyArr
      .filter((m) => m && typeof m.content === "string" && m.content.length > 0)
      .map((m) => ({ role: m.role, content: m.content } as Anthropic.MessageParam)),
    { role: "user", content: userMessage },
  ];

  const actionsTaken: Array<{ tool: string; result: unknown }> = [];

  let response = await anthropic.messages.create({
    model:      MODEL_ID,
    max_tokens: MAX_TOKENS,
    system:     systemPrompt,
    messages,
    tools,
  });

  let turns = 0;
  while (response.stop_reason === "tool_use" && turns < MAX_TURNS) {
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const resultJson = await executeTool(block.name, block.input as Record<string, any>);
      let parsed: unknown;
      try { parsed = JSON.parse(resultJson); } catch { parsed = resultJson; }
      actionsTaken.push({ tool: block.name, result: parsed });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: resultJson,
      });
    }

    messages.push({ role: "user", content: toolResults });
    response = await anthropic.messages.create({
      model:      MODEL_ID,
      max_tokens: MAX_TOKENS,
      system:     systemPrompt,
      messages,
      tools,
    });
    turns++;
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    message: text || "(no response)",
    actionsTaken,
  };
};
