import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { statusEnum } from "./enum";
import { sendNotification } from "../functions/sendNotification/resource";
import { gennaroAgent } from "../functions/gennaroAgent/resource";
import { financeSnapshots } from "../functions/financeSnapshots/resource";

// Reusable location shape — used on both day and event
const locationCustomType = a.customType({
  city: a.string(),
  country: a.string(),
  latitude: a.float(),
  longitude: a.float(),
  timezone: a.string(), // IANA tz, e.g. "America/Chicago"
});

const schema = a.schema({
  // ── Trip ────────────────────────────────────────────────────────────
  // Represents a multi-day trip. Days + events reference trips via tripId.
  trip: a
    .model({
      name: a.string().required(), // "Greece 2026", "Bariloche"
      type: a.enum(["LEISURE", "WORK", "FLYING", "FAMILY"]),
      startDate: a.date().required(), // YYYY-MM-DD
      endDate: a.date().required(), // YYYY-MM-DD
      destination: locationCustomType,
      notes: a.string(),
    })
    .authorization((allow) => [allow.group("admins")]),

  // ── Day ─────────────────────────────────────────────────────────────
  // One record per calendar day, keyed by YYYY-MM-DD.
  day: a
    .model({
      date: a.date().required(), // PK: "2026-09-15"
      status: a.enum(Object.keys(statusEnum)),
      timezone: a.string(), // IANA tz you were in that day
      notes: a.string(),
      location: locationCustomType,
      ptoFraction: a.float().default(0), // 0–1, portion of PTO used
      isWeekend: a.boolean(),
      tripId: a.id(), // FK → trip.id (optional)
      tripName: a.string(), // denormalized for fast display
    })
    .identifier(["date"])
    .authorization((allow) => [allow.group("admins")]),

  // ── Event ───────────────────────────────────────────────────────────
  // Discrete calendar events: flights, appointments, etc.
  event: a
    .model({
      title: a.string().required(),
      description: a.string(),
      startAt: a.datetime().required(), // ISO 8601 UTC
      endAt: a.datetime().required(), // required — no nullable end times
      isAllDay: a.boolean().default(false),
      timezone: a.string(), // IANA tz the event takes place in
      location: locationCustomType,
      url: a.url(), // booking link, hotel, etc.
      tripId: a.id(), // FK → trip.id (optional)
    })
    .authorization((allow) => [allow.group("admins")]),

  // ── Inventory ────────────────────────────────────────────────────────────
  // Base item record — all inventory items share these fields.
  inventoryItem: a
    .model({
      name: a.string().required(),
      brand: a.string(),
      description: a.string(),
      category: a.enum(["FIREARM", "AMMO", "FILAMENT", "INSTRUMENT", "PHOTOGRAPHY", "OTHER"]),
      datePurchased: a.date(),
      vendor: a.string(),
      url: a.url(),
      pricePaid: a.float(), // price per unit
      currency: a.string().default("USD"),
      notes: a.string(),
      imageKeys: a.string().array(), // S3 keys under inventory/{id}/
      active: a.boolean().default(true),
      priceSold: a.float(),
    })
    .authorization((allow) => [allow.group("admins")]),

  // ── Firearm detail ───────────────────────────────────────────────────────
  inventoryFirearm: a
    .model({
      itemId: a.id().required(), // FK → inventoryItem.id
      type: a.enum([
        "HANDGUN",
        "RIFLE",
        "SHOTGUN",
        "SBR",
        "SUPPRESSOR",
        "OTHER",
      ]),
      serialNumber: a.string(),
      caliber: a.string(),
      action: a.string(), // semi-auto, bolt, revolver, etc.
      finish: a.string(),
      barrelLength: a.string(),
      parts: a.ref("FirearmPart").array(),
    })
    .authorization((allow) => [allow.group("admins")]),

  // ── Ammo detail ─────────────────────────────────────────────────────────
  inventoryAmmo: a
    .model({
      itemId: a.id().required(), // FK → inventoryItem.id
      caliber: a.string().required(),
      quantity: a.integer().required(), // number of units purchased
      unit: a.enum(["ROUNDS", "BOX", "CASE"]),
      roundsPerUnit: a.integer(), // rounds per box/case (1 if unit=ROUNDS)
      grain: a.integer(), // bullet weight in grains
      bulletType: a.string(), // FMJ, HP, SP, etc.
      velocityFps: a.integer(),
      roundsAvailable: a.integer(), // current on-hand count (FIFO decremented)
    })
    .authorization((allow) => [allow.group("admins")]),

  // ── Filament detail ──────────────────────────────────────────────────────
  inventoryFilament: a
    .model({
      itemId: a.id().required(), // FK → inventoryItem.id
      material: a.enum([
        "PLA",
        "ABS",
        "PETG",
        "TPU",
        "ASA",
        "NYLON",
        "PC",
        "PLA_CF",
        "PETG_CF",
        "PA",
        "PA_CF",
        "PA6_GF",
        "PVA",
        "HIPS",
        "OTHER",
      ]),
      variant: a.string(), // free-text sub-type: HF, CF, Translucent, Matte, Silk, etc.
      color: a.string(),
      weightG: a.integer(), // spool weight in grams
      diameter: a.enum(["d175", "d285"]),
      quantity: a.integer().default(1), // number of spools
    })
    .authorization((allow) => [allow.group("admins")]),

  // ── Instrument detail ────────────────────────────────────────────────────
  inventoryInstrument: a
    .model({
      itemId: a.id().required(), // FK → inventoryItem.id
      type: a.enum([
        "GUITAR",
        "BASS",
        "AMPLIFIER",
        "PEDAL",
        "KEYBOARD",
        "OTHER",
      ]),
      color: a.string(),
      strings: a.integer(), // number of strings (guitars/basses)
      tuning: a.string(), // standard, drop D, etc.
      bodyMaterial: a.string(),
      finish: a.string(),
      parts: a.ref("InstrumentPart").array(),
    })
    .authorization((allow) => [allow.group("admins")]),

  // ── Photography detail ───────────────────────────────────────────────────
  inventoryPhotography: a
    .model({
      itemId: a.id().required(), // FK → inventoryItem.id
      type: a.enum([
        "CAMERA",
        "LENS",
        "DRONE",
        "GIMBAL",
        "TRIPOD",
        "LIGHT",
        "ACCESSORY",
        "OTHER",
      ]),
      serialNumber: a.string(),
      mount: a.string(),            // E, RF, L, EF, DJI, M4/3, etc.
      sensorFormat: a.string(),     // FF, APS-C, M43, 1", 1/2.3"
      focalLengthMin: a.float(),    // mm
      focalLengthMax: a.float(),    // mm; equal to min for primes
      apertureMax: a.float(),       // f-stop, e.g. 2.8
      stabilized: a.boolean(),
      weightG: a.integer(),
      maxFlightTimeMin: a.integer(), // drones
      subC250g: a.boolean(),         // drones: under FAA 250g registration threshold
    })
    .authorization((allow) => [allow.group("admins")]),

  // ── Flight ───────────────────────────────────────────────────────────────
  // One record per logged flight, sourced from ForeFlight CSV export.
  flight: a
    .model({
      // ── Identity ──────────────────────────────────────────────────
      date: a.date().required(), // YYYY-MM-DD (local departure date)
      from: a.string().required(), // ICAO departure identifier, e.g. "KDVN"
      to: a.string().required(), // ICAO destination identifier
      route: a.string(), // full route string, e.g. "KDVN DVN KCID"

      // ── Aircraft ──────────────────────────────────────────────────
      aircraftId: a.string(), // N-number, e.g. "N12345"
      aircraftType: a.string(), // e.g. "C172", "PA28"

      // ── Times (decimal hours, from ForeFlight) ────────────────────
      totalTime: a.float(), // total flight time
      pic: a.float(), // pilot in command
      sic: a.float(), // second in command
      solo: a.float(),
      night: a.float(),
      actualIMC: a.float(), // actual instrument conditions
      simulatedIMC: a.float(), // under the hood
      crossCountry: a.float(),
      dualReceived: a.float(),
      dualGiven: a.float(),

      // ── Approaches & landings ─────────────────────────────────────
      dayLandings: a.integer(),
      nightLandings: a.integer(),
      approaches: a.integer(), // number of instrument approaches
      approachTypes: a.string(), // free text, e.g. "ILS, RNAV"

      // ── Conditions / classification ───────────────────────────────
      flightType: a.enum([
        "TRAINING",
        "SOLO",
        "CROSS_COUNTRY",
        "CHECKRIDE",
        "INTRO",
        "OTHER",
      ]),
      conditions: a.enum(["VFR", "IFR", "MVFR", "IMC"]),

      // ── Media ─────────────────────────────────────────────────────
      kmlS3Key: a.string(), // S3 key for ForeFlight KML track
      approachChartKeys: a.string().array(), // archived FAA approach chart PDFs (S3 keys)

      // ── Display ───────────────────────────────────────────────────
      title: a.string(), // optional override, e.g. "First Solo!"
      milestone: a.string(), // e.g. "First solo cross-country"
      notes: a.string(), // public-facing narrative
      published: a.boolean().default(false), // false = imported but not shown publicly yet
    })
    .authorization((allow) => [
      allow.publicApiKey().to(["read"]), // fully public read
      allow.group("admins"), // admins can write
    ]),

  // ── FlightMedia ──────────────────────────────────────────────────────────
  // One record per video clip attached to a flight. A flight can have many.
  flightMedia: a
    .model({
      flightId: a.id().required(), // FK → flight.id
      s3Key: a.string().required(), // S3 key under public/flights/videos/{id}.mp4
      kmlOffsetSec: a.float(), // seconds into KML track where video frame 0 occurs
      // positionAt(videoT) = interpolateTrack(track, kmlOffsetSec + videoT)
      // auto-set if video recordedAt + KML timestamps both present
      // manually set via sync UI otherwise; null = unsynced
      camera: a.enum(["RAYBAN", "COCKPIT", "EXTERIOR", "PASSENGER", "OTHER"]),
      label: a.string(), // e.g. "Final approach RWY 18", "Takeoff"
      sortOrder: a.integer().default(0), // controls display order in the UI
      featured: a.boolean().default(false), // show in public highlights reel
    })
    .authorization((allow) => [
      allow.publicApiKey().to(["read"]),
      allow.group("admins"),
    ]),

  // ── FlightAudio ───────────────────────────────────────────────────────────
  // One record per audio clip attached to a flight.
  // Sources: personal cockpit recording, extracted video audio, or LiveATC archive clip.
  // Sync semantics identical to flightMedia: kmlOffsetSec anchors sample 0
  // to a position on the KML track timeline.
  flightAudio: a
    .model({
      // ── Identity ────────────────────────────────────────────────────
      flightId: a.id().required(), // FK → flight.id
      s3Key: a.string().required(), // S3 key under public/flights/audio/{id}.mp3
      sourceType: a.enum(["PERSONAL", "LIVEATC", "COCKPIT_EXTRACTED"]),
      sourceUrl: a.url(), // attribution URL (LiveATC archive link, etc.)
      label: a.string(), // e.g. "KAUS Approach 125.0", "Cockpit intercom"
      frequency: a.string(), // e.g. "125.025" (MHz, ATC tracks only)
      durationSec: a.float(), // populated on upload
      sortOrder: a.integer().default(0),

      // ── Sync ────────────────────────────────────────────────────────
      kmlOffsetSec: a.float(), // seconds into KML track where sample 0 occurs
      recordedAt: a.datetime(), // UTC wall-clock start (drives auto-sync)

      // ── Mix ─────────────────────────────────────────────────────────
      // mixGain: default playback gain in admin preview (0–1).
      // Also used as display priority for captions (higher = foreground) when
      // multiple audio tracks have overlapping segments.
      mixGain: a.float().default(1),

      // ── Transcription state machine ─────────────────────────────────
      // NONE     → no transcription requested yet
      // PENDING  → admin triggered; DynamoDB Stream fires Lambda
      // PROCESSING → Lambda picked it up and is running
      // DONE     → transcript populated
      // FAILED   → transcriptError explains why
      transcriptStatus: a.enum([
        "NONE",
        "PENDING",
        "PROCESSING",
        "DONE",
        "FAILED",
      ]),
      transcriptProgress: a.integer(), // 0–100, updated during PROCESSING
      transcriptError: a.string(), // last error message if FAILED

      // Transcript stored as JSON string:
      // [{ startSec, endSec, speaker: "PILOT"|"ATC"|"UNKNOWN", raw, text }]
      // raw  = Whisper verbatim output
      // text = Claude-corrected output
      transcript: a.string(),
    })
    .authorization((allow) => [
      allow.publicApiKey().to(["read"]),
      allow.group("admins"),
    ]),

  // ── Notification Person ────────────────────────────────────────────────
  // A person who can receive notifications via one or more channels.
  notificationPerson: a
    .model({
      name: a.string().required(),
      email: a.string(),
      phone: a.string(), // E.164 format, e.g. +15125928640
      preferredChannel: a.enum(["SMS", "WHATSAPP", "EMAIL"]),
      active: a.boolean().default(true),
    })
    .authorization((allow) => [allow.group("admins")]),

  // ── Ammo Threshold ────────────────────────────────────────────────────────
  // Alert when a caliber's total roundsAvailable drops below minRounds.
  ammoThreshold: a
    .model({
      caliber: a.string().required(),
      minRounds: a.integer().required(),
      personId: a.id().required(), // FK → notificationPerson.id
      enabled: a.boolean().default(true),
    })
    .authorization((allow) => [allow.group("admins")]),

  // ── Airport ───────────────────────────────────────────────────────────────
  // Sourced from FAA NASR APT_BASE.csv, refreshed every 56 days.
  airport: a
    .model({
      faaId: a.string().required(),
      icaoId: a.string(),
      hasIcao: a.boolean().required(),
      facilityType: a.enum([
        "AIRPORT",
        "HELIPORT",
        "SEAPLANE_BASE",
        "ULTRALIGHT",
        "GLIDERPORT",
        "BALLOONPORT",
      ]),
      facilityUse: a.enum(["PUBLIC", "PRIVATE"]),
      ownershipType: a.enum(["PUBLIC", "PRIVATE", "MILITARY"]),
      name: a.string().required(),
      city: a.string().required(),
      stateCode: a.string().required(),
      stateName: a.string(),
      county: a.string(),
      faaRegion: a.string(),
      sectionalChart: a.string(),
      latDecimal: a.float().required(),
      lonDecimal: a.float().required(),
      elevationFt: a.integer(),
      hasTower: a.boolean(),
      hasAtis: a.boolean(),
      fuelTypes: a.string(),
      airframeRepair: a.enum(["MAJOR", "MINOR", "NONE"]),
      powerplantRepair: a.enum(["MAJOR", "MINOR", "NONE"]),
      hasWeatherStation: a.boolean(),
      beaconType: a.string(),
      hasLandingFee: a.boolean(),
      hasTransientHangar: a.boolean(),
      hasTransientTiedown: a.boolean(),
      contractFuel: a.boolean(),
      airspaceClass: a.enum(["B", "C", "D", "E", "G"]),
      annualGaOperations: a.integer(),
      operationsYear: a.string(),
      nasrSiteNo: a.string().required(),
      nasrCycleDate: a.string().required(),
    })
    .secondaryIndexes((index) => [index("icaoId"), index("faaId")])
    .authorization((allow) => [
      allow.publicApiKey().to(["read"]),
      allow.group("admins"),
    ]),

  // ── InstrumentApproach ────────────────────────────────────────────────────
  // Sourced from FAA d-TPP metafile + NASR, refreshed every 56 days.
  instrumentApproach: a
    .model({
      nasrSiteNo: a.string().required(),
      airportId: a.string().required(),
      procedureName: a.string().required(),
      runway: a.string().required(),
      navType: a.enum([
        "ILS",
        "LPV",
        "LNAV_VNAV",
        "LNAV",
        "LOC",
        "LOC_BC",
        "VOR",
        "VOR_DME",
        "NDB",
        "RNAV",
        "TACAN",
        "VISUAL",
      ]),
      isPrecision: a.boolean().required(),
      suffix: a.string(),
      isCircling: a.boolean().required(),
      straightInDaMsl: a.integer(),
      straightInVisSm: a.float(),
      straightInRvrFt: a.integer(),
      circlingMdaMsl: a.integer(),
      circlingVisSm: a.float(),
      approachLighting: a.string(),
      hasTdzl: a.boolean(),
      hasCl: a.boolean(),
      hasGlideslope: a.boolean(),
      hasLocalizer: a.boolean(),
      dmeRequired: a.boolean(),
      radarRequired: a.boolean(),
      pdfName: a.string(),
      chartCycle: a.string(),
      amdtnum: a.string(),
      amdtdate: a.string(),
      faaAptIdent: a.string(),
      icaoIdent: a.string(),
      nasrCycleDate: a.string().required(),
    })
    .authorization((allow) => [
      allow.publicApiKey().to(["read"]),
      allow.group("admins"),
    ]),

  // ── ApproachProcedure ─────────────────────────────────────────────────────
  // Sourced from FAA CIFP (FAACIFP18), ARINC 424-18 format, updated every 28 days.
  // Each record = one approach procedure (e.g. ILS 13L at KAUS) with its full
  // fix sequence including lat/lon and altitude constraints.
  approachProcedure: a
    .model({
      // Identity
      icao: a.string().required(), // airport ICAO identifier, e.g. "KAUS"
      procedure: a.string().required(), // route identifier, e.g. "I13L"
      transition: a.string(), // transition name, e.g. "BITER" or null for final
      routeType: a.string(), // ARINC route type code
      cycleDate: a.string(), // AIRAC cycle, e.g. "2502"
      // Fix sequence — stored as JSON string (array of fix objects)
      // Each fix: { seq, fixId, pathTerm, role, lat, lon, alt1, alt2 }
      fixes: a.string().required(),
    })
    .secondaryIndexes((index) => [index("icao")])
    .authorization((allow) => [
      allow.publicApiKey().to(["read"]),
      allow.group("admins"),
    ]),

  // ── Finance ───────────────────────────────────────────────────────────────

  financeAccount: a
    .model({
      name: a.string().required(),
      type: a.enum([
        "CHECKING",
        "SAVINGS",
        "BROKERAGE",
        "RETIREMENT",
        "CREDIT",
        "LOAN",
        "CASH",
        "OTHER",
      ]),
      // Only populated when type=RETIREMENT; informational only.
      retirementType: a.enum(["_401K", "TRAD_IRA", "ROTH_IRA", "HSA", "SEP_IRA", "OTHER"]),
      currentBalance: a.float().required().default(0),
      currency: a.string().default("USD"),
      notes: a.string(),
      active: a.boolean().default(true),
      favorite: a.boolean().default(false),   // starred on dashboard; unstarred accounts still accessible from /finance/accounts
      creditLimit: a.float(), // CREDIT accounts only
      statementClosingDay: a.integer(), // CREDIT only: day-of-month (1-31) the statement closes
      apr: a.float(), // CREDIT only: annual percentage rate as decimal (0.2499 for 24.99%)
      apy: a.float(), // SAVINGS only: annual percentage yield as decimal (0.04 for 4%)
    })
    .authorization((allow) => [allow.group("admins")]),

  financeTransaction: a
    .model({
      accountId: a.id().required(), // FK → financeAccount.id
      amount: a.float().required(), // positive = in, negative = out
      type: a.enum(["INCOME", "EXPENSE", "TRANSFER"]),
      category: a.string(),
      description: a.string(),
      date: a.date().required(), // YYYY-MM-DD
      status: a.enum(["POSTED", "PENDING"]), // POSTED affects balance; PENDING is forecast only
      goalId: a.id(), // optional tag → financeSavingsGoal.id
      toAccountId: a.id(), // TRANSFER destination account
      importHash: a.string(), // dedup fingerprint: hash(date+amount+description)
      // Optional link to the financeRecurring rule this tx realizes. Set by
      // the auto-matcher on create or by the user via "Link to rule" action.
      // Never set by the "Post now" flow — that path already advances the
      // rule's nextDate server-side via the rule update.
      recurringId: a.id(),
    })
    .secondaryIndexes((index) => [index("recurringId")])
    .authorization((allow) => [allow.group("admins")]),

  financeRecurring: a
    .model({
      accountId: a.id().required(), // FK → financeAccount.id
      amount: a.float().required(), // positive = income, negative = expense
      type: a.enum(["INCOME", "EXPENSE"]),
      category: a.string(),
      description: a.string().required(),
      cadence: a.enum(["WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "SEMIANNUALLY", "ANNUALLY"]),
      startDate: a.date().required(), // YYYY-MM-DD
      endDate: a.date(),   // YYYY-MM-DD; null = no end (default). Inclusive: last occurrence may land on endDate.
      nextDate: a.date(), // next expected occurrence
      active: a.boolean().default(true),
      goalId: a.id(), // optional tag → financeSavingsGoal.id
      // Optional user-provided substring or /regex/ to match this rule against
      // noisy bank descriptions. When set, the matcher gives a large bonus on
      // hit and treats miss as a disqualifier (see scoreTransactionAgainstRecurring).
      // Examples: "MORTGAGE PMT", "NETFLIX", "/CHASE.*AUTOPAY/i"
      matchPattern: a.string(),
    })
    .authorization((allow) => [allow.group("admins")]),

  financeSavingsGoal: a
    .model({
      name: a.string().required(),
      targetAmount: a.float().required(),
      currentAmount: a.float().required().default(0),
      targetDate: a.date(), // optional deadline
      notes: a.string(),
      // Assumed annual growth rate (decimal, e.g. 0.05 = 5%) used to project required
      // monthly contribution via future-value-of-annuity. Null = use default (5%).
      // Set to 0 for pure-cash goals where compound growth is not realistic.
      expectedAnnualGrowth: a.float(),
    })
    .authorization((allow) => [allow.group("admins")]),

  // ── Goal Funding Source ─────────────────────────────────────
  // Many-to-many mapping: which accounts fund which goals, and in what priority
  // when an account funds multiple goals.
  //
  // Allocation algorithm (see computeGoalAllocations in _shared.tsx):
  // For each account with mappings, iterate its mappings in priority asc order,
  // fill each goal up to its targetAmount, keep remainder as account.surplus.
  // Goals cap at their target — excess never gets silently absorbed.
  //
  // Priority scope: LOWER priority = funded first FROM THIS ACCOUNT.
  // Priority has no cross-account meaning; an account always fills its own
  // mapped goals in its own priority order regardless of other accounts.
  financeGoalFundingSource: a
    .model({
      goalId:    a.id().required(),
      accountId: a.id().required(),
      priority:  a.integer().default(100),
    })
    .secondaryIndexes((idx) => [idx("accountId"), idx("goalId")])
    .authorization((allow) => [allow.group("admins")]),

  // ── Goal Milestone ────────────────────────────────────────────────────────────
  // Checkpoint on the road to a goal. Progress is measured against the parent
  // goal's currentAmount: hit if currentAmount ≥ milestone.targetAmount, missed
  // if past targetDate without hitting, pending otherwise.
  financeGoalMilestone: a
    .model({
      goalId: a.id().required(),
      targetDate: a.date().required(),
      targetAmount: a.float().required(),
      label: a.string(),   // "Emergency cushion", "Down payment ready"
      notes: a.string(),
    })
    .secondaryIndexes((idx) => [idx("goalId")])
    .authorization((allow) => [allow.group("admins")]),

  // ── Loan metadata ─────────────────────────────────────────────────────────
  // One-to-one with a financeAccount of type LOAN. The account holds the
  // ledger (currentBalance = -amount owed); this record holds loan-specific
  // metadata + cached balance + asset/escrow links.
  //
  // currentBalance is cached as: originalPrincipal − Σ(POSTED payment.principal).
  // Drift from lender-stated balance is resolved via a "correction" payment
  // (principal-only adjustment) — see correction banner on loan detail page.
  financeLoan: a
    .model({
      accountId: a.id().required(),
      loanType: a.enum(["MORTGAGE", "AUTO", "STUDENT", "PERSONAL", "HELOC", "OTHER"]),
      originalPrincipal: a.float().required(),
      currentBalance: a.float().required().default(0),   // cached; recomputed on payment post/edit/delete
      interestRate: a.float().required(),                // annual APR as decimal, e.g. 0.045 for 4.5%
      termMonths: a.integer().required(),                // total loan length, e.g. 360
      startDate: a.date().required(),                    // origination
      firstPaymentDate: a.date().required(),             // first scheduled payment
      paymentStrategy: a.enum(["PRICE_FIXED_PAYMENT", "PRICE_FIXED_TERM"]),
      assetId: a.id(),                                   // optional FK to financeAsset (mortgage → house, auto → car)
      escrowAccountId: a.id(),                           // optional FK to financeAccount (future v2 wiring)
      lender: a.string(),
      notes: a.string(),
    })
    .secondaryIndexes((idx) => [idx("accountId")])
    .authorization((allow) => [allow.group("admins")]),

  // ── Loan Payment ──────────────────────────────────────────────────────
  // One record per payment (scheduled or posted). Scheduled payments are
  // projections from amortization — they have amounts populated but status=
  // SCHEDULED means they don't affect balance or generate transactions.
  // On post, the user confirms/edits the split, status flips to POSTED, and
  // three transactions are written atomically: expense on checking, income on
  // loan account, payment record itself.
  financeLoanPayment: a
    .model({
      loanId: a.id().required(),
      status: a.enum(["SCHEDULED", "POSTED"]),
      date: a.date().required(),                         // scheduled date (or actual post date)
      sequenceNumber: a.integer(),                        // 1..termMonths for scheduled rows; null for ad-hoc extras
      totalAmount: a.float().required(),                  // total $ leaving checking
      principal: a.float().required(),                    // portion reducing loan balance
      interest: a.float().required(),                     // portion paid to bank
      escrow: a.float(),                                  // optional escrow impound
      fees: a.float(),                                    // optional one-off fees
      isCorrection: a.boolean().default(false),          // true for principal-only reconciliation adjustments
      isExtraPayment: a.boolean().default(false),        // true for ad-hoc extra principal payments outside schedule
      transactionId: a.id(),                              // FK to financeTransaction (on checking side, set when posted)
      loanTransactionId: a.id(),                          // FK to financeTransaction (on loan account, set when posted)
      notes: a.string(),
    })
    .secondaryIndexes((idx) => [idx("loanId")])
    .authorization((allow) => [allow.group("admins")]),

  // ── Asset ─────────────────────────────────────────────────────────────
  // Non-financial holdings (house, car, collectibles) whose value comes from
  // appraisal/market, not from a transaction ledger. Contribute to net worth.
  // Loans (future) can FK to an asset via loan.assetId to compute equity.
  financeAsset: a
    .model({
      name: a.string().required(),                 // "Primary home", "2019 Honda Civic"
      type: a.enum(["REAL_ESTATE", "VEHICLE", "COLLECTIBLE", "OTHER"]),
      purchaseValue: a.float(),                    // original cost (optional)
      currentValue: a.float().required().default(0),
      purchaseDate: a.date(),
      notes: a.string(),
      active: a.boolean().default(true),           // sold/disposed = inactive
    })
    .authorization((allow) => [allow.group("admins")]),

  // ── Holding Lot ─────────────────────────────────────────────────────────────
  // One record per purchase lot of a ticker in a brokerage account.
  // Aggregated per ticker in the UI via tickerAggregate().
  // Account total value = currentBalance (cash) + Σ(lot.quantity * quote.price).
  financeHoldingLot: a
    .model({
      accountId: a.id().required(),          // FK → financeAccount.id (must be type=BROKERAGE)
      ticker: a.string().required(),         // "VOO", "AAPL", "SWPPX"
      assetType: a.enum([
        "STOCK",
        "ETF",
        "MUTUAL_FUND",
        "CRYPTO",
        "BOND",
        "OTHER",
      ]),
      quantity: a.float().required(),        // # of shares/units in this lot
      costBasis: a.float(),                  // total $ paid for this lot (optional)
      purchaseDate: a.date(),                // when this lot was acquired (optional)
      notes: a.string(),
    })
    .secondaryIndexes((index) => [index("accountId"), index("ticker")])
    .authorization((allow) => [allow.group("admins")]),

  // ── Ticker Quote ───────────────────────────────────────────────────────────
  // Last known market price per ticker. Single row per ticker (PK = ticker).
  // Refresh loop upserts these; lot records join in memory for market value.
  financeTickerQuote: a
    .model({
      ticker: a.string().required(),         // PK
      price: a.float(),
      currency: a.string(),
      fetchedAt: a.datetime(),
      source: a.string(),                    // "yahoo" for now
    })
    .identifier(["ticker"])
    .authorization((allow) => [allow.group("admins")]),

  // ── Account daily snapshot ────────────────────────────────────────────────
  // One row per (accountId, date). Captured daily by the financeSnapshots
  // Lambda (6 AM Central ~ 11 UTC). Inflow/outflow are neutral terms that
  // work for both checking (wages in / rent out) and credit cards (payment
  // in / charges out). Snapshots are derived — never user-edited. If a
  // transaction is back-dated, the next cron run overwrites the affected row
  // (upsert by accountId+date).
  financeAccountSnapshot: a
    .model({
      accountId:            a.id().required(),          // FK → financeAccount.id
      date:                 a.date().required(),        // YYYY-MM-DD (America/Chicago local)
      balance:              a.float().required(),       // account.currentBalance at capture time
      inflow:               a.float().default(0),       // Σ positive-amount POSTED tx on this date
      outflow:              a.float().default(0),       // |Σ negative-amount POSTED tx| on this date
      txCount:              a.integer().default(0),     // POSTED tx count for this date
      largestTxAmount:      a.float(),                  // signed amount of max-|tx| that day
      largestTxDescription: a.string(),                 // description of that tx (for tooltip)
      capturedAt:           a.datetime().required(),    // actual wall-clock capture time
    })
    .secondaryIndexes((index) => [
      index("accountId").sortKeys(["date"]),            // "last N days for account X"
    ])
    .authorization((allow) => [allow.group("admins")]),

  // ── Task ──────────────────────────────────────────────────────────────────
  // Actionable items for the household agent. Structured (vs. PARA notes which
  // are freeform markdown). Notifications fire on overdue/upcoming tasks.
  task: a
    .model({
      title: a.string().required(),
      notes: a.string(), // inline detail; longer context lives in projectRef note
      dueDate: a.date(), // YYYY-MM-DD; null = no deadline
      done: a.boolean().default(false),
      doneAt: a.datetime(), // set when done flips to true
      priority: a.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
      assignedTo: a.id(), // FK → notificationPerson.id; null = unassigned
      projectRef: a.string(), // S3 key of related PARA note, e.g. "PARA/Projects/ir-checkride.md"
      tags: a.string().array(), // free-form tags: ["home", "flying", "finance"]
      recurrence: a.string(), // iCal RRULE string; null = one-off
      snoozedUntil: a.datetime(), // agent can snooze a task
      source: a.enum(["MANUAL", "AGENT", "IMPORT"]),
    })
    .secondaryIndexes((index) => [index("dueDate"), index("assignedTo")])
    .authorization((allow) => [allow.group("admins")]),

  // ── Gennaro agent conversation log ───────────────────────────────────────
  // Persistent chat history for the assistant UI. The Lambda itself is
  // stateless — the frontend reads/writes these tables to build the history
  // array it passes to invokeGennaroAgent each turn.
  //
  // Messages link to conversations via a plain conversationId FK (no
  // hasMany/belongsTo) — the overall schema is deep enough that relational
  // types trip TypeScript's "excessively deep" limiter. Secondary index on
  // conversationId keeps listing messages for a conversation O(1).
  gennaroAgentConversation: a
    .model({
      title:  a.string(),
      pinned: a.boolean().default(false),
    })
    .authorization((allow) => [allow.group("admins")]),

  gennaroAgentConversationMessage: a
    .model({
      conversationId: a.id().required(),
      role:           a.enum(["user", "assistant"]),
      content:        a.string().required(),
      actionsTaken:   a.json(), // [{tool, result}] from tool calls this turn
    })
    .secondaryIndexes((index) => [index("conversationId")])
    .authorization((allow) => [allow.group("admins")]),

  gennaroAgentAction: a.customType({
    tool:   a.string().required(),
    result: a.json(),
  }),

  gennaroAgentResponse: a.customType({
    message:      a.string().required(),
    actionsTaken: a.ref("gennaroAgentAction").array(),
  }),

  invokeGennaroAgent: a
    .mutation()
    .authorization((allow) => [allow.group("admins")])
    .arguments({
      message:     a.string().required(),
      history:     a.json(), // [{role: "user"|"assistant", content: string}]
      chatContext: a.json(), // optional frontend page state (currentPath, filters, …)
    })
    .returns(a.ref("gennaroAgentResponse"))
    .handler(a.handler.function(gennaroAgent)),

  // ── testNotification mutation ──────────────────────────────────────────
  // Invokes sendNotification directly so the UI can test delivery without
  // needing to trigger the ammo threshold flow.
  testNotification: a
    .mutation()
    .arguments({
      personId: a.id().required(),
      message: a.string(), // optional override; defaults to a canned test message
    })
    .returns(a.customType({ ok: a.boolean(), error: a.string() }))
    .authorization((allow) => [allow.group("admins")])
    .handler(a.handler.function(sendNotification)),

  // ── Custom types ─────────────────────────────────────────────────────────
  FirearmPart: a.customType({
    name: a.string().required(),
    brand: a.string(),
    installedDate: a.date(),
    notes: a.string(),
  }),

  InstrumentPart: a.customType({
    name: a.string().required(),
    brand: a.string(),
    type: a.enum([
      "TUBES",
      "BRIDGE",
      "PICKUPS",
      "TUNERS",
      "STRINGS",
      "NUT",
      "STRAP",
      "CASE",
      "OTHER",
    ]),
    notes: a.string(),
  }),
})
.authorization((allow) => [
  allow.resource(gennaroAgent),
  allow.resource(financeSnapshots),
]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
    apiKeyAuthorizationMode: {
      expiresInDays: 365, // public read key for the flights page
    },
  },
});
