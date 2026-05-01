import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { GetStaticProps, NextPage } from "next";
import NextLink from "next/link";
import fs from "fs";
import path from "path";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import DefaultLayout from "@/layouts/default";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import { ProjectArticle } from "@/components/common/ProjectArticle";

type Writeup = Schema["projectWriteup"]["type"];

// Title + description for seedable defaults. After the one-time seed, these
// values live on each writeup row and the user manages them through the UI.
// Higher sortOrder = appears first.
const SEED_META: Record<string, { title: string; description: string; sortOrder: number }> = {
  "home-hub": {
    title: "Home Hub",
    description:
      "Building a natural-language home hub with Claude — architecture, the design decision that mattered, and the war stories worth retelling.",
    sortOrder: 100,
  },
  flying: {
    title: "Flight Log",
    description:
      "Building a 3D flight log site with Claude — Cesium globe, KML routes, FAA chart archive, and video-to-route sync.",
    sortOrder: 90,
  },
};

const PROJECTS_DIR = path.join(process.cwd(), "content", "projects");

type SeedFile = { slug: string; markdown: string };

type Props = { seedFiles: SeedFile[] };

// Read the legacy .md files at build time. They become the seed payload for
// the "Seed defaults" button. After the one-time seed, the DB is authoritative
// and the .md files are orphaned (but harmless).
export const getStaticProps: GetStaticProps<Props> = async () => {
  let seedFiles: SeedFile[] = [];
  try {
    const files = fs.readdirSync(PROJECTS_DIR).filter((f) => f.endsWith(".md"));
    seedFiles = files.map((f) => ({
      slug: f.replace(/\.md$/, ""),
      markdown: fs.readFileSync(path.join(PROJECTS_DIR, f), "utf8"),
    }));
  } catch { /* directory missing — nothing to seed */ }
  return { props: { seedFiles } };
};

const client = generateClient<Schema>();

type DraftState = {
  slug:        string;
  title:       string;
  description: string;
  markdown:    string;
  published:   boolean;
  sortOrder:   number;
};

function emptyDraft(): DraftState {
  return { slug: "", title: "", description: "", markdown: "", published: true, sortOrder: 0 };
}

function fromWriteup(w: Writeup): DraftState {
  return {
    slug:        w.slug ?? "",
    title:       w.title ?? "",
    description: w.description ?? "",
    markdown:    w.markdown ?? "",
    published:   w.published ?? true,
    sortOrder:   w.sortOrder ?? 0,
  };
}

type PanelMode = null | { kind: "new" } | { kind: "edit"; slug: string };

