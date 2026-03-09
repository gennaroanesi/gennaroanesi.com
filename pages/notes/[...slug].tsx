/**
 * /notes/[...slug]
 *
 * Handles two URL shapes:
 *   /notes/projects              → section browser (file list)
 *   /notes/projects/ir-checkride → individual note viewer/editor
 *
 * slug[0] = section (projects | areas | resources | archives)
 * slug[1] = note name (optional, filename without .md)
 */

import React, { useEffect, useState, useRef } from "react";
import { useRouter } from "next/router";
import NextLink from "next/link";
import NotesLayout, { NOTES_COLOR } from "@/layouts/notes";
import {
  listNotes,
  readNote,
  writeNote,
  deleteNote,
  buildKey,
  noteTemplate,
  NoteFile,
  ParaSection,
} from "@/components/notes/_shared";

// ── Markdown renderer ─────────────────────────────────────────────────────────
import { marked } from "marked";

function MarkdownView({ content }: { content: string }) {
  const html = marked(content) as string;
  return (
    <div
      className="prose prose-sm dark:prose-invert max-w-none"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ── Section label map ─────────────────────────────────────────────────────────
const SLUG_TO_SECTION: Record<string, ParaSection> = {
  projects:  "Projects",
  areas:     "Areas",
  resources: "Resources",
  archives:  "Archives",
};

const SECTION_ICONS: Record<ParaSection, string> = {
  Projects:  "🎯",
  Areas:     "🔁",
  Resources: "📚",
  Archives:  "🗄️",
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function NotesSlug() {
  const router = useRouter();
  const { slug } = router.query;
  const slugArr = Array.isArray(slug) ? slug : slug ? [slug] : [];

  const sectionSlug = slugArr[0] ?? "projects";
  const noteName    = slugArr[1];
  const section     = SLUG_TO_SECTION[sectionSlug] ?? "Projects";

  // ── Section browser state ──────────────────────────────────────────────────
  const [notes, setNotes]           = useState<NoteFile[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [search, setSearch]         = useState("");
  const [newTitle, setNewTitle]     = useState("");
  const [creating, setCreating]     = useState(false);

  // ── Note viewer/editor state ───────────────────────────────────────────────
  const [content, setContent]       = useState("");
  const [draft, setDraft]           = useState("");
  const [noteLoading, setNoteLoading] = useState(false);
  const [saving, setSaving]         = useState(false);
  const [deleting, setDeleting]     = useState(false);
  const [editing, setEditing]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Load file list ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!router.isReady) return;
    setListLoading(true);
    listNotes(section)
      .then(setNotes)
      .catch(() => setNotes([]))
      .finally(() => setListLoading(false));
  }, [section, router.isReady]);

  // ── Load note content ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!router.isReady || !noteName) return;
    const key = `PARA/${section}/${noteName}.md`;
    setNoteLoading(true);
    setEditing(false);
    setError(null);
    readNote(key)
      .then((c) => { setContent(c); setDraft(c); })
      .catch(() => setError("Could not load note."))
      .finally(() => setNoteLoading(false));
  }, [noteName, section, router.isReady]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  async function handleCreate() {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const key = buildKey(section, newTitle);
      const body = noteTemplate(newTitle, section);
      await writeNote(key, body);
      const slug = key.split("/").pop()!.replace(/\.md$/, "");
      router.push(`/notes/${sectionSlug}/${slug}`);
    } finally {
      setCreating(false);
      setNewTitle("");
    }
  }

  async function handleSave() {
    if (!noteName) return;
    const key = `PARA/${section}/${noteName}.md`;
    setSaving(true);
    try {
      await writeNote(key, draft);
      setContent(draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!noteName || !confirm("Delete this note? This cannot be undone.")) return;
    const key = `PARA/${section}/${noteName}.md`;
    setDeleting(true);
    try {
      await deleteNote(key);
      router.push(`/notes/${sectionSlug}`);
    } finally {
      setDeleting(false);
    }
  }

  const filtered = notes.filter((n) =>
    n.label.toLowerCase().includes(search.toLowerCase())
  );

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER: individual note
  // ─────────────────────────────────────────────────────────────────────────
  if (noteName) {
    return (
      <NotesLayout>
        <div className="max-w-3xl mx-auto flex flex-col gap-4">
          {/* Breadcrumb */}
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <NextLink href="/notes" className="hover:text-gray-600 dark:hover:text-gray-300">Notes</NextLink>
            <span>/</span>
            <NextLink href={`/notes/${sectionSlug}`} className="hover:text-gray-600 dark:hover:text-gray-300">
              {section}
            </NextLink>
            <span>/</span>
            <span className="text-gray-700 dark:text-gray-200 font-medium">
              {noteName.replace(/-/g, " ")}
            </span>
          </div>

          {noteLoading && (
            <p className="text-sm text-gray-400 animate-pulse">Loading…</p>
          )}

          {error && (
            <p className="text-sm text-red-500">{error}</p>
          )}

          {!noteLoading && !error && (
            <>
              {/* Toolbar */}
              <div className="flex items-center justify-between gap-2">
                {editing ? (
                  <div className="flex gap-2">
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white transition-opacity hover:opacity-80 disabled:opacity-50"
                      style={{ backgroundColor: NOTES_COLOR }}
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={() => { setDraft(content); setEditing(false); }}
                      className="px-4 py-1.5 rounded-lg text-xs font-semibold text-gray-600 bg-gray-100 dark:bg-gray-800 dark:text-gray-300 hover:opacity-80"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setEditing(true); setTimeout(() => textareaRef.current?.focus(), 50); }}
                    className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white transition-opacity hover:opacity-80"
                    style={{ backgroundColor: NOTES_COLOR }}
                  >
                    Edit
                  </button>
                )}
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold text-red-500 bg-red-50 dark:bg-red-900/20 hover:opacity-80 disabled:opacity-50"
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>

              {/* Editor / Viewer */}
              {editing ? (
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="w-full min-h-[60vh] rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 text-sm font-mono text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 resize-y"
                  style={{ "--tw-ring-color": NOTES_COLOR } as React.CSSProperties}
                />
              ) : (
                <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900/50 p-6">
                  <MarkdownView content={content} />
                </div>
              )}
            </>
          )}
        </div>
      </NotesLayout>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER: section browser
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <NotesLayout>
      <div className="max-w-3xl mx-auto flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <span className="text-3xl">{SECTION_ICONS[section]}</span>
          <div>
            <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">{section}</h1>
            <p className="text-xs text-gray-400">{notes.length} note{notes.length !== 1 ? "s" : ""}</p>
          </div>
        </div>

        {/* New note */}
        <div className="flex gap-2">
          <input
            type="text"
            placeholder={`New ${section.toLowerCase().replace(/s$/, "")} title…`}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="flex-1 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2"
            style={{ "--tw-ring-color": NOTES_COLOR } as React.CSSProperties}
          />
          <button
            onClick={handleCreate}
            disabled={creating || !newTitle.trim()}
            className="px-4 py-2 rounded-lg text-xs font-semibold text-white transition-opacity hover:opacity-80 disabled:opacity-50"
            style={{ backgroundColor: NOTES_COLOR }}
          >
            {creating ? "Creating…" : "+ New"}
          </button>
        </div>

        {/* Search */}
        {notes.length > 5 && (
          <input
            type="text"
            placeholder="Filter notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 focus:outline-none"
          />
        )}

        {/* File list */}
        {listLoading ? (
          <p className="text-sm text-gray-400 animate-pulse">Loading from S3…</p>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p className="text-4xl mb-3">{SECTION_ICONS[section]}</p>
            <p className="text-sm">No notes yet. Create one above.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {filtered.map((note) => (
              <NextLink
                key={note.key}
                href={`/notes/${sectionSlug}/${note.name}`}
                className="flex items-center justify-between px-4 py-3 rounded-xl border border-transparent hover:border-gray-200 dark:hover:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group"
              >
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-white">
                  {note.label}
                </span>
                <span className="text-xs text-gray-400">
                  {note.lastModified?.toLocaleDateString() ?? ""}
                </span>
              </NextLink>
            ))}
          </div>
        )}
      </div>
    </NotesLayout>
  );
}
