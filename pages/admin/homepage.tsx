import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NextLink from "next/link";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import DefaultLayout from "@/layouts/default";
import { generateClient } from "aws-amplify/data";
import { uploadData, remove as s3Remove } from "aws-amplify/storage";
import type { Schema } from "@/amplify/data/resource";

type HomeCategory = Schema["homeCategory"]["type"];
type HomeMedia    = Schema["homeMedia"]["type"];

const BUCKET_NAME      = "gennaroanesi.com";
const MEDIA_URL_PREFIX = "https://s3.us-east-1.amazonaws.com/gennaroanesi.com/";

// One-time seed of the previously hard-coded SLIDES array. After the user
// runs Seed once, the DB is the source of truth. Note: the s3Key values are
// existing public/videos/ and public/images/ paths — those files already
// live in the bucket from the original site.
type SeedCategory = {
  slug: string;
  label: string;
  sortOrder: number;
  items: { kind: "IMAGE" | "VIDEO"; s3Key: string; caption: string }[];
};

const DEFAULTS: SeedCategory[] = [
  {
    slug: "photo", label: "photos", sortOrder: 0,
    items: [
      { kind: "IMAGE", s3Key: "public/images/455A8627.web.jpg", caption: "Santorini, Oct 2025" },
      { kind: "IMAGE", s3Key: "public/images/455A1335.web.jpg", caption: "Copper, Dec 2023" },
      { kind: "IMAGE", s3Key: "public/images/455A7313.web.jpg", caption: "London, Jul 2022" },
      { kind: "IMAGE", s3Key: "public/images/455A8481.web.jpg", caption: "Capri, Jul 2023" },
    ],
  },
  {
    slug: "flying", label: "flying", sortOrder: 10,
    items: [
      { kind: "VIDEO", s3Key: "public/videos/partial_panel.web.mp4",      caption: "Partial panel at Kileen TX, Nov 2026" },
      { kind: "VIDEO", s3Key: "public/videos/telluride_approach.web.mp4", caption: "Approach at Telluride CO, Dec 2025" },
      { kind: "VIDEO", s3Key: "public/videos/night_approach_kgtu.web.mp4", caption: "Night Approach at Georgetown TX, Mar 2026" },
    ],
  },
  {
    slug: "guitar", label: "guitar", sortOrder: 20,
    items: [
      { kind: "VIDEO", s3Key: "public/videos/money_heist.mp4", caption: "Money Heist Theme" },
      { kind: "VIDEO", s3Key: "public/videos/deja_blues.mp4", caption: "Michael Lee Firkins - Deja Blues" },
    ],
  },
];

const client = generateClient<Schema>();

type CatDraft = { slug: string; label: string; sortOrder: number };

