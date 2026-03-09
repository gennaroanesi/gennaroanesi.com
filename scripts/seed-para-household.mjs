/**
 * seed-para-household.mjs
 *
 * Populates the shared household PARA vault in S3 with a meaningful
 * starting structure for Gennaro + Cris.
 *
 * Only writes files that don't already exist (HEAD check before PUT).
 *
 * Usage:
 *   node scripts/seed-para-household.mjs
 *
 * Requires AWS credentials with s3:PutObject + s3:HeadObject on gennaroanesi.com.
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const BUCKET = "gennaroanesi.com";
const REGION = "us-east-1";
const TODAY  = new Date().toISOString().slice(0, 10);

const client = new S3Client({ region: REGION });

// ─── helpers ────────────────────────────────────────────────────────────────

async function exists(key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function put(key, body = "", { overwrite = false } = {}) {
  if (!overwrite && await exists(key)) {
    console.log(`  –  skip  ${key}  (already exists)`);
    return;
  }
  await client.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        body,
    ContentType: key.endsWith(".md") ? "text/markdown" : "application/octet-stream",
  }));
  console.log(`  ✓  wrote  ${key}`);
}

// ─── notes ──────────────────────────────────────────────────────────────────

const NOTES = [

  // ── PROJECTS ──────────────────────────────────────────────────────────────

  {
    key: "PARA/Projects/home-para-setup.md",
    body: [
      "# Home PARA Setup",
      "",
      `**Created:** ${TODAY}`,
      "**Status:** Active",
      "**Goal:** A shared, always-synced knowledge base for the household — notes, tasks, trips, house info — accessible from any device for both Gennaro and Cris.",
      "",
      "---",
      "",
      "## Architecture",
      "",
      "### Storage — AWS S3",
      "",
      "All notes live as plain .md files in the `gennaroanesi.com` S3 bucket under the `PARA/` prefix.",
      "",
      "- **Bucket:** `gennaroanesi.com`",
      "- **Region:** `us-east-1`",
      "- **Prefix:** `PARA/`",
      "- **Format:** Plain Markdown — no proprietary format, no lock-in",
      "",
      "S3 is the single source of truth. All clients sync to and from it.",
      "",
      "### Sync — Obsidian LiveSync",
      "",
      "[obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync) keeps every Obsidian client in sync via a self-hosted or remote CouchDB instance.",
      "",
      "> **Note:** LiveSync uses CouchDB as its sync relay, not S3 directly. The S3 bucket stores the canonical plain-file copy; LiveSync handles real-time replication between devices.",
      "",
      "**Clients:**",
      "- Gennaro — Mac (Obsidian desktop)",
      "- Gennaro — iPhone (Obsidian mobile)",
      "- Cris — [her device(s)]",
      "",
      "### Notes App — Obsidian",
      "",
      "[Obsidian](https://obsidian.md) is the editor on all devices. It reads/writes plain .md files — no account required, works offline, syncs via LiveSync when online.",
      "",
      "**Vault structure follows PARA:**",
      "```",
      "PARA/",
      "  Projects/   <- outcomes with a deadline",
      "  Areas/      <- ongoing responsibilities",
      "  Resources/  <- reference material",
      "  Archives/   <- completed or inactive items",
      "```",
      "",
      "### Agent — WhatsApp Bot",
      "",
      "A WhatsApp-connected AI agent (running as an AWS Lambda) can read and write notes, create tasks, query finances, and more — all via chat message. Both Gennaro and Cris can use it from their phones without opening Obsidian.",
      "",
      "- **Inbound:** Twilio WhatsApp webhook → `whatsappAck` Lambda (acks in <1s)",
      "- **Processing:** `whatsappAgent` Lambda — Claude + tools, 120s timeout",
      "- **Confirmation flow:** write actions ask \"confirm?\" before executing",
      "- **Config:** `PARA/Resources/agent-config.md` — edit in Obsidian to change behavior",
      "",
      "---",
      "",
      "## Setup Checklist",
      "",
      "### S3",
      "- [x] Bucket exists (`gennaroanesi.com`)",
      "- [x] `PARA/` prefix scaffolded",
      "- [x] IAM user `obsidian_sync` created with scoped read/write policy",
      "",
      "### LiveSync",
      "- [ ] CouchDB instance provisioned (self-hosted or IBM Cloudant free tier)",
      "- [ ] LiveSync configured on Gennaro's Mac",
      "- [ ] LiveSync configured on Gennaro's iPhone",
      "- [ ] LiveSync configured on Cris's device(s)",
      "",
      "### Agent",
      "- [x] `whatsappAck` + `whatsappAgent` Lambdas deployed",
      "- [ ] `gennaroanesi/agent` secret created in Secrets Manager (Anthropic API key)",
      "- [ ] Twilio WhatsApp number pointed at webhook URL",
      "- [ ] `WEBHOOK_URL` env var set on `whatsappAck` Lambda",
      "",
      "---",
      "",
      "## Notes",
      "",
      "- Plain .md files mean no lock-in — if we ever move away from Obsidian or S3, the notes are just files",
      "- The agent config (`PARA/Resources/agent-config.md`) controls what the agent auto-executes vs. what requires confirmation — edit it in Obsidian",
      "- Archives folder is for anything completed or dormant — keeps active sections clean",
    ].join("\n"),
  },

  {
    key: "PARA/Projects/carpet-removal.md",
    body: `# Carpet Removal

**Created:** ${TODAY}
**Status:** Planning
**Goal:** Replace carpet throughout the house with hard flooring

---

## Scope

- [ ] Decide on replacement material (hardwood / LVP / tile)
- [ ] Measure total sqft per room
- [ ] Get 3 contractor quotes
- [ ] Pick contractor and schedule
- [ ] Move furniture plan
- [ ] Source materials if supplying ourselves
- [ ] Execution day(s)
- [ ] Furniture back + cleanup

## Rooms

| Room | sqft (est) | Priority |
|------|-----------|----------|
|      |           |          |

## Quotes

| Contractor | Date | Amount | Notes |
|------------|------|--------|-------|
|            |      |        |       |

## Notes

`,
  },

  {
    key: "PARA/Projects/wishlist-trips.md",
    body: `# Trips We Want to Take

**Created:** ${TODAY}
**Status:** Ongoing wishlist — move individual trips to their own project when booking

---

## Americas

- [ ] Patagonia (Argentina / Chile) — Torres del Paine, El Chaltén
- [ ] Peru — Machu Picchu + Sacred Valley
- [ ] Colombia — Cartagena + coffee region
- [ ] Canada — Banff / Jasper in fall
- [ ] Alaska — summer, fly-in fishing or hiking

## Europe

- [ ] Amalfi Coast / Positano
- [ ] Sicily — food + volcano + beaches
- [ ] Portugal — Lisbon + Douro Valley wine
- [ ] Croatia — Dubrovnik + islands
- [ ] Scotland — Highlands road trip
- [ ] Basque Country (Spain) — San Sebastián, pintxos, txakoli

## Asia / Pacific

- [ ] Japan — Tokyo + Kyoto + Osaka (cherry blossom or fall)
- [ ] New Zealand — South Island road trip
- [ ] Vietnam — Hanoi to Ho Chi Minh, Ha Long Bay

## Ski / Winter

- [ ] Chamonix / Verbier
- [ ] Whistler
- [ ] Cortina d'Ampezzo

## Notes

`,
  },

  // ── AREAS ─────────────────────────────────────────────────────────────────

  {
    key: "PARA/Areas/home-maintenance.md",
    body: `# Home Maintenance

**Created:** ${TODAY}

---

## Recycling & Trash Schedule

| Day | What goes out |
|-----|---------------|
|     | Recycling (blue bin) |
|     | Trash (black bin) |
|     | Yard waste (green bin) — seasonal |

> Update the days above once you confirm your pickup schedule.

---

## Recurring Chores

### Weekly
- [ ] Vacuum main floor
- [ ] Mop kitchen
- [ ] Clean bathrooms
- [ ] Take out trash / recycling (per schedule above)
- [ ] Wipe counters + stovetop
- [ ] Laundry

### Monthly
- [ ] Clean inside microwave + oven
- [ ] Wipe down fridge shelves
- [ ] Change HVAC filter (check — some are 3-month)
- [ ] Run dishwasher cleaner tablet
- [ ] Clean washing machine drum

### Seasonal
- [ ] HVAC service (spring + fall)
- [ ] Gutter cleaning (fall)
- [ ] Exterior caulking check (fall)
- [ ] Test smoke + CO detectors
- [ ] Deep clean oven

---

## Service Contacts

| Service | Company | Phone / Website | Account # | Notes |
|---------|---------|-----------------|-----------|-------|
| HVAC    |         |                 |           |       |
| Plumber |         |                 |           |       |
| Electrician |     |                 |           |       |
| Lawn / landscaping | |              |           |       |
| Pest control |    |                 |           |       |
| Internet |        |                 |           |       |
| Trash / recycling |  |              |           |       |

`,
  },

  {
    key: "PARA/Areas/finances.md",
    body: `# Finances

**Created:** ${TODAY}

---

## Accounts

| Account | Bank | Type | Notes |
|---------|------|------|-------|
|         |      | Checking | |
|         |      | Savings  | |
|         |      | Credit   | |

## Bills & Subscriptions

| Service | Amount | Due | Auto-pay? |
|---------|--------|-----|-----------|
|         |        |     |           |

## Annual Reminders

- [ ] File taxes (April 15)
- [ ] Review insurance policies (renewal dates)
- [ ] Max out IRA contributions (Dec 31)
- [ ] Review/update beneficiaries

`,
  },

  {
    key: "PARA/Areas/health.md",
    body: `# Health

**Created:** ${TODAY}

---

## Doctors & Providers

| Type | Name | Phone | Notes |
|------|------|-------|-------|
| Primary care |  |  | |
| Dentist       |  |  | |
| Eye doctor    |  |  | |
| Dermatologist |  |  | |

## Annual Checkups

| Checkup | Usually when | Last done |
|---------|-------------|-----------|
| Physical | — | |
| Dental cleaning (×2/yr) | — | |
| Eye exam | — | |

## Medications & Supplements

| Name | Dose | Who | Frequency |
|------|------|-----|-----------|
|      |      |     |           |

`,
  },

  {
    key: "PARA/Areas/pets.md",
    body: `# Pets

**Created:** ${TODAY}

---

> Add your pet(s) below.

## [Pet Name]

**Breed:**
**DOB:**
**Vet:** 
**Vet phone:**

### Vaccines & Preventatives

| Item | Last done | Next due |
|------|-----------|----------|
| Rabies | | |
| DHPP  | | |
| Heartworm test | | |
| Flea/tick (monthly) | | |

### Food

**Brand / formula:**
**Amount:**
**Frequency:**

`,
  },

  // ── RESOURCES ─────────────────────────────────────────────────────────────

  {
    key: "PARA/Resources/people.md",
    body: `# People

**Created:** ${TODAY}

> Names, birthdays, addresses, and notes for people in our lives.

---

## Family

| Name | Birthday | Phone | Notes |
|------|----------|-------|-------|
|      |          |       |       |

## Friends

| Name | Birthday | Phone | City | Notes |
|------|----------|-------|------|-------|
|      |          |       |      |       |

## Gift Ideas

| Person | Idea | Price est | Occasion |
|--------|------|-----------|----------|
|        |      |           |          |

`,
  },

  {
    key: "PARA/Resources/restaurants.md",
    body: `# Restaurants to Visit

**Created:** ${TODAY}

> Running list. Move to a trip project once we're going somewhere specific.

---

## Austin / Local

| Name | Cuisine | Neighborhood | Why we want to go | Visited? |
|------|---------|-------------|-------------------|---------|
|      |         |             |                   |         |

## New York

| Name | Cuisine | Neighborhood | Why we want to go | Visited? |
|------|---------|-------------|-------------------|---------|
|      |         |             |                   |         |

## Chicago

| Name | Cuisine | Neighborhood | Why we want to go | Visited? |
|------|---------|-------------|-------------------|---------|
|      |         |             |                   |         |

## Miami

| Name | Cuisine | Neighborhood | Why we want to go | Visited? |
|------|---------|-------------|-------------------|---------|
|      |         |             |                   |         |

## International

| Name | City | Cuisine | Why we want to go | Visited? |
|------|------|---------|-------------------|---------|
|      |      |         |                   |         |

---

## Already Visited (worth returning)

| Name | City | Cuisine | Notes |
|------|------|---------|-------|
|      |      |         |       |

`,
  },

  {
    key: "PARA/Resources/wines.md",
    body: `# Wines to Taste

**Created:** ${TODAY}

> Bottles, producers, and regions on our radar.

---

## Reds

| Wine | Producer | Region | Vintage | Why | Tried? | Rating |
|------|----------|--------|---------|-----|--------|--------|
| Barolo | | Piedmont, IT | | | | |
| Brunello di Montalcino | | Tuscany, IT | | | | |
| Amarone | | Veneto, IT | | | | |
| Châteauneuf-du-Pape | | Rhône, FR | | | | |
| Burgundy Premier Cru | | Côte de Nuits, FR | | | | |

## Whites

| Wine | Producer | Region | Vintage | Why | Tried? | Rating |
|------|----------|--------|---------|-----|--------|--------|
| Chablis Grand Cru | | Burgundy, FR | | | | |
| Grüner Veltliner | | Wachau, AT | | | | |
| White Burgundy (Meursault) | | Burgundy, FR | | | | |

## Sparkling

| Wine | Producer | Region | Vintage | Why | Tried? | Rating |
|------|----------|--------|---------|-----|--------|--------|
| Champagne | | Champagne, FR | | | | |
| Franciacorta | | Lombardy, IT | | | | |
| Cava | | Penedès, ES | | | | |

## Already Tried & Loved

| Wine | Producer | Region | Vintage | Notes |
|------|----------|--------|---------|-------|
|      |          |        |         |       |

---

## Wine Regions to Explore

- [ ] Douro Valley, Portugal
- [ ] Ribera del Duero, Spain
- [ ] Priorat, Spain
- [ ] Willamette Valley, Oregon
- [ ] Margaret River, Australia
- [ ] Mendoza, Argentina

`,
  },

  {
    key: "PARA/Resources/suppliers.md",
    body: `# Suppliers & Services

**Created:** ${TODAY}

> Vendors, contractors, and services we've used or want to remember.

---

## Home

| Service | Name / Company | Phone | Website | Rating | Notes |
|---------|---------------|-------|---------|--------|-------|
|         |               |       |         |        |       |

## Car

| Service | Name / Company | Phone | Notes |
|---------|---------------|-------|-------|
|         |               |       |       |

## Tech / Subscriptions

| Service | URL | Account email | Renewal | Notes |
|---------|-----|--------------|---------|-------|
|         |     |              |         |       |

## Recurring Deliveries

| Item | Service | Frequency | Notes |
|------|---------|-----------|-------|
|      |         |           |       |

`,
  },

  {
    key: "PARA/Resources/packing-list-ski.md",
    body: `# Packing List — Ski Trip

**Created:** ${TODAY}

> Standard list for ski trips. Copy and adapt per trip.

---

## Carry-On

- [ ] Jeans (1 pair + wearing)
- [ ] T-shirts (2)
- [ ] Underwear (2)
- [ ] Socks (2 pairs)
- [ ] Pajamas
- [ ] Undershirt
- [ ] Heated undershirt
- [ ] Heated gloves
- [ ] Sneakers
- [ ] Stocko / base layers

## Ski Bag

- [ ] Skis ×2
- [ ] Poles ×2
- [ ] Boots ×2
- [ ] Helmets ×2
- [ ] Sling bag
- [ ] Insta360 pole ×2

## Backpack / Tech

- [ ] Epic passes (or printed confirmations)
- [ ] Carv insoles
- [ ] Cardo communicators (charged)
- [ ] Insta360 + batteries + cards
- [ ] Garmin watch
- [ ] Chargers (phone, watch, Cardo, Insta360)

## On The Mountain

- [ ] Ski jacket ×2
- [ ] Ski pants ×2
- [ ] Goggles ×2
- [ ] Gloves ×2 (backup pair)
- [ ] Neck gaiter / balaclava
- [ ] Sunscreen (SPF 50+, altitude)
- [ ] Lip balm

`,
  },

  {
    key: "PARA/Resources/birthdays.md",
    body: `# Birthdays

**Created:** ${TODAY}

> Keep this updated. The agent can remind you when a birthday is coming up.

---

| Name | Birthday | Relationship | Gift ideas |
|------|----------|-------------|------------|
|      |          |             |            |

`,
  },

  // ── NEW: pets, home, cars, docs, emergency, calendar ──────────────────────

  {
    key: "PARA/Areas/pets.md",
    body: `# Pets

**Created:** ${TODAY}

---

## Dolce 🐾

**Breed:** Pomeranian
**DOB:**
**Microchip #:**
**Pet insurance:** (carrier / policy #)

### Vet

| Type | Name | Phone | Address | Notes |
|------|------|-------|---------|-------|
| Regular vet |  |  |  |  |
| Emergency vet |  |  |  | 24h |

### Vaccines & Preventatives

| Item | Last done | Next due |
|------|-----------|----------|
| Rabies | | |
| DHPP | | |
| Bordetella | | |
| Leptospirosis | | |
| Heartworm test | | |
| Flea/tick (monthly) | | |
| Annual wellness exam | | |

### Food

**Brand / formula:**
**Amount per meal:**
**Meals per day:**
**Treats:**
**Allergies / sensitivities:**

### Grooming

**Groomer:**
**Phone:**
**Frequency:** (Pomeranians typically every 6–8 weeks)
**Last appointment:**
**Next appointment:**
**Notes:** (trim style, any sensitivities)

### When We Travel

| Option | Name | Phone | Notes |
|--------|------|-------|-------|
| Pet sitter |  |  |  |
| Boarding |  |  |  |
| Family/friend |  |  |  |

### Notes

`,
  },

  {
    key: "PARA/Areas/appliances.md",
    body: `# Appliances

**Created:** ${TODAY}

> Model and serial numbers live here. Useful when ordering parts, calling for service, or checking warranty.

---

| Appliance | Brand / Model | Serial # | Purchase date | Warranty expires | Last serviced | Notes |
|-----------|--------------|----------|---------------|-----------------|---------------|-------|
| HVAC (main unit) | | | | | | |
| HVAC (air handler) | | | | | | |
| Water heater | | | | | | |
| Refrigerator | | | | | | |
| Washer | | | | | | |
| Dryer | | | | | | |
| Dishwasher | | | | | | |
| Oven / range | | | | | | |
| Microwave | | | | | | |
| Garage door opener | | | | | | |

---

## HVAC Filter

**Filter size:**
**Brand / MERV rating:**
**Change frequency:**
**Last changed:**

## Paint Colors

| Room | Brand | Color name | Color code | Finish | Where to buy |
|------|-------|-----------|------------|--------|--------------|
| Living room | | | | | |
| Kitchen | | | | | |
| Primary bedroom | | | | | |
| Guest bedroom | | | | | |
| Bathrooms | | | | | |
| Exterior | | | | | |

`,
  },

  {
    key: "PARA/Areas/cars.md",
    body: `# Cars

**Created:** ${TODAY}

---

## Car 1

**Make / Model / Year:**
**Color:**
**VIN:**
**Plate:**
**Registration expires:**

### Insurance

**Carrier:**
**Policy #:**
**Agent:**
**Phone:**
**Renews:**

### Service History

| Date | Mileage | Service | Shop | Cost |
|------|---------|---------|------|------|
| | | | | |

### Tires

**Brand:**
**Size:**
**Installed:**
**Mileage at install:**

---

## Car 2

**Make / Model / Year:**
**Color:**
**VIN:**
**Plate:**
**Registration expires:**

### Insurance

**Carrier:**
**Policy #:**
**Agent:**
**Phone:**
**Renews:**

### Service History

| Date | Mileage | Service | Shop | Cost |
|------|---------|---------|------|------|
| | | | | |

### Tires

**Brand:**
**Size:**
**Installed:**
**Mileage at install:**

`,
  },

  {
    key: "PARA/Resources/important-documents.md",
    body: `# Important Documents

**Created:** ${TODAY}

> This note does NOT store sensitive document data — only where physical documents are kept.

---

## Where Things Live

**Safe / lockbox location:**
**Fireproof box location:**
**Digital copies folder:** (e.g. iCloud / Google Drive path)

---

## Document Checklist

| Document | Physical location | Digital copy? | Notes |
|----------|------------------|---------------|-------|
| Passports (both) | | | Expiry: G — / C — |
| Social Security cards | | | |
| Birth certificates | | | |
| Marriage certificate | | | |
| Property deed | | | |
| Mortgage documents | | | |
| Wills / trust | | | |
| Life insurance policies | | | |
| Car titles | | | |
| Tax returns (last 3 yrs) | | | |
| Health insurance cards | | | |

---

## Home Insurance

**Carrier:**
**Policy #:**
**Agent:**
**Phone:**
**Renews:**
**Coverage amount:**

## Life Insurance

| Person | Carrier | Policy # | Beneficiary | Death benefit | Renews |
|--------|---------|----------|-------------|---------------|--------|
| Gennaro | | | | | |
| Cris | | | | | |

`,
  },

  {
    key: "PARA/Resources/home-info.md",
    body: `# Home Info

**Created:** ${TODAY}

> Quick-reference for the house. Fill this in once — you'll need it more than you expect.

---

## Address

**Full address:**
**County:**
**School district:**

## Utilities

| Utility | Provider | Account # | Phone | Website | Auto-pay? |
|---------|---------|-----------|-------|---------|----------|
| Electric | | | | | |
| Gas | | | | | |
| Water | | | | | |
| Internet | | | | | |
| Trash / recycling | | | | | |

## Recycling & Trash Schedule

| Day | What goes out |
|-----|---------------|
| | Trash |
| | Recycling |
| | Yard waste (seasonal) |

## WiFi

| Network | Password | Notes |
|---------|----------|-------|
| Main (2.4GHz) | | |
| Main (5GHz) | | |
| Guest | | |
| IoT | | |

## HOA

**HOA name:**
**Monthly dues:**
**Due date:**
**Management company:**
**Phone:**
**Portal:**
**Rules doc location:**

## Utility Shutoffs

**Water main:** (location in house)
**Gas shutoff:** (location + tool needed)
**Breaker panel:** (location)
**Irrigation shutoff:** (location)

## Key People

| Role | Name | Phone | Notes |
|------|------|-------|-------|
| Neighbor (left) | | | |
| Neighbor (right) | | | |
| HOA contact | | | |
| Property manager (if renting) | | | |

`,
  },

  {
    key: "PARA/Resources/emergency.md",
    body: `# Emergency Reference

**Created:** ${TODAY}

> Print this and put it on the fridge. Also keep it here for the agent to read.

---

## Our Address

**(fill in — for when adrenaline kills memory)**

---

## Emergency Contacts

| Name | Relationship | Phone |
|------|-------------|-------|
| | | |
| | | |

## Medical

**Nearest ER:**
**Address:**
**Phone:**

**Urgent care (non-emergency):**
**Address:**

**Poison Control:** 1-800-222-1222 (US)
**Animal Poison Control (ASPCA):** 1-888-426-4435

## Utility Emergencies

**Gas leak — call:** (utility company + 911)
**Power outage — call:** (electric utility)
**Water main burst — shutoff location:** 

## Shelter in Place

**Go-bag location:**
**Flashlights:**
**First aid kit:**
**3-day water supply:**
**Backup phone charger:**

## Dolce Emergency

**Emergency vet:**
**Phone:**
**Address:**
**Hours:** 24h
**Dolce's microchip #:**
**Dolce's vet records location:**

`,
  },

  {
    key: "PARA/Resources/annual-calendar.md",
    body: `# Annual Calendar

**Created:** ${TODAY}

> Recurring dates worth tracking every year. The agent can remind you of these.

---

## January
- [ ] Review financial goals for the year
- [ ] Check passport expiry dates (renew if <6 months for travel)

## February
- [ ] Valentine's Day (Feb 14)

## March
- [ ] _(add yours)_

## April
- [ ] Tax filing deadline (Apr 15)
- [ ] Review/update beneficiaries on life insurance + retirement accounts

## May
- [ ] Schedule HVAC service (before summer)
- [ ] Mother's Day (2nd Sunday)

## June
- [ ] _(add yours)_

## July
- [ ] Mid-year financial check-in

## August
- [ ] _(add yours)_

## September
- [ ] Schedule HVAC service (before winter)
- [ ] Gutter cleaning

## October
- [ ] Test smoke + CO detectors
- [ ] Check exterior caulking / weatherstripping

## November
- [ ] Max IRA contributions before year-end
- [ ] Holiday travel planning / booking

## December
- [ ] IRA contribution deadline (Dec 31)
- [ ] Year-end financial review
- [ ] Renew anything expiring in January

---

## Fixed Annual Dates

| Event | Date | Notes |
|-------|------|-------|
| Gennaro birthday | | |
| Cris birthday | | |
| Anniversary | | |
| Dolce birthday | | |
| Car 1 registration | | |
| Car 2 registration | | |
| Home insurance renewal | | |
| Life insurance renewal | | |
| HOA dues | | |
| Gennaro passport expiry | | |
| Cris passport expiry | | |

`,
  },

];

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nSeeding household PARA vault → s3://${BUCKET}/PARA/\n`);
  for (const { key, body } of NOTES) {
    await put(key, body);
  }
  console.log(`\nDone. Open Obsidian — LiveSync will replicate to all devices.\n`);
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
