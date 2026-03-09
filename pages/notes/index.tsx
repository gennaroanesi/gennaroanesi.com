import React, { useEffect, useState } from "react";
import NextLink from "next/link";
import NotesLayout, { NOTES_COLOR } from "@/layouts/notes";
import { listNotes, NoteFile, ParaSection } from "@/components/notes/_shared";

const SECTIONS: { key: ParaSection; icon: string; desc: string; href: string }[] = [
  { key: "Projects",  icon: "🎯", desc: "Outcomes with a deadline",      href: "/notes/projects"  },
  { key: "Areas",     icon: "🔁", desc: "Ongoing responsibilities",       href: "/notes/areas"     },
  { key: "Resources", icon: "📚", desc: "Reference material & research",  href: "/notes/resources" },
  { key: "Archives",  icon: "🗄️", desc: "Completed or inactive items",    href: "/notes/archives"  },
];

export default function NotesIndex() {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [recent, setRecent] = useState<NoteFile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const all = await listNotes();
        const c: Record<string, number> = {};
        SECTIONS.forEach((s) => {
          c[s.key] = all.filter((n) => n.section === s.key).length;
        });
        setCounts(c);
        setRecent(
          [...all]
            .sort((a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0))
            .slice(0, 6)
        );
      } catch {
        // S3 not configured yet or no files — silently show zeros
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <NotesLayout>
      <div className="max-w-3xl mx-auto flex flex-col gap-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">Notes</h1>
          <p className="text-sm text-gray-500 mt-1">
            PARA system · synced to S3 via Remotely Save
          </p>
        </div>

        {/* PARA cards */}
        <div className="grid grid-cols-2 gap-4">
          {SECTIONS.map((s) => (
            <NextLink key={s.key} href={s.href}>
              <div className="border border-gray-100 dark:border-gray-800 rounded-xl p-5 hover:border-gray-300 dark:hover:border-gray-600 transition-colors cursor-pointer">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-2xl">{s.icon}</span>
                  {!loading && (
                    <span
                      className="text-xs font-semibold tabular-nums px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: NOTES_COLOR + "20", color: NOTES_COLOR }}
                    >
                      {counts[s.key] ?? 0}
                    </span>
                  )}
                </div>
                <p className="font-semibold text-gray-800 dark:text-gray-100">{s.key}</p>
                <p className="text-xs text-gray-400 mt-0.5">{s.desc}</p>
              </div>
            </NextLink>
          ))}
        </div>

        {/* Recently modified */}
        {recent.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
              Recently Modified
            </h2>
            <div className="flex flex-col gap-1">
              {recent.map((note) => (
                <NextLink
                  key={note.key}
                  href={`/notes/${note.section.toLowerCase()}/${note.name}`}
                  className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
                      {SECTIONS.find((s) => s.key === note.section)?.icon}
                    </span>
                    <span className="text-sm text-gray-700 dark:text-gray-300">{note.label}</span>
                  </div>
                  <span className="text-xs text-gray-400">
                    {note.lastModified?.toLocaleDateString() ?? ""}
                  </span>
                </NextLink>
              ))}
            </div>
          </div>
        )}

        {loading && (
          <p className="text-sm text-gray-400 animate-pulse">Loading notes from S3…</p>
        )}
      </div>
    </NotesLayout>
  );
}