export default function AdminHomepagePage() {
  const { authState } = useRequireAuth();

  const [categories, setCategories] = useState<HomeCategory[]>([]);
  const [media, setMedia]           = useState<HomeMedia[]>([]);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [seeding, setSeeding]       = useState(false);
  const [uploading, setUploading]   = useState(false);

  // Active selection — null = the categories list, else the slug of the
  // category we're managing media for.
  const [activeSlug, setActiveSlug] = useState<string | null>(null);

  // Category create/edit panel — separate from the media management view.
  const [catPanel, setCatPanel] = useState<null | "new" | { kind: "edit"; slug: string }>(null);
  const [catDraft, setCatDraft] = useState<CatDraft>({ slug: "", label: "", sortOrder: 0 });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bulkInputRef = useRef<HTMLInputElement | null>(null);

  // ── Data load ──────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [cRes, mRes] = await Promise.all([
        client.models.homeCategory.list({ limit: 100 }),
        client.models.homeMedia.list({ limit: 1000 }),
      ]);
      setCategories(cRes.data ?? []);
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
  const sortedCats = useMemo(
    () => [...categories].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    [categories],
  );

  const mediaByCat = useMemo(() => {
    const m = new Map<string, HomeMedia[]>();
    for (const it of media) {
      if (!it.categorySlug) continue;
      if (!m.has(it.categorySlug)) m.set(it.categorySlug, []);
      m.get(it.categorySlug)!.push(it);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    }
    return m;
  }, [media]);

  const activeCategory = activeSlug ? categories.find((c) => c.slug === activeSlug) ?? null : null;
  const activeMedia    = activeSlug ? (mediaByCat.get(activeSlug) ?? []) : [];

  // Bulk-imported / unassigned media. Lives at public/home/_inbox/{ts}-{name}.
  const inboxMedia = useMemo(
    () => media
      .filter((m) => !m.categorySlug)
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
    [media],
  );

  // ── Category mutations ─────────────────────────────────────────────────
  function openNewCat() {
    setCatDraft({ slug: "", label: "", sortOrder: (categories.length || 0) * 10 });
    setCatPanel("new");
  }

  function openEditCat(c: HomeCategory) {
    setCatDraft({ slug: c.slug ?? "", label: c.label ?? "", sortOrder: c.sortOrder ?? 0 });
    setCatPanel({ kind: "edit", slug: c.slug ?? "" });
  }

  async function handleSaveCat() {
    if (!catDraft.slug.trim() || !catDraft.label.trim()) {
      alert("Slug and label are required.");
      return;
    }
    const safeSlug = catDraft.slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    setSaving(true);
    try {
      if (catPanel === "new") {
        const { data } = await client.models.homeCategory.create({
          slug:      safeSlug,
          label:     catDraft.label.trim(),
          sortOrder: catDraft.sortOrder,
        });
        if (data) setCategories((p) => [...p, data]);
      } else if (catPanel && typeof catPanel === "object" && catPanel.kind === "edit") {
        const { data } = await client.models.homeCategory.update({
          slug:      catPanel.slug,
          label:     catDraft.label.trim(),
          sortOrder: catDraft.sortOrder,
        });
        if (data) setCategories((p) => p.map((c) => c.slug === catPanel.slug ? data : c));
      }
      setCatPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteCat(slug: string) {
    const c = categories.find((x) => x.slug === slug);
    if (!confirm(`Delete category "${c?.label ?? slug}" and all its media? S3 files in public/home/${slug}/ will also be removed.`)) return;
    setSaving(true);
    try {
      // Cascade media files + rows first.
      const mine = mediaByCat.get(slug) ?? [];
      for (const m of mine) {
        // Only attempt S3 deletion when the file is under public/home/ —
        // seed entries reference pre-existing public/videos/ + public/images/
        // assets that we shouldn't touch.
        if (m.s3Key?.startsWith(`public/home/${slug}/`)) {
          try { await s3Remove({ path: m.s3Key, options: { bucket: BUCKET_NAME } }); } catch {}
        }
        try { await client.models.homeMedia.delete({ id: m.id }); } catch {}
      }
      await client.models.homeCategory.delete({ slug });
      setCategories((p) => p.filter((c) => c.slug !== slug));
      setMedia((p) => p.filter((m) => m.categorySlug !== slug));
      if (activeSlug === slug) setActiveSlug(null);
      setCatPanel(null);
    } finally {
      setSaving(false);
    }
  }

  // ── Media mutations ────────────────────────────────────────────────────
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!activeSlug) return;
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const created: HomeMedia[] = [];
      for (const file of Array.from(files)) {
        const isVideo = file.type.startsWith("video/");
        const isImage = file.type.startsWith("image/");
        if (!isVideo && !isImage) continue;
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
        const key = `public/home/${activeSlug}/${Date.now()}-${safeName}`;
        await uploadData({
          path:    key,
          data:    file,
          options: { bucket: BUCKET_NAME, contentType: file.type },
        }).result;
        const { data } = await client.models.homeMedia.create({
          categorySlug: activeSlug,
          kind:         isVideo ? "VIDEO" : "IMAGE" as any,
          s3Key:        key,
          caption:      "",
          sortOrder:    activeMedia.length + created.length,
        });
        if (data) created.push(data);
      }
      if (created.length) setMedia((p) => [...p, ...created]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleMediaPatch(m: HomeMedia, patch: Partial<HomeMedia>) {
    const { data } = await client.models.homeMedia.update({ id: m.id, ...patch });
    if (data) setMedia((p) => p.map((x) => x.id === m.id ? data : x));
  }

  // Bulk import: drop N files into the inbox as isActive=false. The admin
  // assigns a category + flips isActive=true from the inbox cards below.
  async function handleBulkImport(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const created: HomeMedia[] = [];
      for (const file of Array.from(files)) {
        const isVideo = file.type.startsWith("video/");
        const isImage = file.type.startsWith("image/");
        if (!isVideo && !isImage) continue;
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
        const key = `public/home/_inbox/${Date.now()}-${safeName}`;
        await uploadData({
          path:    key,
          data:    file,
          options: { bucket: BUCKET_NAME, contentType: file.type },
        }).result;
        const { data } = await client.models.homeMedia.create({
          // categorySlug intentionally omitted — lands in inbox.
          kind:     isVideo ? "VIDEO" : "IMAGE" as any,
          s3Key:    key,
          caption:  "",
          isActive: false,
        });
        if (data) created.push(data);
      }
      if (created.length) setMedia((p) => [...p, ...created]);
    } finally {
      setUploading(false);
      if (bulkInputRef.current) bulkInputRef.current.value = "";
    }
  }

  async function handleCatPatch(slug: string, patch: Partial<HomeCategory>) {
    const { data } = await client.models.homeCategory.update({ slug, ...patch });
    if (data) setCategories((p) => p.map((c) => c.slug === slug ? data : c));
  }

  async function handleMediaDelete(m: HomeMedia) {
    if (!confirm("Delete this media item?")) return;
    if (m.s3Key?.startsWith("public/home/")) {
      // Only delete the S3 object if it's an admin-uploaded file under
      // public/home/. Seed entries pointing at older public/videos / public/images
      // paths stay on disk — they may be referenced elsewhere on the site.
      try { await s3Remove({ path: m.s3Key, options: { bucket: BUCKET_NAME } }); } catch {}
    }
    await client.models.homeMedia.delete({ id: m.id });
    setMedia((p) => p.filter((x) => x.id !== m.id));
  }

  // ── Seed defaults ──────────────────────────────────────────────────────
  async function handleSeedDefaults() {
    if (categories.length > 0) return;
    if (!confirm(`Seed ${DEFAULTS.length} default categories with their media? Only do this once on a fresh DB.`)) return;
    setSeeding(true);
    try {
      const newCats: HomeCategory[] = [];
      const newMedia: HomeMedia[]   = [];
      for (const seed of DEFAULTS) {
        const { data: cat } = await client.models.homeCategory.create({
          slug:      seed.slug,
          label:     seed.label,
          sortOrder: seed.sortOrder,
        });
        if (cat) newCats.push(cat);
        for (let i = 0; i < seed.items.length; i++) {
          const it = seed.items[i];
          const { data: m } = await client.models.homeMedia.create({
            categorySlug: seed.slug,
            kind:         it.kind as any,
            s3Key:        it.s3Key,
            caption:      it.caption,
            sortOrder:    i,
          });
          if (m) newMedia.push(m);
        }
      }
      setCategories((p) => [...p, ...newCats]);
      setMedia((p) => [...p, ...newMedia]);
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
            <NextLink href="/" className="hover:underline text-purple/70 dark:text-rose/70">
              ← Home page
            </NextLink>
          </div>

          <div className="flex items-center justify-between mb-5 gap-2 flex-wrap">
            <div>
              <h1 className="text-2xl font-bold text-purple dark:text-rose">Home Page</h1>
              <p className="text-xs text-gray-400 mt-0.5">
                Categories and media for the carousel at <code className="font-mono">/</code>.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {categories.length === 0 && !loading && (
                <button
                  onClick={handleSeedDefaults}
                  disabled={seeding}
                  className="px-3 py-1.5 rounded text-xs font-semibold border border-amber-400/60 text-amber-400 hover:bg-amber-400/10 transition-colors disabled:opacity-50"
                >
                  {seeding ? "Seeding…" : `Seed ${DEFAULTS.length} defaults`}
                </button>
              )}
              <button
                onClick={() => bulkInputRef.current?.click()}
                disabled={uploading}
                className="px-3 py-1.5 rounded text-xs font-semibold border border-gray-300 dark:border-darkBorder text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                title="Upload many files into the inbox; categorize + activate after."
              >
                {uploading ? "Uploading…" : "Bulk import → inbox"}
              </button>
              <input
                ref={bulkInputRef}
                type="file"
                multiple
                accept="image/*,video/*"
                onChange={handleBulkImport}
                className="hidden"
              />
              <button
                onClick={openNewCat}
                className="px-4 py-1.5 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity"
              >
                + New category
              </button>
            </div>
          </div>

          {loading ? (
            <p className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</p>
          ) : sortedCats.length === 0 ? (
            <div className="rounded-xl border border-gray-200 dark:border-darkBorder p-8 text-center">
              <p className="text-sm text-gray-400">No categories yet.</p>
            </div>
          ) : (
            <>
              {/* Category list — click a row to manage media on the right. */}
              <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden mb-6">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-darkElevated">
                    <tr className="text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium">
                      <th className="px-3 py-2 w-32">Slug</th>
                      <th className="px-3 py-2">Label</th>
                      <th className="px-3 py-2 w-20 text-right">Order</th>
                      <th className="px-3 py-2 w-20 text-right">Media</th>
                      <th className="px-3 py-2 w-24 text-center">Active</th>
                      <th className="px-3 py-2 w-16"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {sortedCats.map((c) => {
                      const items = mediaByCat.get(c.slug) ?? [];
                      const isSelected = activeSlug === c.slug;
                      const catActive  = c.isActive !== false;
                      return (
                        <tr
                          key={c.slug}
                          onClick={() => setActiveSlug(c.slug)}
                          className={`cursor-pointer transition-colors ${isSelected ? "bg-emerald-50/30 dark:bg-emerald-900/10" : "hover:bg-gray-50 dark:hover:bg-white/5"} ${catActive ? "" : "opacity-60"}`}
                        >
                          <td className="px-3 py-2 font-mono text-xs text-gray-500">{c.slug}</td>
                          <td className="px-3 py-2 text-gray-800 dark:text-gray-200">{c.label}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-xs text-gray-500">{c.sortOrder ?? 0}</td>
                          <td className="px-3 py-2 text-right text-xs text-gray-500 tabular-nums">{items.length}</td>
                          <td className="px-3 py-2 text-center">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleCatPatch(c.slug!, { isActive: !catActive }); }}
                              className={`px-2 py-0.5 rounded-full text-[10px] uppercase tracking-widest border transition-colors ${
                                catActive
                                  ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                                  : "border-gray-300 dark:border-darkBorder text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5"
                              }`}
                              title={catActive ? "Click to hide from public site" : "Click to show on public site"}
                            >
                              {catActive ? "On" : "Off"}
                            </button>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              onClick={(e) => { e.stopPropagation(); openEditCat(c); }}
                              className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 mr-2"
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

              {/* Media manager for the selected category. */}
              {activeCategory && (
                <section className="rounded-lg border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface p-4 mb-6">
                  <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                    <div>
                      <h2 className="text-base font-semibold text-purple dark:text-rose">
                        Media · {activeCategory.label}
                      </h2>
                      <p className="text-[11px] text-gray-400">
                        Click a thumbnail to edit caption / order. Lower order = first.
                      </p>
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept="image/*,video/*"
                      onChange={handleFileChange}
                      disabled={uploading}
                      className="text-xs text-gray-500"
                    />
                  </div>
                  {uploading && <p className="text-[11px] text-gray-400 animate-pulse">Uploading…</p>}

                  {activeMedia.length === 0 ? (
                    <p className="text-sm text-gray-400 py-6 text-center">No media yet — upload above.</p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {activeMedia.map((m) => {
                        const url = `${MEDIA_URL_PREFIX}${m.s3Key}`;
                        return (
                          <MediaCard
                            key={m.id}
                            media={m}
                            url={url}
                            onPatch={(patch) => handleMediaPatch(m, patch)}
                            onDelete={() => handleMediaDelete(m)}
                          />
                        );
                      })}
                    </div>
                  )}
                </section>
              )}
            </>
          )}

          {/* Inbox — bulk-imported media awaiting categorization. Shows even
              when there are no categories yet, so the admin can see where
              their uploads landed. */}
          {inboxMedia.length > 0 && (
            <section className="rounded-lg border border-amber-300/60 dark:border-amber-700/40 bg-amber-50/40 dark:bg-amber-900/10 p-4">
              <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                <div>
                  <h2 className="text-base font-semibold text-amber-700 dark:text-amber-300">
                    Inbox · {inboxMedia.length}
                  </h2>
                  <p className="text-[11px] text-amber-700/70 dark:text-amber-300/70">
                    Bulk-imported items. Pick a category and toggle Active to publish.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {inboxMedia.map((m) => {
                  const url = `${MEDIA_URL_PREFIX}${m.s3Key}`;
                  return (
                    <MediaCard
                      key={m.id}
                      media={m}
                      url={url}
                      categories={sortedCats}
                      onPatch={(patch) => handleMediaPatch(m, patch)}
                      onDelete={() => handleMediaDelete(m)}
                    />
                  );
                })}
              </div>
            </section>
          )}
        </div>

        {/* Category create/edit side panel */}
        {catPanel && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-96 border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
              <h2 className="text-base font-semibold dark:text-rose text-purple">
                {catPanel === "new" ? "New Category" : `Edit · ${catPanel.kind === "edit" ? catPanel.slug : ""}`}
              </h2>
              <button onClick={() => setCatPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <div>
                <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium block mb-1">Slug *</label>
                <input
                  type="text"
                  disabled={catPanel !== "new"}
                  value={catDraft.slug}
                  onChange={(e) => setCatDraft((d) => ({ ...d, slug: e.target.value }))}
                  className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1.5 text-sm font-mono text-gray-800 dark:text-gray-200 disabled:opacity-60"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">URL-safe key. Locked after creation.</p>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium block mb-1">Label *</label>
                <input
                  type="text"
                  value={catDraft.label}
                  onChange={(e) => setCatDraft((d) => ({ ...d, label: e.target.value }))}
                  placeholder="photos"
                  className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1.5 text-sm text-gray-800 dark:text-gray-200"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">Visible tab text on the home page.</p>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium block mb-1">Sort order</label>
                <input
                  type="number"
                  value={catDraft.sortOrder}
                  onChange={(e) => setCatDraft((d) => ({ ...d, sortOrder: parseInt(e.target.value, 10) || 0 }))}
                  className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1.5 text-sm text-gray-800 dark:text-gray-200"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">Ascending. Lowest = leftmost tab and the default selected.</p>
              </div>
              <button
                onClick={handleSaveCat}
                disabled={saving}
                className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple disabled:opacity-50 transition-opacity"
              >
                {saving ? "Saving…" : catPanel === "new" ? "Create category" : "Save"}
              </button>
              {catPanel !== "new" && (
                <button
                  onClick={() => handleDeleteCat(catPanel.slug)}
                  disabled={saving}
                  className="text-[11px] text-gray-400 hover:text-red-500 transition-colors disabled:opacity-30 self-start"
                >
                  Delete category
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </DefaultLayout>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function MediaCard({
  media, url, categories, onPatch, onDelete,
}: {
  media:      HomeMedia;
  url:        string;
  // When provided, renders a category picker — used by the inbox so the user
  // can move an item into a category.
  categories?: HomeCategory[];
  onPatch:    (patch: Partial<HomeMedia>) => Promise<void>;
  onDelete:   () => Promise<void> | void;
}) {
  const [caption, setCaption] = useState(media.caption ?? "");
  const [order, setOrder]     = useState(media.sortOrder ?? 0);
  const isActive = media.isActive !== false;

  // Persist edits on blur — small enough scope to skip an explicit Save button.
  const commitCaption = () => {
    if ((media.caption ?? "") !== caption) onPatch({ caption });
  };
  const commitOrder = () => {
    if ((media.sortOrder ?? 0) !== order) onPatch({ sortOrder: order });
  };

  return (
    <div className={`rounded border border-gray-200 dark:border-darkBorder overflow-hidden bg-gray-50 dark:bg-darkBg/40 ${isActive ? "" : "opacity-70"}`}>
      {media.kind === "VIDEO" ? (
        <video src={`${url}#t=0.1`} className="w-full h-32 object-cover bg-black" muted playsInline preload="metadata" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={media.caption ?? ""} className="w-full h-32 object-cover" loading="lazy" />
      )}
      <div className="p-2 flex flex-col gap-1.5">
        {categories && (
          <select
            value={media.categorySlug ?? ""}
            onChange={(e) => onPatch({ categorySlug: e.target.value || null })}
            className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1 text-xs text-gray-800 dark:text-gray-200"
          >
            <option value="">— Inbox —</option>
            {categories.map((c) => (
              <option key={c.slug} value={c.slug ?? ""}>{c.label}</option>
            ))}
          </select>
        )}
        <input
          type="text"
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          onBlur={commitCaption}
          placeholder="Caption"
          className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1 text-xs text-gray-800 dark:text-gray-200"
        />
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={order}
            onChange={(e) => setOrder(parseInt(e.target.value, 10) || 0)}
            onBlur={commitOrder}
            className="w-20 bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1 text-xs text-gray-800 dark:text-gray-200"
            title="Sort order"
          />
          <button
            onClick={() => onPatch({ isActive: !isActive })}
            className={`px-2 py-0.5 rounded-full text-[10px] uppercase tracking-widest border transition-colors ${
              isActive
                ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                : "border-gray-300 dark:border-darkBorder text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5"
            }`}
            title={isActive ? "Click to hide from public site" : "Click to show on public site"}
          >
            {isActive ? "On" : "Off"}
          </button>
          <button
            onClick={onDelete}
            className="ml-auto text-[10px] text-gray-400 hover:text-red-500 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
