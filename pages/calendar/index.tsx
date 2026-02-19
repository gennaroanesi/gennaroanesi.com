import React, { useEffect, useState, useCallback, useRef } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import { Calendar, dayjsLocalizer, Views } from "react-big-calendar";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import type { Schema } from "@/amplify/data/resource";
import DefaultLayout from "@/layouts/default";
import { APIProvider, useMapsLibrary } from "@vis.gl/react-google-maps";

dayjs.extend(utc);
dayjs.extend(timezone);

const localizer = dayjsLocalizer(dayjs);
const client = generateClient<Schema>();

// ── Types ────────────────────────────────────────────────────────────────────

type DayRecord  = Schema["day"]["type"];
type TripRecord = Schema["trip"]["type"];
type EventRecord = Schema["event"]["type"];

type StatusKey =
  | "WORKING_HOME"
  | "WORKING_OFFICE"
  | "TRAVEL"
  | "VACATION"
  | "WEEKEND_HOLIDAY"
  | "PTO"
  | "CHOICE_DAY";

type TripType = "LEISURE" | "WORK" | "FLYING" | "FAMILY";

// Discriminated union so TypeScript knows which panel is open
type PanelState =
  | { kind: "day";      record: DayRecord }
  | { kind: "trip";     record: TripRecord }
  | { kind: "newTrip";  startDate: string; endDate: string }
  | { kind: "event";    record: EventRecord }
  | { kind: "newEvent"; date: string; startTime: string; endTime: string }
  | null;

// react-big-calendar event shape
interface RbcEvent {
  title: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  resource: { kind: "trip"; trip: TripRecord } | { kind: "event"; event: EventRecord };
}

// ── Config ───────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<StatusKey, { label: string; bg: string; text: string }> = {
  WORKING_HOME:    { label: "Working (home)",   bg: "#3D3D52", text: "#ffffff" },
  WORKING_OFFICE:  { label: "Working (office)", bg: "#587D71", text: "#ffffff" },
  TRAVEL:          { label: "Travel",            bg: "#DEBA02", text: "#323243" },
  VACATION:        { label: "Vacation",          bg: "#BCABAE", text: "#323243" },
  WEEKEND_HOLIDAY: { label: "Weekend/Holiday",   bg: "#2a2a3a", text: "#888899" },
  PTO:             { label: "PTO",               bg: "#8B5CF6", text: "#ffffff" },
  CHOICE_DAY:      { label: "Choice Day",        bg: "#EC4899", text: "#ffffff" },
};

