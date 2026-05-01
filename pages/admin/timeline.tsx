import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NextLink from "next/link";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import DefaultLayout from "@/layouts/default";
import { generateClient } from "aws-amplify/data";
import { uploadData, remove as s3Remove } from "aws-amplify/storage";
import type { Schema } from "@/amplify/data/resource";

type Category = "aviation" | "dev" | "work" | "life";
type Entry = Schema["timelineEntry"]["type"];
type Media = Schema["timelineMedia"]["type"];

const CATEGORIES: Record<Category, { label: string; color: string }> = {
  aviation: { label: "Aviation", color: "#DEBA02" },
  dev:      { label: "Personal Projects", color: "#60a5fa" },
  work:     { label: "Work", color: "#587D71" },
  life:     { label: "Life", color: "#a78bfa" },
};

const BUCKET_NAME      = "gennaroanesi.com";
const MEDIA_URL_PREFIX = "https://s3.us-east-1.amazonaws.com/gennaroanesi.com/";

// One-time seed used by the "Seed defaults" button when the DB is empty.
// Mirrors the previous hard-coded array on /timeline so the page doesn't
// go blank on first deploy. After seeding, manage entries through this UI.
type SeedEntry = {
  date: string;
  title: string;
  description: string;
  category: Category;
  url?: string;
  sortOrder?: number;
};

const DEFAULTS: SeedEntry[] = [
  { date: "2026-04", title: "Home Hub",
    description: "Natural-language household app for two — tasks, bills, calendar, reminders, photos, trips, Home Assistant. Three surfaces (WhatsApp, web, iOS), one schema, one Claude-powered agent.",
    category: "dev", url: "/projects/home-hub" },
  { date: "2026-03", title: "Instrument Checkride",
    description: "Passed at Lubbock, TX.", category: "aviation" },
  { date: "2026-03", title: "Created 91 Dispatcher",
    description: "A safety-oriented aviation app.", category: "dev",
    url: "https://91dispatcher.ai" },
  { date: "2026-02", title: "gennaroanesi.com 'rewrite' with Claude Code",
    description: "Next.js + Amplify Gen2. Flight log, photo hub, this timeline.",
    category: "dev" },
  { date: "2026-02", title: "Flight Log site",
    description: "3D flight log built around a Cesium globe — KML routes from ForeFlight, archived FAA approach plates, cockpit-video sync to live track. Email-triggered import is the only step I take.",
    category: "dev", url: "/projects/flying" },
  { date: "2025-12", title: "Mountain Flying course",
    description: "Flying on the rockies with approaches at Telluride, Aspen and Eagle.",
    category: "aviation" },
  { date: "2025-10", title: "Started leading a team of Data Scientists at Meta supporting Sales AI",
    description: "Extensive use of Claude, Gemini and Llama to boost efficiency and deliver data insights to unlock key product decisions.",
    category: "work" },
  { date: "2025-08", title: "Private Pilot Checkride",
    description: "Passed at Lubbock, TX.", category: "aviation" },
  { date: "2025-02", title: "Created Paid Messaging Long-Range Plan",
    description: "Outlined how a nascent product could achieve multi-billion dollar revenue in 5–10 years. Direct conversations with CRO and multiple product, sales, and marketing VPs.",
    category: "work" },
  { date: "2024-04", title: "Created 0->1 Sales Pitch Recommendation System",
    description: "Created a ranking metric to compare fundamentally different products; elected the best based on sales capacity and delivered pitch recommendations with personalized insights to improve adoption rates. This work is now staffed by a full DS team and is one of the main drivers of sales conversations with clients.",
    category: "work" },
];

const client = generateClient<Schema>();

type DraftState = {
  date:        string;
  title:       string;
  description: string;
  category:    Category;
  url:         string;
  sortOrder:   number;
};

function emptyDraft(): DraftState {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return { date: ym, title: "", description: "", category: "dev", url: "", sortOrder: 0 };
}

type PanelMode = null | { kind: "new" } | { kind: "edit"; id: string };

