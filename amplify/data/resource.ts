import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { statusEnum } from "./enum";
import { sendNotification } from "../functions/sendNotification/resource";

// Reusable location shape — used on both day and event
const locationCustomType = a.customType({
  city: a.string(),
  country: a.string(),
  latitude: a.float(),
  longitude: a.float(),
  timezone: a.string(), // IANA tz, e.g. "America/Chicago"
});

const schema = a
  .schema({
    // ── Trip ────────────────────────────────────────────────────────────
    // Represents a multi-day trip. Days + events reference trips via tripId.
    trip: a
      .model({
        name: a.string().required(),        // "Greece 2026", "Bariloche"
        type: a.enum(["LEISURE", "WORK", "FLYING", "FAMILY"]),
        startDate: a.date().required(),      // YYYY-MM-DD
        endDate: a.date().required(),        // YYYY-MM-DD
        destination: locationCustomType,
        notes: a.string(),
      })
      .authorization((allow) => [allow.group("admins")]),

    // ── Day ─────────────────────────────────────────────────────────────
    // One record per calendar day, keyed by YYYY-MM-DD.
    day: a
      .model({
        date: a.date().required(),           // PK: "2026-09-15"
        status: a.enum(Object.keys(statusEnum)),
        timezone: a.string(),                // IANA tz you were in that day
        notes: a.string(),
        location: locationCustomType,
        ptoFraction: a.float().default(0),   // 0–1, portion of PTO used
        isWeekend: a.boolean(),
        tripId: a.id(),                      // FK → trip.id (optional)
        tripName: a.string(),                // denormalized for fast display
      })
      .identifier(["date"])
      .authorization((allow) => [allow.group("admins")]),

    // ── Event ───────────────────────────────────────────────────────────
    // Discrete calendar events: flights, appointments, etc.
    event: a
      .model({
        title: a.string().required(),
        description: a.string(),
        startAt: a.datetime().required(),    // ISO 8601 UTC
        endAt: a.datetime().required(),      // required — no nullable end times
        isAllDay: a.boolean().default(false),
        timezone: a.string(),                // IANA tz the event takes place in
        location: locationCustomType,
        url: a.url(),                        // booking link, hotel, etc.
        tripId: a.id(),                      // FK → trip.id (optional)
      })
      .authorization((allow) => [allow.group("admins")]),

    // ── Inventory ────────────────────────────────────────────────────────────
    // Base item record — all inventory items share these fields.
    inventoryItem: a
      .model({
        name:          a.string().required(),
        brand:         a.string(),
        description:   a.string(),
        category:      a.enum(["FIREARM", "AMMO", "FILAMENT", "INSTRUMENT", "OTHER"]),
        datePurchased: a.date(),
        vendor:        a.string(),
        url:           a.url(),
        pricePaid:     a.float(),            // price per unit
        currency:      a.string().default("USD"),
        notes:         a.string(),
        imageKeys:     a.string().array(),   // S3 keys under inventory/{id}/
      })
      .authorization((allow) => [allow.group("admins")]),

    // ── Firearm detail ───────────────────────────────────────────────────────
    inventoryFirearm: a
      .model({
        itemId:       a.id().required(),     // FK → inventoryItem.id
        type:         a.enum(["HANDGUN", "RIFLE", "SHOTGUN", "SBR", "SUPPRESSOR", "OTHER"]),
        serialNumber: a.string(),
        caliber:      a.string(),
        action:       a.string(),            // semi-auto, bolt, revolver, etc.
        finish:       a.string(),
        barrelLength: a.string(),
        parts:        a.ref("FirearmPart").array(),
      })
      .authorization((allow) => [allow.group("admins")]),

    // ── Ammo detail ─────────────────────────────────────────────────────────
    inventoryAmmo: a
      .model({
        itemId:          a.id().required(),     // FK → inventoryItem.id
        caliber:         a.string().required(),
        quantity:        a.integer().required(), // number of units purchased
        unit:            a.enum(["ROUNDS", "BOX", "CASE"]),
        roundsPerUnit:   a.integer(),           // rounds per box/case (1 if unit=ROUNDS)
        grain:           a.integer(),           // bullet weight in grains
        bulletType:      a.string(),            // FMJ, HP, SP, etc.
        velocityFps:     a.integer(),
        roundsAvailable: a.integer(),           // current on-hand count (FIFO decremented)
      })
      .authorization((allow) => [allow.group("admins")]),

    // ── Filament detail ──────────────────────────────────────────────────────
    inventoryFilament: a
      .model({
        itemId:    a.id().required(),        // FK → inventoryItem.id
        material:  a.enum(["PLA", "ABS", "PETG", "TPU", "ASA", "NYLON", "PC", "PLA_CF", "PETG_CF", "PA", "PA_CF", "PA6_GF", "PVA", "HIPS", "OTHER"]),
        variant:   a.string(),               // free-text sub-type: HF, CF, Translucent, Matte, Silk, etc.
        color:     a.string(),
        weightG:   a.integer(),              // spool weight in grams
        diameter:  a.enum(["d175", "d285"]),
      })
      .authorization((allow) => [allow.group("admins")]),

    // ── Instrument detail ────────────────────────────────────────────────────
    inventoryInstrument: a
      .model({
        itemId:       a.id().required(),     // FK → inventoryItem.id
        type:         a.enum(["GUITAR", "BASS", "AMPLIFIER", "PEDAL", "KEYBOARD", "OTHER"]),
        color:        a.string(),
        strings:      a.integer(),           // number of strings (guitars/basses)
        tuning:       a.string(),            // standard, drop D, etc.
        bodyMaterial: a.string(),
        finish:       a.string(),
      })
      .authorization((allow) => [allow.group("admins")]),

    // ── Notification Person ────────────────────────────────────────────────
    // A person who can receive notifications via one or more channels.
    notificationPerson: a
      .model({
        name:             a.string().required(),
        email:            a.string(),
        phone:            a.string(),           // E.164 format, e.g. +15125928640
        preferredChannel: a.enum(["SMS", "WHATSAPP", "EMAIL"]),
        active:           a.boolean().default(true),
      })
      .authorization((allow) => [allow.group("admins")]),

    // ── Ammo Threshold ────────────────────────────────────────────────────────
    // Alert when a caliber's total roundsAvailable drops below minRounds.
    ammoThreshold: a
      .model({
        caliber:    a.string().required(),
        minRounds:  a.integer().required(),
        personId:   a.id().required(),          // FK → notificationPerson.id
        enabled:    a.boolean().default(true),
      })
      .authorization((allow) => [allow.group("admins")]),

    // ── testNotification mutation ──────────────────────────────────────────
    // Invokes sendNotification directly so the UI can test delivery without
    // needing to trigger the ammo threshold flow.
    testNotification: a
      .mutation()
      .arguments({
        personId: a.id().required(),
        message:  a.string(),            // optional override; defaults to a canned test message
      })
      .returns(a.customType({ ok: a.boolean(), error: a.string() }))
      .authorization((allow) => [allow.group("admins")])
      .handler(a.handler.function(sendNotification)),

    // ── Custom types ─────────────────────────────────────────────────────────
    FirearmPart: a.customType({
      name:          a.string().required(),
      brand:         a.string(),
      installedDate: a.date(),
      notes:         a.string(),
    }),
  });

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
