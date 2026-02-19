import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { statusEnum } from "./enum";

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
  });

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
