/**
 * Shared types and utilities for the Notes (PARA) section.
 * Files live in S3 under the PARA/ prefix, synced via Remotely Save in Obsidian.
 */

import { getUrl, list, uploadData, remove } from "aws-amplify/storage";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ParaSection = "Projects" | "Areas" | "Resources" | "Archives";

export interface NoteFile {
  key: string;       // full S3 key, e.g. "PARA/Projects/ir-checkride.md"
  name: string;      // filename without extension, e.g. "ir-checkride"
  label: string;     // display name, e.g. "Ir Checkride"
  section: ParaSection;
  lastModified?: Date;
  size?: number;
}

// ── S3 prefix convention ──────────────────────────────────────────────────────

export const PARA_PREFIX = "PARA/";

export function sectionPrefix(section: ParaSection): string {
  return `PARA/${section}/`;
}

export function keyToLabel(filename: string): string {
  return filename
    .replace(/\.md$/i, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function keyToName(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1].replace(/\.md$/i, "");
}

export function sectionFromKey(key: string): ParaSection {
  if (key.startsWith("PARA/Projects/"))  return "Projects";
  if (key.startsWith("PARA/Areas/"))     return "Areas";
  if (key.startsWith("PARA/Resources/")) return "Resources";
  if (key.startsWith("PARA/Archives/"))  return "Archives";
  return "Projects";
}

// ── S3 operations ─────────────────────────────────────────────────────────────

/** List all notes under a PARA section (or all sections if none given). */
export async function listNotes(section?: ParaSection): Promise<NoteFile[]> {
  const prefix = section ? sectionPrefix(section) : PARA_PREFIX;
  const result = await list({ path: prefix, options: { pageSize: 1000 } });

  return result.items
    .filter((item) => item.path.endsWith(".md"))
    .map((item) => ({
      key:          item.path,
      name:         keyToName(item.path),
      label:        keyToLabel(keyToName(item.path)),
      section:      sectionFromKey(item.path),
      lastModified: item.lastModified,
      size:         item.size,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Read the markdown content of a note. */
export async function readNote(key: string): Promise<string> {
  const { url } = await getUrl({ path: key });
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Failed to read note: ${res.status}`);
  return res.text();
}

/** Write (create or overwrite) a note. */
export async function writeNote(key: string, content: string): Promise<void> {
  await uploadData({
    path: key,
    data: new Blob([content], { type: "text/markdown; charset=utf-8" }),
  }).result;
}

/** Delete a note. */
export async function deleteNote(key: string): Promise<void> {
  await remove({ path: key });
}

/** Build the S3 key for a new note. */
export function buildKey(section: ParaSection, title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "");
  return `PARA/${section}/${slug}.md`;
}

/** Starter template for a new note. */
export function noteTemplate(title: string, section: ParaSection): string {
  const date = new Date().toISOString().slice(0, 10);
  const templates: Record<ParaSection, string> = {
    Projects: `# ${title}\n\n**Created:** ${date}  \n**Status:** Active  \n**Goal:**  \n\n---\n\n## Overview\n\n\n## Next Actions\n\n- [ ] \n\n## Notes\n\n`,
    Areas: `# ${title}\n\n**Created:** ${date}  \n\n---\n\n## Purpose\n\n\n## Notes\n\n`,
    Resources: `# ${title}\n\n**Created:** ${date}  \n\n---\n\n`,
    Archives: `# ${title}\n\n**Archived:** ${date}  \n\n---\n\n`,
  };
  return templates[section];
}