const AdminProjectsPage: NextPage<Props> = ({ seedFiles }) => {
  const { authState } = useRequireAuth();

  const [writeups, setWriteups] = useState<Writeup[]>([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [seeding, setSeeding]   = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>(null);
  const [draft, setDraft]         = useState<DraftState>(emptyDraft());
  const [showPreview, setShowPreview] = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.models.projectWriteup.list({ limit: 100 });
      setWriteups(data ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchAll();
  }, [authState, fetchAll]);

  const sorted = useMemo(
    () => [...writeups].sort((a, b) => (b.sortOrder ?? 0) - (a.sortOrder ?? 0)),
    [writeups],
  );

  // ── Mutations ──────────────────────────────────────────────────────────
  function openNew() {
    setDraft(emptyDraft());
    setPanelMode({ kind: "new" });
  }

  function openEdit(w: Writeup) {
    setDraft(fromWriteup(w));
    setPanelMode({ kind: "edit", slug: w.slug ?? "" });
  }

  async function handleSave() {
    if (!draft.slug.trim() || !draft.title.trim() || !draft.markdown.trim()) {
      alert("Slug, title, and markdown are all required.");
      return;
    }
    const safeSlug = draft.slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    setSaving(true);
    try {
      const payload = {
        slug:        safeSlug,
        title:       draft.title.trim(),
        description: draft.description.trim() || null,
        markdown:    draft.markdown,
        published:   draft.published,
        sortOrder:   draft.sortOrder,
      };
      if (panelMode?.kind === "new") {
        const { data } = await client.models.projectWriteup.create(payload);
        if (data) setWriteups((p) => [...p, data]);
      } else if (panelMode?.kind === "edit") {
        // slug is the identifier — pass the original slug, not the (possibly
        // edited) draft slug. We don't allow slug editing on update.
        const { data } = await client.models.projectWriteup.update({
          slug: panelMode.slug,
          title:       payload.title,
          description: payload.description,
          markdown:    payload.markdown,
          published:   payload.published,
          sortOrder:   payload.sortOrder,
        });
        if (data) setWriteups((p) => p.map((w) => w.slug === panelMode.slug ? data : w));
      }
      setPanelMode(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!panelMode || panelMode.kind !== "edit") return;
    if (!confirm(`Delete "${draft.title || panelMode.slug}"? The /projects/${panelMode.slug} URL will return "not found".`)) return;
    setSaving(true);
    try {
      await client.models.projectWriteup.delete({ slug: panelMode.slug });
      setWriteups((p) => p.filter((w) => w.slug !== panelMode.slug));
      setPanelMode(null);
    } finally {
      setSaving(false);
    }
  }

  // One-time seed of legacy filesystem writeups.
  async function handleSeedDefaults() {
    if (writeups.length > 0) return;
    if (seedFiles.length === 0) {
      alert("No content/projects/*.md files found to seed from.");
      return;
    }
    if (!confirm(`Seed ${seedFiles.length} default writeups from content/projects/*.md? Only do this once.`)) return;
    setSeeding(true);
    try {
      const created: Writeup[] = [];
      for (const f of seedFiles) {
        const meta = SEED_META[f.slug] ?? {
          title: f.slug,
          description: "",
          sortOrder: 0,
        };
        const { data } = await client.models.projectWriteup.create({
          slug:        f.slug,
          title:       meta.title,
          description: meta.description,
          markdown:    f.markdown,
          published:   true,
          sortOrder:   meta.sortOrder,
        });
        if (data) created.push(data);
      }
      setWriteups((p) => [...p, ...created]);
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
              <h1 className="text-2xl font-bold text-purple dark:text-rose">Project Writeups</h1>
              <p className="text-xs text-gray-400 mt-0.5">
                Long-form articles served at <code className="font-mono">/projects/&lt;slug&gt;</code>.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {writeups.length === 0 && !loading && seedFiles.length > 0 && (
                <button
                  onClick={handleSeedDefaults}
                  disabled={seeding}
                  className="px-3 py-1.5 rounded text-xs font-semibold border border-amber-400/60 text-amber-400 hover:bg-amber-400/10 transition-colors disabled:opacity-50"
                  title="One-time: import the .md files into the DB"
                >
                  {seeding ? "Seeding…" : `Seed ${seedFiles.length} defaults`}
                </button>
              )}
              <button
                onClick={openNew}
                className="px-4 py-1.5 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity"
              >
                + New writeup
              </button>
            </div>
          </div>

          {loading ? (
            <p className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</p>
          ) : sorted.length === 0 ? (
            <div className="rounded-xl border border-gray-200 dark:border-darkBorder p-8 text-center">
              <p className="text-sm text-gray-400">No project writeups yet.</p>
            </div>
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-darkElevated">
                  <tr className="text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium">
                    <th className="px-3 py-2 w-32">Slug</th>
                    <th className="px-3 py-2">Title / description</th>
                    <th className="px-3 py-2 w-20 text-right">Order</th>
                    <th className="px-3 py-2 w-24 text-center">Published</th>
                    <th className="px-3 py-2 w-16"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sorted.map((w) => (
                    <tr
                      key={w.slug}
                      className="hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer"
                      onClick={() => openEdit(w)}
                    >
                      <td className="px-3 py-2 font-mono text-xs text-gray-500">{w.slug}</td>
                      <td className="px-3 py-2">
                        <p className="text-gray-800 dark:text-gray-200 font-medium">{w.title}</p>
                        {w.description && (
                          <p className="text-[11px] text-gray-400 truncate max-w-[480px]">{w.description}</p>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs text-gray-500">
                        {w.sortOrder ?? 0}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {w.published === false ? (
                          <span className="text-[10px] uppercase tracking-widest text-amber-500">Draft</span>
                        ) : (
                          <span className="text-[10px] uppercase tracking-widest text-emerald-500">Live</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={(e) => { e.stopPropagation(); openEdit(w); }}
                          className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Side panel — wider than the timeline admin so the markdown editor
            and the live preview can sit side-by-side on a comfortable width. */}
        {panelMode && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-[44rem] border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
              <h2 className="text-base font-semibold dark:text-rose text-purple">
                {panelMode.kind === "new" ? "New Writeup" : `Edit · ${panelMode.slug}`}
              </h2>
              <div className="flex items-center gap-3">
                {panelMode.kind === "edit" && draft.published && (
                  <NextLink
                    href={`/projects/${panelMode.slug}`}
                    target="_blank"
                    className="text-[11px] text-gray-400 hover:text-purple dark:hover:text-rose transition-colors"
                  >
                    View public ↗
                  </NextLink>
                )}
                <button onClick={() => setPanelMode(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">
                  ×
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-1">
                  <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium block mb-1">
                    Slug *
                  </label>
                  <input
                    type="text"
                    disabled={panelMode.kind === "edit"}
                    value={draft.slug}
                    onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value }))}
                    placeholder="home-hub"
                    className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1.5 text-sm font-mono text-gray-800 dark:text-gray-200 disabled:opacity-60"
                  />
                </div>
                <div className="col-span-2">
                  <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium block mb-1">
                    Title *
                  </label>
                  <input
                    type="text"
                    value={draft.title}
                    onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                    className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1.5 text-sm text-gray-800 dark:text-gray-200"
                  />
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium block mb-1">
                  Description <span className="normal-case tracking-normal text-gray-400">· share preview / SEO</span>
                </label>
                <textarea
                  value={draft.description}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                  rows={2}
                  className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1.5 text-sm text-gray-800 dark:text-gray-200 resize-y"
                />
              </div>

              {/* Editor + preview header */}
              <div className="flex items-center justify-between">
                <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">
                  Markdown *
                </label>
                <button
                  onClick={() => setShowPreview((v) => !v)}
                  className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
                >
                  {showPreview ? "Hide preview" : "Show preview"}
                </button>
              </div>

              <div className={showPreview ? "grid grid-cols-2 gap-3" : ""}>
                <textarea
                  value={draft.markdown}
                  onChange={(e) => setDraft((d) => ({ ...d, markdown: e.target.value }))}
                  rows={24}
                  placeholder="# Heading…"
                  className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-2 text-xs text-gray-800 dark:text-gray-200 resize-y font-mono leading-relaxed"
                  style={{ minHeight: "32rem" }}
                />
                {showPreview && (
                  <div className="border border-gray-200 dark:border-darkBorder rounded p-4 bg-gray-50 dark:bg-darkBg/40 overflow-y-auto" style={{ minHeight: "32rem", maxHeight: "32rem" }}>
                    {draft.markdown.trim() ? (
                      <div className="text-purple/90 dark:text-rose/90">
                        <ProjectArticle markdown={draft.markdown} />
                      </div>
                    ) : (
                      <p className="text-xs text-gray-400 italic">Preview appears here as you type.</p>
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium block mb-1">Sort order</label>
                  <input
                    type="number"
                    value={draft.sortOrder}
                    onChange={(e) => setDraft((d) => ({ ...d, sortOrder: parseInt(e.target.value, 10) || 0 }))}
                    className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1.5 text-sm text-gray-800 dark:text-gray-200"
                  />
                  <p className="text-[10px] text-gray-400 mt-0.5">Higher = first in lists.</p>
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.published}
                      onChange={(e) => setDraft((d) => ({ ...d, published: e.target.checked }))}
                    />
                    Published
                  </label>
                </div>
              </div>

              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple disabled:opacity-50 transition-opacity"
              >
                {saving ? "Saving…" : panelMode.kind === "new" ? "Create writeup" : "Save"}
              </button>
              {panelMode.kind === "edit" && (
                <button
                  onClick={handleDelete}
                  disabled={saving}
                  className="text-[11px] text-gray-400 hover:text-red-500 transition-colors disabled:opacity-30 self-start"
                >
                  Delete writeup
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </DefaultLayout>
  );
};

export default AdminProjectsPage;