export default function AdminTimelinePage() {
  const { authState } = useRequireAuth();

  const [entries, setEntries] = useState<Entry[]>([]);
  const [media, setMedia]     = useState<Media[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [seeding, setSeeding] = useState(false);

  const [panelMode, setPanelMode] = useState<PanelMode>(null);
  const [draft, setDraft]         = useState<DraftState>(emptyDraft());
  const [uploading, setUploading] = useState(false);
  const fileInputRef              = useRef<HTMLInputElement | null>(null);

  // ── Data load ──────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [eRes, mRes] = await Promise.all([
        client.models.timelineEntry.list({ limit: 500 }),
        client.models.timelineMedia.list({ limit: 1000 }),
      ]);
      setEntries(eRes.data ?? []);
      setMedia(mRes.data ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchAll();
  }, [authState, fetchAll]);

  // ── Derived ────────────────────────────────────────────────────────────
  const sorted = useMemo(
    () => [...entries].sort((a, b) => {
      const dc = (b.date ?? "").localeCompare(a.date ?? "");
      if (dc !== 0) return dc;
      return (b.sortOrder ?? 0) - (a.sortOrder ?? 0);
    }),
    [entries],
  );

  const mediaByEntry = useMemo(() => {
    const m = new Map<string, Media[]>();
    for (const it of media) {
      if (!it.entryId) continue;
      if (!m.has(it.entryId)) m.set(it.entryId, []);
      m.get(it.entryId)!.push(it);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    }
    return m;
  }, [media]);

  const editingEntry = panelMode && panelMode.kind === "edit"
    ? entries.find((e) => e.id === panelMode.id) ?? null
    : null;

  const editingMedia = editingEntry ? (mediaByEntry.get(editingEntry.id) ?? []) : [];

  // ── Mutations ──────────────────────────────────────────────────────────
  function openNew() {
    setDraft(emptyDraft());
    setPanelMode({ kind: "new" });
  }

  function openEdit(e: Entry) {
    setDraft({
      date:        e.date ?? "",
      title:       e.title ?? "",
      description: e.description ?? "",
      category:    (e.category as Category) ?? "dev",
      url:         e.url ?? "",
      sortOrder:   e.sortOrder ?? 0,
    });
    setPanelMode({ kind: "edit", id: e.id });
  }

  async function handleSave() {
    if (!draft.title.trim() || !draft.date.trim()) {
      alert("Title and date are required.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        date:        draft.date,
        title:       draft.title.trim(),
        description: draft.description.trim() || null,
        category:    draft.category as any,
        url:         draft.url.trim() || null,
        sortOrder:   draft.sortOrder,
      };
      if (panelMode?.kind === "new") {
        const { data } = await client.models.timelineEntry.create(payload);
        if (data) setEntries((p) => [...p, data]);
      } else if (panelMode?.kind === "edit") {
        const { data } = await client.models.timelineEntry.update({ id: panelMode.id, ...payload });
        if (data) setEntries((p) => p.map((e) => e.id === panelMode.id ? data : e));
      }
      setPanelMode(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!panelMode || panelMode.kind !== "edit") return;
    const id = panelMode.id;
    const e = entries.find((x) => x.id === id);
    if (!confirm(`Delete "${e?.title ?? id}"? Media files in S3 will also be removed.`)) return;
    setSaving(true);
    try {
      // Cascade media: delete S3 objects + DB rows.
      const mine = mediaByEntry.get(id) ?? [];
      for (const m of mine) {
        try { await s3Remove({ path: m.s3Key, options: { bucket: BUCKET_NAME } }); } catch {}
        try { await client.models.timelineMedia.delete({ id: m.id }); } catch {}
      }
      await client.models.timelineEntry.delete({ id });
      setEntries((p) => p.filter((x) => x.id !== id));
      setMedia((p) => p.filter((m) => m.entryId !== id));
      setPanelMode(null);
    } finally {
      setSaving(false);
    }
  }

  // ── Media upload ───────────────────────────────────────────────────────
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!editingEntry) {
      alert("Save the entry first, then upload media.");
      return;
    }
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const created: Media[] = [];
      // Upload sequentially to keep UI feedback simple. For larger batches,
      // Promise.all would be fine since Amplify Storage is concurrency-safe.
      for (const file of Array.from(files)) {
        const isVideo = file.type.startsWith("video/");
        const isImage = file.type.startsWith("image/");
        if (!isVideo && !isImage) continue;
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
        const key = `public/timeline/${editingEntry.id}/${Date.now()}-${safeName}`;
        await uploadData({
          path:    key,
          data:    file,
          options: { bucket: BUCKET_NAME, contentType: file.type },
        }).result;
        const { data } = await client.models.timelineMedia.create({
          entryId:   editingEntry.id,
          kind:      isVideo ? "VIDEO" : "IMAGE" as any,
          s3Key:     key,
          caption:   null,
          sortOrder: editingMedia.length + created.length,
        });
        if (data) created.push(data);
      }
      if (created.length) setMedia((prev) => [...prev, ...created]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleMediaDelete(m: Media) {
    if (!confirm("Delete this media item?")) return;
    try { await s3Remove({ path: m.s3Key, options: { bucket: BUCKET_NAME } }); } catch {}
    await client.models.timelineMedia.delete({ id: m.id });
    setMedia((p) => p.filter((x) => x.id !== m.id));
  }

  // ── One-time seed of the previous hard-coded entries ───────────────────
  async function handleSeedDefaults() {
    if (entries.length > 0) return;
    if (!confirm(`Seed ${DEFAULTS.length} default timeline entries? Only do this once on a fresh DB.`)) return;
    setSeeding(true);
    try {
      const created: Entry[] = [];
      for (const seed of DEFAULTS) {
        const { data } = await client.models.timelineEntry.create({
          date:        seed.date,
          title:       seed.title,
          description: seed.description,
          category:    seed.category as any,
          url:         seed.url ?? null,
          sortOrder:   seed.sortOrder ?? 0,
        });
        if (data) created.push(data);
      }
      setEntries((p) => [...p, ...created]);
    } finally {
      setSeeding(false);
    }
  }

  if (authState !== "authenticated") return null;

  return (
    <DefaultLayout>
      <div className="bg-gray-50 dark:bg-darkBg flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">
          <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
            <NextLink href="/timeline" className="hover:underline text-purple/70 dark:text-rose/70">
              ← Public timeline
            </NextLink>
          </div>

          <div className="flex items-center justify-between mb-5 gap-2 flex-wrap">
            <div>
              <h1 className="text-2xl font-bold text-purple dark:text-rose">Manage Timeline</h1>
              <p className="text-xs text-gray-400 mt-0.5">
                Entries + attached media for the public /timeline page.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {entries.length === 0 && !loading && (
                <button
                  onClick={handleSeedDefaults}
                  disabled={seeding}
                  className="px-3 py-1.5 rounded text-xs font-semibold border border-amber-400/60 text-amber-400 hover:bg-amber-400/10 transition-colors disabled:opacity-50"
                  title="One-time: import the defaults into the DB"
                >
                  {seeding ? "Seeding…" : `Seed ${DEFAULTS.length} defaults`}
                </button>
              )}
              <button
                onClick={openNew}
                className="px-4 py-1.5 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity"
              >
                + New entry
              </button>
            </div>
          </div>

          {loading ? (
            <p className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</p>
          ) : sorted.length === 0 ? (
            <div className="rounded-xl border border-gray-200 dark:border-darkBorder p-8 text-center">
              <p className="text-sm text-gray-400">No timeline entries yet.</p>
            </div>
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-darkElevated">
                  <tr className="text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium">
                    <th className="px-3 py-2 w-24">Date</th>
                    <th className="px-3 py-2">Title</th>
                    <th className="px-3 py-2 w-32">Category</th>
                    <th className="px-3 py-2 w-20 text-right">Media</th>
                    <th className="px-3 py-2 w-20"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sorted.map((e) => {
                    const cat = CATEGORIES[e.category as Category];
                    const m = mediaByEntry.get(e.id) ?? [];
                    return (
                      <tr key={e.id} className="hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer" onClick={() => openEdit(e)}>
                        <td className="px-3 py-2 font-mono text-xs text-gray-500">{e.date}</td>
                        <td className="px-3 py-2">
                          <p className="text-gray-800 dark:text-gray-200 font-medium">{e.title}</p>
                          {e.url && <p className="text-[10px] text-gray-400 truncate max-w-[400px]">{e.url}</p>}
                        </td>
                        <td className="px-3 py-2">
                          {cat ? (
                            <span className="text-[10px] uppercase tracking-widest" style={{ color: cat.color }}>
                              {cat.label}
                            </span>
                          ) : <span className="text-gray-400 text-[10px]">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-gray-500 tabular-nums">
                          {m.length || "—"}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={(ev) => { ev.stopPropagation(); openEdit(e); }}
                            className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Side panel — create / edit */}
        {panelMode && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-[28rem] border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
              <h2 className="text-base font-semibold dark:text-rose text-purple">
                {panelMode.kind === "new" ? "New Entry" : "Edit Entry"}
              </h2>
              <button onClick={() => setPanelMode(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <div>
                <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium block mb-1">Date *</label>
                <input
                  type="month"
                  value={draft.date}
                  onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
                  className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1.5 text-sm text-gray-800 dark:text-gray-200"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium block mb-1">Title *</label>
                <input
                  type="text"
                  value={draft.title}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                  className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1.5 text-sm text-gray-800 dark:text-gray-200"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium block mb-1">Description</label>
                <textarea
                  value={draft.description}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                  rows={4}
                  className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1.5 text-sm text-gray-800 dark:text-gray-200 resize-y"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium block mb-1">Category</label>
                  <select
                    value={draft.category}
                    onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value as Category }))}
                    className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1.5 text-sm text-gray-800 dark:text-gray-200"
                  >
                    {(Object.keys(CATEGORIES) as Category[]).map((c) => (
                      <option key={c} value={c}>{CATEGORIES[c].label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium block mb-1">Sort order</label>
                  <input
                    type="number"
                    value={draft.sortOrder}
                    onChange={(e) => setDraft((d) => ({ ...d, sortOrder: parseInt(e.target.value, 10) || 0 }))}
                    className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1.5 text-sm text-gray-800 dark:text-gray-200"
                  />
                  <p className="text-[10px] text-gray-400 mt-0.5">Tiebreaker within same month. Higher = first.</p>
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium block mb-1">URL</label>
                <input
                  type="text"
                  value={draft.url}
                  onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
                  placeholder="/projects/foo  or  https://example.com"
                  className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1.5 text-sm text-gray-800 dark:text-gray-200"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">Optional. Internal paths use SPA nav; external opens in new tab.</p>
              </div>

              {/* Media — only available once the entry exists, since uploads are keyed by id. */}
              <div className="border-t border-gray-200 dark:border-darkBorder pt-4">
                <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium block mb-2">Media</label>
                {!editingEntry ? (
                  <p className="text-[11px] text-gray-400 italic">Save the entry first, then attach media.</p>
                ) : (
                  <>
                    {editingMedia.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-3">
                        {editingMedia.map((m) => {
                          const url = `${MEDIA_URL_PREFIX}${m.s3Key}`;
                          return (
                            <div key={m.id} className="relative group rounded overflow-hidden border border-gray-200 dark:border-darkBorder">
                              {m.kind === "VIDEO" ? (
                                <div className="relative w-24 h-16 bg-black flex items-center justify-center">
                                  <video src={url} className="w-full h-full object-cover" muted playsInline preload="metadata" />
                                  <span className="absolute text-white text-base" aria-hidden>▶</span>
                                </div>
                              ) : (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img src={url} alt={m.caption ?? ""} className="w-24 h-16 object-cover" />
                              )}
                              <button
                                onClick={() => handleMediaDelete(m)}
                                className="absolute top-0 right-0 m-0.5 px-1 text-[10px] bg-black/60 text-white rounded opacity-0 group-hover:opacity-100 transition-opacity"
                                title="Delete"
                              >
                                ×
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept="image/*,video/*"
                      onChange={handleFileChange}
                      disabled={uploading}
                      className="text-xs text-gray-500"
                    />
                    {uploading && <p className="text-[11px] text-gray-400 mt-1 animate-pulse">Uploading…</p>}
                  </>
                )}
              </div>

              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple disabled:opacity-50 transition-opacity"
              >
                {saving ? "Saving…" : panelMode.kind === "new" ? "Create entry" : "Save"}
              </button>
              {panelMode.kind === "edit" && (
                <button
                  onClick={handleDelete}
                  disabled={saving}
                  className="text-[11px] text-gray-400 hover:text-red-500 transition-colors disabled:opacity-30 self-start"
                >
                  Delete entry
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </DefaultLayout>
  );
}