const TRIP_TYPE_CONFIG: Record<TripType, { label: string; color: string }> = {
  LEISURE: { label: "Leisure",  color: "#DEBA02" },
  WORK:    { label: "Work",     color: "#587D71" },
  FLYING:  { label: "Flying",   color: "#60A5FA" },
  FAMILY:  { label: "Family",   color: "#EC4899" },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

// Convert a trip record into an all-day banner event for react-big-calendar
function tripToRbcEvent(trip: TripRecord): RbcEvent {
  const color = TRIP_TYPE_CONFIG[trip.type as TripType]?.color ?? "#BCABAE";
  return {
    title: trip.name,
    start: dayjs(trip.startDate).toDate(),
    // RBC end date for all-day is exclusive — add one day so the last day is included
    end: dayjs(trip.endDate).add(1, "day").toDate(),
    allDay: true,
    resource: { kind: "trip", trip },
  };
}

// Convert a timed event record into an RBC event
function eventToRbcEvent(event: EventRecord): RbcEvent {
  const tz = event.timezone ?? "America/Chicago";
  return {
    title: event.title,
    start: dayjs(event.startAt).tz(tz).toDate(),
    end:   dayjs(event.endAt).tz(tz).toDate(),
    allDay: event.isAllDay ?? false,
    resource: { kind: "event", event },
  };
}

// ── Input / Label shared styles ───────────────────────────────────────────────

const inputCls =
  "w-full border rounded px-2 py-1.5 text-sm dark:bg-purple dark:text-rose dark:border-gray-600 bg-white text-gray-800 border-gray-300";
const labelCls =
  "text-xs uppercase tracking-widest text-gray-500 dark:text-gray-400 mb-1 block";

// ── Component ────────────────────────────────────────────────────────────────

export default function CalendarPage() {
  const { authState } = useRequireAuth();

  // ── State ──────────────────────────────────────────────────────────────────
  const [days,   setDays]   = useState<Map<string, DayRecord>>(new Map());
  const [trips,  setTrips]  = useState<TripRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [panel, setPanel] = useState<PanelState>(null);
  const [saving, setSaving] = useState(false);

  // ── Fetch trips + events once (only when authenticated) ────────────────────
  useEffect(() => {
    if (authState !== "authenticated") return;
    client.models.trip.list({ limit: 500 }).then(({ data }) =>
      setTrips(data ?? [])
    );
    client.models.event.list({ limit: 500 }).then(({ data }) =>
      setEvents(data ?? [])
    );
  }, [authState]);

  // ── Fetch days for visible month range ────────────────────────────────────
  const fetchDays = useCallback(async (centerDate: Date) => {
    setLoading(true);
    try {
      const start = dayjs(centerDate).subtract(1, "month").startOf("month").format("YYYY-MM-DD");
      const end   = dayjs(centerDate).add(1, "month").endOf("month").format("YYYY-MM-DD");

      const { data, errors } = await client.models.day.list({
        filter: { and: [{ date: { ge: start } }, { date: { le: end } }] },
        limit: 200,
      });

      if (errors) console.error(errors);

      // Store as a Map keyed by date string for O(1) lookup in dayPropGetter
      const map = new Map<string, DayRecord>();
      (data ?? []).forEach((d) => map.set(d.date, d));
      setDays(map);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchDays(currentDate);
  }, [currentDate, fetchDays, authState]);

  // ── Derived: merge trips + timed events into one RBC events array ──────────
  const rbcEvents: RbcEvent[] = [
    ...trips.map(tripToRbcEvent),
    ...events.map(eventToRbcEvent),
  ];

  // ── Day cell background (replaces event boxes for day status) ─────────────
  const dayPropGetter = useCallback(
    (date: Date) => {
      const dateStr = dayjs(date).format("YYYY-MM-DD");
      const day = days.get(dateStr);
      if (!day?.status) return {};
      const config = STATUS_CONFIG[day.status as StatusKey];
      if (!config) return {};
      return {
        style: {
          backgroundColor: config.bg,
          color: config.text,
          opacity: 0.85,
        },
      };
    },
    [days]
  );

  // ── Event (banner/box) styling ─────────────────────────────────────────────
  const eventPropGetter = useCallback((event: RbcEvent) => {
    if (event.resource.kind === "trip") {
      const color = TRIP_TYPE_CONFIG[event.resource.trip.type as TripType]?.color ?? "#BCABAE";
      return {
        style: {
          backgroundColor: color,
          color: "#323243",
          border: "none",
          borderRadius: "3px",
          fontWeight: 600,
          fontSize: "0.72rem",
          padding: "1px 6px",
          opacity: 0.95,
        },
      };
    }
    // Timed event
    return {
      style: {
        backgroundColor: "#323243",
        color: "#BCABAE",
        border: "1px solid #BCABAE",
        borderRadius: "3px",
        fontSize: "0.72rem",
        padding: "1px 4px",
      },
    };
  }, []);

  // ── Slot (empty cell) click → open day editor ──────────────────────────────
  const handleSelectSlot = useCallback(
    ({ start, end, action }: { start: Date; end: Date; action: string }) => {
      // "select" fires when dragging across multiple days — open new trip dialog
      if (action === "select") {
        const startStr = dayjs(start).format("YYYY-MM-DD");
        const endStr   = dayjs(end).subtract(1, "day").format("YYYY-MM-DD"); // RBC end is exclusive
        if (startStr !== endStr) {
          setPanel({ kind: "newTrip", startDate: startStr, endDate: endStr });
          return;
        }
      }
      // Single day click → day editor
      const dateStr = dayjs(start).format("YYYY-MM-DD");
      const existing = days.get(dateStr);
      setPanel({
        kind: "day",
        record: existing ?? ({
          date: dateStr,
          status: [0, 6].includes(start.getDay()) ? "WEEKEND_HOLIDAY" : "WORKING_HOME",
          timezone: "America/Chicago",
          notes: null,
          location: null,
          ptoFraction: 0,
          isWeekend: [0, 6].includes(start.getDay()),
          tripId: null,
          tripName: null,
        } as unknown as DayRecord),
      });
    },
    [days]
  );

  // ── Event click → trip editor or event editor ──────────────────────────────
  const handleSelectEvent = useCallback((event: RbcEvent) => {
    if (event.resource.kind === "trip") {
      setPanel({ kind: "trip", record: event.resource.trip });
    } else {
      setPanel({ kind: "event", record: event.resource.event });
    }
  }, []);

  // ── Double-click a day cell → new event ───────────────────────────────────
  const handleDoubleClickSlot = useCallback(
    ({ start }: { start: Date }) => {
      const date     = dayjs(start).format("YYYY-MM-DD");
      const startTime = dayjs(start).format("HH:mm");
      const endTime   = dayjs(start).add(1, "hour").format("HH:mm");
      setPanel({ kind: "newEvent", date, startTime, endTime });
    },
    []
  );

  // ── Save day ───────────────────────────────────────────────────────────────
  const handleSaveDay = async (record: DayRecord) => {
    setSaving(true);
    try {
      const { errors } = await client.models.day.update({
        date:         record.date,
        status:       record.status,
        timezone:     record.timezone ?? "America/Chicago",
        notes:        record.notes ?? null,
        tripId:       record.tripId ?? null,
        tripName:     record.tripName ?? null,
        ptoFraction:  record.ptoFraction ?? 0,
        location:     record.location ?? null,
      });
      if (errors) { console.error(errors); return; }
      setDays((prev) => new Map(prev).set(record.date, record));
      setPanel(null);
    } finally {
      setSaving(false);
    }
  };

  // ── Save trip (update) ─────────────────────────────────────────────────────
  const handleSaveTrip = async (record: TripRecord) => {
    setSaving(true);
    try {
      const { errors } = await client.models.trip.update({
        id:          record.id,
        name:        record.name,
        type:        record.type,
        startDate:   record.startDate,
        endDate:     record.endDate,
        destination: record.destination ?? null,
        notes:       record.notes ?? null,
      });
      if (errors) { console.error(errors); return; }
      setTrips((prev) => prev.map((t) => (t.id === record.id ? record : t)));
      setPanel(null);
    } finally {
      setSaving(false);
    }
  };

  // ── Create new trip ────────────────────────────────────────────────────────
  const handleCreateTrip = async (
    draft: { name: string; type: string; startDate: string; endDate: string; notes: string }
  ) => {
    setSaving(true);
    try {
      const { data, errors } = await client.models.trip.create({
        name:      draft.name,
        type:      draft.type as TripType,
        startDate: draft.startDate,
        endDate:   draft.endDate,
        notes:     draft.notes || null,
      });
      if (errors) { console.error(errors); return; }
      if (data) setTrips((prev) => [...prev, data]);
      setPanel(null);
    } finally {
      setSaving(false);
    }
  };

  // ── Create event ───────────────────────────────────────────────────────────
  const handleCreateEvent = async (draft: {
    title: string; description: string; date: string;
    startTime: string; endTime: string; isAllDay: boolean;
    timezone: string; url: string; notes: string;
    city: string; country: string; tripId: string;
  }) => {
    setSaving(true);
    const tz = draft.timezone || "America/Chicago";
    const trip = trips.find((t) => t.id === draft.tripId);
    try {
      const startAt = draft.isAllDay
        ? dayjs.tz(`${draft.date}T00:00:00`, tz).toISOString()
        : dayjs.tz(`${draft.date}T${draft.startTime}:00`, tz).toISOString();
      const endAt = draft.isAllDay
        ? dayjs.tz(`${draft.date}T23:59:59`, tz).toISOString()
        : dayjs.tz(`${draft.date}T${draft.endTime}:00`, tz).toISOString();

      const { data, errors } = await client.models.event.create({
        title:       draft.title,
        description: draft.description || null,
        startAt,
        endAt,
        isAllDay:    draft.isAllDay,
        timezone:    tz,
        url:         draft.url || null,
        location:    (draft.city || draft.country) ? { city: draft.city || null, country: draft.country || null } : null,
        tripId:      draft.tripId || null,
      });
      if (errors) { console.error(errors); return; }
      if (data) setEvents((prev) => [...prev, data]);
      setPanel(null);
    } finally {
      setSaving(false);
    }
  };

  // ── Update event ───────────────────────────────────────────────────────────
  const handleSaveEvent = async (record: EventRecord) => {
    setSaving(true);
    try {
      const { errors } = await client.models.event.update({
        id:          record.id,
        title:       record.title,
        description: record.description ?? null,
        startAt:     record.startAt,
        endAt:       record.endAt,
        isAllDay:    record.isAllDay ?? false,
        timezone:    record.timezone ?? "America/Chicago",
        url:         record.url ?? null,
        location:    record.location ?? null,
        tripId:      record.tripId ?? null,
      });
      if (errors) { console.error(errors); return; }
      setEvents((prev) => prev.map((e) => (e.id === record.id ? record : e)));
      setPanel(null);
    } finally {
      setSaving(false);
    }
  };

  // ── Delete event ───────────────────────────────────────────────────────────
  const handleDeleteEvent = async (id: string) => {
    if (!confirm("Delete this event?")) return;
    setSaving(true);
    try {
      await client.models.event.delete({ id });
      setEvents((prev) => prev.filter((e) => e.id !== id));
      setPanel(null);
    } finally {
      setSaving(false);
    }
  };

  // ── Delete trip ────────────────────────────────────────────────────────────
  const handleDeleteTrip = async (id: string) => {
    if (!confirm("Delete this trip? The days will keep their status but lose the trip link.")) return;
    setSaving(true);
    try {
      await client.models.trip.delete({ id });
      setTrips((prev) => prev.filter((t) => t.id !== id));
      setPanel(null);
    } finally {
      setSaving(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  // Don't render anything while auth is being checked or redirecting
  if (authState !== "authenticated") return null;

  return (
    <APIProvider apiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY!} libraries={["places"]}>
    <DefaultLayout>
      <div className="flex h-[calc(100vh-4rem)]">

        {/* ── Calendar ────────────────────────────────────────────────────── */}
        <div className="flex-1 p-4 xl:p-8 min-w-0">
          {loading && (
            <div className="text-xs text-center text-gray-400 mb-1 animate-pulse">
              Loading…
            </div>
          )}
          <Calendar
            localizer={localizer}
            events={rbcEvents}
            startAccessor="start"
            endAccessor="end"
            defaultView={Views.MONTH}
            date={currentDate}
            onNavigate={(date) => setCurrentDate(date)}
            dayPropGetter={dayPropGetter}
            eventPropGetter={eventPropGetter}
            selectable
            onSelectSlot={handleSelectSlot}
            onSelectEvent={handleSelectEvent}
            onDoubleClickEvent={handleSelectEvent}
            onDrillDown={(date) => setPanel({ kind: "newEvent", date: dayjs(date).format("YYYY-MM-DD"), startTime: "09:00", endTime: "10:00" })}
            style={{ height: "100%" }}
          />
        </div>

        {/* ── Side panel ──────────────────────────────────────────────────── */}
        {panel && (
          <div className="w-80 border-l border-gray-200 dark:border-gray-700 flex flex-col bg-white dark:bg-darkPurple overflow-hidden">

            {/* Panel header */}
            <div className="flex items-center justify-between px-6 py-4 border-b dark:border-gray-700 flex-shrink-0">
              <h2 className="text-base font-semibold dark:text-rose text-purple truncate">
                {panel.kind === "day"      && dayjs(panel.record.date).format("ddd, MMM D YYYY")}
                {panel.kind === "trip"     && panel.record.name}
                {panel.kind === "newTrip"  && `New trip · ${dayjs(panel.startDate).format("MMM D")} – ${dayjs(panel.endDate).format("MMM D")}`}
                {panel.kind === "event"    && panel.record.title}
                {panel.kind === "newEvent" && `New event · ${dayjs(panel.date).format("MMM D")}`}
              </h2>
              <button
                onClick={() => setPanel(null)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2 flex-shrink-0"
              >
                ×
              </button>
            </div>

            {/* Panel body */}
            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">

              {/* ── DAY PANEL ─────────────────────────────────────────── */}
              {panel.kind === "day" && (
                <DayPanel
                  record={panel.record}
                  trips={trips}
                  saving={saving}
                  onChange={(r) => setPanel({ kind: "day", record: r })}
                  onSave={() => handleSaveDay(panel.record)}
                />
              )}

              {/* ── TRIP PANEL (edit) ──────────────────────────────────── */}
              {panel.kind === "trip" && (
                <TripPanel
                  record={panel.record}
                  saving={saving}
                  onChange={(r) => setPanel({ kind: "trip", record: r })}
                  onSave={() => handleSaveTrip(panel.record)}
                  onDelete={() => handleDeleteTrip(panel.record.id)}
                />
              )}

              {/* ── TRIP PANEL (new) ───────────────────────────────────── */}
              {panel.kind === "newTrip" && (
                <NewTripPanel
                  startDate={panel.startDate}
                  endDate={panel.endDate}
                  saving={saving}
                  onCreate={handleCreateTrip}
                />
              )}

              {/* ── EVENT PANEL (edit) ─────────────────────────────────── */}
              {panel.kind === "event" && (
                <EventPanel
                  record={panel.record}
                  trips={trips}
                  saving={saving}
                  onChange={(r) => setPanel({ kind: "event", record: r })}
                  onSave={() => handleSaveEvent(panel.record)}
                  onDelete={() => handleDeleteEvent(panel.record.id)}
                />
              )}

              {/* ── EVENT PANEL (new) ──────────────────────────────────── */}
              {panel.kind === "newEvent" && (
                <NewEventPanel
                  date={panel.date}
                  startTime={panel.startTime}
                  endTime={panel.endTime}
                  trips={trips}
                  saving={saving}
                  onCreate={handleCreateEvent}
                />
              )}
            </div>

            {/* Legend (only shown on day panel) */}
            {panel.kind === "day" && (
              <div className="px-6 py-4 border-t dark:border-gray-700 flex-shrink-0">
                <p className={labelCls}>Legend</p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                  {Object.entries(STATUS_CONFIG).map(([, { label, bg }]) => (
                    <div key={label} className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: bg }} />
                      <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </DefaultLayout>
    </APIProvider>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DayPanel({
  record, trips, saving, onChange, onSave,
}: {
  record: DayRecord;
  trips: TripRecord[];
  saving: boolean;
  onChange: (r: DayRecord) => void;
  onSave: () => void;
}) {
  return (
    <>
      {/* Status */}
      <div>
        <label className={labelCls}>Status</label>
        <select
          className={inputCls}
          value={record.status ?? "WORKING_HOME"}
          onChange={(e) => onChange({ ...record, status: e.target.value })}
        >
          {Object.entries(STATUS_CONFIG).map(([key, { label }]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </div>

      {/* Timezone */}
      <div>
        <label className={labelCls}>Timezone</label>
        <input
          type="text"
          className={inputCls}
          placeholder="America/Chicago"
          value={record.timezone ?? "America/Chicago"}
          onChange={(e) => onChange({ ...record, timezone: e.target.value })}
        />
        <p className="text-xs text-gray-400 mt-0.5">
          IANA — e.g. Europe/Athens, America/Sao_Paulo
        </p>
      </div>

      {/* Trip link (Travel / Vacation / Office) */}
      {(record.status === "TRAVEL" ||
        record.status === "VACATION" ||
        record.status === "WORKING_OFFICE") && (
        <div>
          <label className={labelCls}>Trip</label>
          <select
            className={inputCls}
            value={record.tripId ?? ""}
            onChange={(e) => {
              const trip = trips.find((t) => t.id === e.target.value);
              onChange({ ...record, tripId: e.target.value || null, tripName: trip?.name ?? null });
            }}
          >
            <option value="">— none —</option>
            {trips.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* PTO fraction */}
      {(record.status === "PTO" || record.status === "CHOICE_DAY") && (
        <div>
          <label className={labelCls}>
            PTO fraction ({((record.ptoFraction ?? 0) * 100).toFixed(0)}%)
          </label>
          <input
            type="range" min={0} max={1} step={0.25}
            className="w-full"
            value={record.ptoFraction ?? 0}
            onChange={(e) => onChange({ ...record, ptoFraction: parseFloat(e.target.value) })}
          />
          <div className="flex justify-between text-xs text-gray-400 mt-0.5">
            {["0%", "25%", "50%", "75%", "100%"].map((l) => <span key={l}>{l}</span>)}
          </div>
        </div>
      )}

      {/* Notes */}
      <div>
        <label className={labelCls}>Notes</label>
        <textarea
          rows={3}
          className={`${inputCls} resize-none`}
          placeholder="Any notes…"
          value={record.notes ?? ""}
          onChange={(e) => onChange({ ...record, notes: e.target.value })}
        />
      </div>

      {/* Location */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>City</label>
          <input
            type="text" className={inputCls} placeholder="Austin"
            value={record.location?.city ?? ""}
            onChange={(e) =>
              onChange({ ...record, location: { ...record.location, city: e.target.value } })
            }
          />
        </div>
        <div>
          <label className={labelCls}>Country</label>
          <input
            type="text" className={inputCls} placeholder="US"
            value={record.location?.country ?? ""}
            onChange={(e) =>
              onChange({ ...record, location: { ...record.location, country: e.target.value } })
            }
          />
        </div>
      </div>

      <SaveButton saving={saving} onSave={onSave} />
    </>
  );
}

function TripPanel({
  record, saving, onChange, onSave, onDelete,
}: {
  record: TripRecord;
  saving: boolean;
  onChange: (r: TripRecord) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <div>
        <label className={labelCls}>Name</label>
        <input
          type="text" className={inputCls} placeholder="Greece 2026"
          value={record.name}
          onChange={(e) => onChange({ ...record, name: e.target.value })}
        />
      </div>

      <div>
        <label className={labelCls}>Type</label>
        <select
          className={inputCls}
          value={record.type ?? "LEISURE"}
          onChange={(e) => onChange({ ...record, type: e.target.value as TripType })}
        >
          {Object.entries(TRIP_TYPE_CONFIG).map(([key, { label }]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Start</label>
          <input
            type="date" className={inputCls}
            value={record.startDate}
            onChange={(e) => onChange({ ...record, startDate: e.target.value })}
          />
        </div>
        <div>
          <label className={labelCls}>End</label>
          <input
            type="date" className={inputCls}
            value={record.endDate}
            onChange={(e) => onChange({ ...record, endDate: e.target.value })}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>City</label>
          <input
            type="text" className={inputCls} placeholder="Athens"
            value={record.destination?.city ?? ""}
            onChange={(e) =>
              onChange({ ...record, destination: { ...record.destination, city: e.target.value } })
            }
          />
        </div>
        <div>
          <label className={labelCls}>Country</label>
          <input
            type="text" className={inputCls} placeholder="GR"
            value={record.destination?.country ?? ""}
            onChange={(e) =>
              onChange({ ...record, destination: { ...record.destination, country: e.target.value } })
            }
          />
        </div>
      </div>

      <div>
        <label className={labelCls}>Notes</label>
        <textarea
          rows={3} className={`${inputCls} resize-none`}
          placeholder="Any notes…"
          value={record.notes ?? ""}
          onChange={(e) => onChange({ ...record, notes: e.target.value })}
        />
      </div>

      <SaveButton saving={saving} onSave={onSave} />

      <button
        onClick={onDelete}
        disabled={saving}
        className="w-full py-2 rounded text-sm font-semibold border border-red-400 text-red-400 hover:bg-red-400 hover:text-white disabled:opacity-50 transition-colors"
      >
        Delete trip
      </button>
    </>
  );
}

function NewTripPanel({
  startDate, endDate, saving, onCreate,
}: {
  startDate: string;
  endDate: string;
  saving: boolean;
  onCreate: (draft: { name: string; type: string; startDate: string; endDate: string; notes: string }) => void;
}) {
  const [draft, setDraft] = useState({
    name: "",
    type: "LEISURE",
    startDate,
    endDate,
    notes: "",
  });

  return (
    <>
      <p className="text-xs text-gray-400">
        Drag across days on the calendar to create a new trip spanning that range.
      </p>

      <div>
        <label className={labelCls}>Name</label>
        <input
          type="text" className={inputCls} placeholder="Greece 2026" autoFocus
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </div>

      <div>
        <label className={labelCls}>Type</label>
        <select
          className={inputCls}
          value={draft.type}
          onChange={(e) => setDraft({ ...draft, type: e.target.value })}
        >
          {Object.entries(TRIP_TYPE_CONFIG).map(([key, { label }]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Start</label>
          <input
            type="date" className={inputCls}
            value={draft.startDate}
            onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
          />
        </div>
        <div>
          <label className={labelCls}>End</label>
          <input
            type="date" className={inputCls}
            value={draft.endDate}
            onChange={(e) => setDraft({ ...draft, endDate: e.target.value })}
          />
        </div>
      </div>

      <div>
        <label className={labelCls}>Notes</label>
        <textarea
          rows={2} className={`${inputCls} resize-none`}
          placeholder="Any notes…"
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        />
      </div>

      <button
        onClick={() => onCreate(draft)}
        disabled={saving || !draft.name.trim()}
        className="w-full py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {saving ? "Creating…" : "Create trip"}
      </button>
    </>
  );
}

// ── PlacesAutocomplete ───────────────────────────────────────────────────────

function PlacesAutocomplete({
  city, country, onChange,
}: {
  city: string;
  country: string;
  onChange: (city: string, country: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const places = useMapsLibrary("places");

  useEffect(() => {
    if (!places || !inputRef.current) return;

    const autocomplete = new places.Autocomplete(inputRef.current, {
      types: ["(cities)"],
      fields: ["address_components", "name"],
    });

    const listener = autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (!place.address_components) return;

      let newCity = "";
      let newCountry = "";

      for (const component of place.address_components) {
        if (component.types.includes("locality")) {
          newCity = component.long_name;
        } else if (component.types.includes("administrative_area_level_1") && !newCity) {
          newCity = component.long_name;
        }
        if (component.types.includes("country")) {
          newCountry = component.short_name; // ISO 2-letter code
        }
      }

      onChange(newCity || place.name || "", newCountry);
    });

    return () => {
      google.maps.event.removeListener(listener);
    };
  }, [places, onChange]);

  // Show current value as placeholder when already set
  const displayValue = [city, country].filter(Boolean).join(", ");

  return (
    <input
      ref={inputRef}
      type="text"
      className={inputCls}
      placeholder={displayValue || "Search for a city\u2026"}
      defaultValue={displayValue}
    />
  );
}

function SaveButton({ saving, onSave }: { saving: boolean; onSave: () => void }) {
  return (
    <button
      onClick={onSave}
      disabled={saving}
      className="w-full py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 disabled:opacity-50 transition-opacity"
    >
      {saving ? "Saving…" : "Save"}
    </button>
  );
}

// ── Shared event form fields ──────────────────────────────────────────────────

function EventFormFields({
  title, setTitle,
  description, setDescription,
  date, setDate,
  isAllDay, setIsAllDay,
  startTime, setStartTime,
  endTime, setEndTime,
  timezone, setTimezone,
  url, setUrl,
  city, setCity,
  country, setCountry,
  tripId, setTripId,
  trips,
}: {
  title: string;        setTitle: (v: string) => void;
  description: string;  setDescription: (v: string) => void;
  date: string;         setDate: (v: string) => void;
  isAllDay: boolean;    setIsAllDay: (v: boolean) => void;
  startTime: string;    setStartTime: (v: string) => void;
  endTime: string;      setEndTime: (v: string) => void;
  timezone: string;     setTimezone: (v: string) => void;
  url: string;          setUrl: (v: string) => void;
  city: string;         setCity: (v: string) => void;
  country: string;      setCountry: (v: string) => void;
  tripId: string;       setTripId: (v: string) => void;
  onLocationChange: (city: string, country: string) => void;
  trips: TripRecord[];
}, { onLocationChange }: { onLocationChange: (city: string, country: string) => void }) {
  return (
    <>
      {/* Title */}
      <div>
        <label className={labelCls}>Title</label>
        <input
          type="text" className={inputCls} placeholder="Flight to Rome" autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      {/* Date */}
      <div>
        <label className={labelCls}>Date</label>
        <input
          type="date" className={inputCls}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>

      {/* All day toggle */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox" id="isAllDay"
          checked={isAllDay}
          onChange={(e) => setIsAllDay(e.target.checked)}
          className="accent-purple dark:accent-rose"
        />
        <label htmlFor="isAllDay" className="text-sm text-gray-600 dark:text-gray-300 cursor-pointer">
          All day
        </label>
      </div>

      {/* Start / End times (hidden when all-day) */}
      {!isAllDay && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Start</label>
            <input
              type="time" className={inputCls}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>
          <div>
            <label className={labelCls}>End</label>
            <input
              type="time" className={inputCls}
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* Timezone */}
      <div>
        <label className={labelCls}>Timezone</label>
        <input
          type="text" className={inputCls} placeholder="America/Chicago"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
        />
        <p className="text-xs text-gray-400 mt-0.5">IANA — e.g. Europe/Rome</p>
      </div>

      {/* Description */}
      <div>
        <label className={labelCls}>Description</label>
        <textarea
          rows={2} className={`${inputCls} resize-none`}
          placeholder="Any notes…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      {/* URL */}
      <div>
        <label className={labelCls}>URL</label>
        <input
          type="url" className={inputCls} placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>

      {/* Location */}
      <div>
        <label className={labelCls}>Location</label>
        <PlacesAutocomplete
          city={city}
          country={country}
          onChange={onLocationChange}
        />
        {(city || country) && (
          <p className="text-xs text-gray-400 mt-0.5">{[city, country].filter(Boolean).join(", ")}</p>
        )}
      </div>

      {/* Trip link */}
      <div>
        <label className={labelCls}>Trip</label>
        <select
          className={inputCls}
          value={tripId}
          onChange={(e) => setTripId(e.target.value)}
        >
          <option value="">— none —</option>
          {trips.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>
    </>
  );
}

// ── EventPanel (edit existing) ────────────────────────────────────────────────

function EventPanel({
  record, trips, saving, onChange, onSave, onDelete,
}: {
  record: EventRecord;
  trips: TripRecord[];
  saving: boolean;
  onChange: (r: EventRecord) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const tz = record.timezone ?? "America/Chicago";
  const startDayjs = dayjs(record.startAt).tz(tz);
  const endDayjs   = dayjs(record.endAt).tz(tz);

  const [date,      setDate]      = useState(startDayjs.format("YYYY-MM-DD"));
  const [startTime, setStartTime] = useState(startDayjs.format("HH:mm"));
  const [endTime,   setEndTime]   = useState(endDayjs.format("HH:mm"));

  const handleLocationChange = useCallback((city: string, country: string) => {
    onChange({ ...record, location: { ...record.location, city, country } });
  }, [record, onChange]);

  function updateDateTime(newDate: string, newStart: string, newEnd: string, allDay: boolean) {
    const startAt = allDay
      ? dayjs.tz(`${newDate}T00:00:00`, tz).toISOString()
      : dayjs.tz(`${newDate}T${newStart}:00`, tz).toISOString();
    const endAt = allDay
      ? dayjs.tz(`${newDate}T23:59:59`, tz).toISOString()
      : dayjs.tz(`${newDate}T${newEnd}:00`, tz).toISOString();
    onChange({ ...record, startAt, endAt });
  }

  return (
    <>
      <EventFormFields
        title={record.title}
        setTitle={(v) => onChange({ ...record, title: v })}
        description={record.description ?? ""}
        setDescription={(v) => onChange({ ...record, description: v })}
        date={date}
        setDate={(v) => { setDate(v); updateDateTime(v, startTime, endTime, record.isAllDay ?? false); }}
        isAllDay={record.isAllDay ?? false}
        setIsAllDay={(v) => { onChange({ ...record, isAllDay: v }); updateDateTime(date, startTime, endTime, v); }}
        startTime={startTime}
        setStartTime={(v) => { setStartTime(v); updateDateTime(date, v, endTime, record.isAllDay ?? false); }}
        endTime={endTime}
        setEndTime={(v) => { setEndTime(v); updateDateTime(date, startTime, v, record.isAllDay ?? false); }}
        timezone={record.timezone ?? "America/Chicago"}
        setTimezone={(v) => onChange({ ...record, timezone: v })}
        url={record.url ?? ""}
        setUrl={(v) => onChange({ ...record, url: v })}
        city={record.location?.city ?? ""}
        setCity={(v) => onChange({ ...record, location: { ...record.location, city: v } })}
        country={record.location?.country ?? ""}
        setCountry={(v) => onChange({ ...record, location: { ...record.location, country: v } })}
        onLocationChange={handleLocationChange}
        tripId={record.tripId ?? ""}
        setTripId={(v) => onChange({ ...record, tripId: v || null })}
        trips={trips}
      />

      <SaveButton saving={saving} onSave={onSave} />

      <button
        onClick={onDelete}
        disabled={saving}
        className="w-full py-2 rounded text-sm font-semibold border border-red-400 text-red-400 hover:bg-red-400 hover:text-white disabled:opacity-50 transition-colors"
      >
        Delete event
      </button>
    </>
  );
}

// ── NewEventPanel (create) ────────────────────────────────────────────────────

function NewEventPanel({
  date: initialDate, startTime: initialStart, endTime: initialEnd, trips, saving, onCreate,
}: {
  date: string;
  startTime: string;
  endTime: string;
  trips: TripRecord[];
  saving: boolean;
  onCreate: (draft: {
    title: string; description: string; date: string;
    startTime: string; endTime: string; isAllDay: boolean;
    timezone: string; url: string; notes: string;
    city: string; country: string; tripId: string;
  }) => void;
}) {
  const [title,       setTitle]       = useState("");
  const [description, setDescription] = useState("");
  const [date,        setDate]        = useState(initialDate);
  const [isAllDay,    setIsAllDay]    = useState(false);
  const [startTime,   setStartTime]   = useState(initialStart);
  const [endTime,     setEndTime]     = useState(initialEnd);
  const [timezone,    setTimezone]    = useState("America/Chicago");
  const [url,         setUrl]         = useState("");
  const [city,        setCity]        = useState("");
  const [country,     setCountry]     = useState("");
  const [tripId,      setTripId]      = useState("");

  const handleLocationChange = useCallback((newCity: string, newCountry: string) => {
    setCity(newCity);
    setCountry(newCountry);
  }, []);

  return (
    <>
      <EventFormFields
        title={title}             setTitle={setTitle}
        description={description} setDescription={setDescription}
        date={date}               setDate={setDate}
        isAllDay={isAllDay}       setIsAllDay={setIsAllDay}
        startTime={startTime}     setStartTime={setStartTime}
        endTime={endTime}         setEndTime={setEndTime}
        timezone={timezone}       setTimezone={setTimezone}
        url={url}                 setUrl={setUrl}
        city={city}               setCity={setCity}
        country={country}         setCountry={setCountry}
        onLocationChange={handleLocationChange}
        tripId={tripId}           setTripId={setTripId}
        trips={trips}
      />

      <button
        onClick={() => onCreate({ title, description, date, startTime, endTime, isAllDay, timezone, url, notes: description, city, country, tripId })}
        disabled={saving || !title.trim()}
        className="w-full py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {saving ? "Creating…" : "Create event"}
      </button>
    </>
  );
}
