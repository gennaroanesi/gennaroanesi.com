/**
 * AttachmentsSection — reusable attachment list / upload / view / delete UI.
 *
 * Drop into any edit panel or detail page. Renders the list of attachments
 * for (parentType, parentId), an upload control, and per-row view + delete
 * actions. Files live under `attachments/{parentType}/{parentId}/{ts}-{name}`
 * in the gennaroanesi.com bucket; they require Cognito auth to read so we
 * generate short-lived signed URLs via Amplify Storage `getUrl` for
 * previewing/downloading.
 *
 * The `disabled` flag is used by callers to grey out the section while the
 * parent record doesn't exist yet (e.g. a transaction being created).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { generateClient } from "aws-amplify/data";
import { uploadData, remove as s3Remove, getUrl } from "aws-amplify/storage";
import type { Schema } from "@/amplify/data/resource";

const BUCKET_NAME = "gennaroanesi.com";
const client = generateClient<Schema>();

export type AttachmentParentType = "TRANSACTION" | "ACCOUNT" | "LOAN";
type Attachment = Schema["attachment"]["type"];

/**
 * Cascade-delete every attachment (S3 + DB) belonging to a parent. Callers
 * use this from their existing handleDelete flows so attachments don't get
 * orphaned. Best-effort — a failed S3 delete logs and continues so a partial
 * cleanup doesn't block the parent delete.
 */
export async function deleteAttachmentsFor(parentType: AttachmentParentType, parentId: string) {
  const { data } = await client.models.attachment.list({
    filter: { parentId: { eq: parentId }, parentType: { eq: parentType } },
    limit:  500,
  });
  for (const att of data ?? []) {
    if (att.s3Key) {
      try { await s3Remove({ path: att.s3Key, options: { bucket: BUCKET_NAME } }); }
      catch (e) { console.warn("[attachments] s3 delete failed:", e); }
    }
    try { await client.models.attachment.delete({ id: att.id }); }
    catch (e) { console.warn("[attachments] db delete failed:", e); }
  }
}

function fmtSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentsSection({
  parentType,
  parentId,
  disabled = false,
  className = "",
}: {
  parentType: AttachmentParentType;
  parentId:   string | null | undefined;
  /** When true, hides the upload control and renders a hint instead. */
  disabled?:  boolean;
  className?: string;
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading,    setLoading]      = useState(false);
  const [uploading,  setUploading]    = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    if (!parentId) { setAttachments([]); return; }
    setLoading(true);
    try {
      const { data } = await client.models.attachment.list({
        filter: { parentId: { eq: parentId }, parentType: { eq: parentType } },
        limit:  500,
      });
      setAttachments((data ?? []).slice().sort(
        (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
      ));
    } finally {
      setLoading(false);
    }
  }, [parentType, parentId]);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!parentId) return;
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const created: Attachment[] = [];
      for (const file of Array.from(files)) {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
        const key = `attachments/${parentType}/${parentId}/${Date.now()}-${safeName}`;
        await uploadData({
          path:    key,
          data:    file,
          options: { bucket: BUCKET_NAME, contentType: file.type || "application/octet-stream" },
        }).result;
        const { data } = await client.models.attachment.create({
          parentType:  parentType as any,
          parentId,
          s3Key:       key,
          filename:    file.name,
          contentType: file.type || null,
          sizeBytes:   file.size,
          caption:     null,
        });
        if (data) created.push(data);
      }
      if (created.length) setAttachments((p) => [...created, ...p]);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleView(att: Attachment) {
    if (!att.s3Key) return;
    try {
      const { url } = await getUrl({
        path:    att.s3Key,
        options: { bucket: BUCKET_NAME, expiresIn: 300 },
      });
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    } catch (e) {
      console.warn("[attachments] getUrl failed:", e);
      alert("Could not generate a download link for this file.");
    }
  }

  async function handleCaption(att: Attachment, caption: string) {
    if ((att.caption ?? "") === caption) return;
    const { data } = await client.models.attachment.update({ id: att.id, caption: caption || null });
    if (data) setAttachments((p) => p.map((a) => a.id === att.id ? data : a));
  }

  async function handleDelete(att: Attachment) {
    if (!confirm(`Delete "${att.filename}"?`)) return;
    if (att.s3Key) {
      try { await s3Remove({ path: att.s3Key, options: { bucket: BUCKET_NAME } }); }
      catch (e) { console.warn("[attachments] s3 delete failed:", e); }
    }
    await client.models.attachment.delete({ id: att.id });
    setAttachments((p) => p.filter((a) => a.id !== att.id));
  }

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">
          Attachments {attachments.length > 0 && <span className="text-gray-500">· {attachments.length}</span>}
        </label>
        {!disabled && parentId && (
          <>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="text-[11px] px-2 py-0.5 rounded border border-gray-300 dark:border-darkBorder text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              {uploading ? "Uploading…" : "+ Add file"}
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              onChange={handleUpload}
              className="hidden"
            />
          </>
        )}
      </div>

      {disabled && (
        <p className="text-[11px] text-gray-400 italic">
          Save first, then attach files.
        </p>
      )}

      {!disabled && parentId && (
        <>
          {loading && attachments.length === 0 && (
            <p className="text-[11px] text-gray-400 animate-pulse">Loading attachments…</p>
          )}
          {!loading && attachments.length === 0 && (
            <p className="text-[11px] text-gray-400 italic">No attachments yet.</p>
          )}
          {attachments.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {attachments.map((att) => (
                <AttachmentRow
                  key={att.id}
                  att={att}
                  onView={() => handleView(att)}
                  onCaption={(c) => handleCaption(att, c)}
                  onDelete={() => handleDelete(att)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function AttachmentRow({
  att, onView, onCaption, onDelete,
}: {
  att:       Attachment;
  onView:    () => void;
  onCaption: (caption: string) => void;
  onDelete:  () => void;
}) {
  const [caption, setCaption] = useState(att.caption ?? "");
  const isImage = (att.contentType ?? "").startsWith("image/");
  const isPdf   = (att.contentType ?? "") === "application/pdf";
  const icon    = isImage ? "🖼️" : isPdf ? "📄" : "📎";
  return (
    <li className="rounded border border-gray-200 dark:border-darkBorder bg-gray-50/50 dark:bg-white/[0.02] p-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-base leading-none" aria-hidden>{icon}</span>
        <button
          type="button"
          onClick={onView}
          className="text-xs font-medium text-gray-800 dark:text-gray-200 hover:underline truncate flex-1 text-left"
          title={att.filename}
        >
          {att.filename}
        </button>
        <span className="text-[10px] text-gray-400 tabular-nums whitespace-nowrap">{fmtSize(att.sizeBytes)}</span>
        <button
          type="button"
          onClick={onDelete}
          className="text-[10px] text-gray-400 hover:text-red-500 transition-colors"
        >
          Delete
        </button>
      </div>
      <input
        type="text"
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        onBlur={() => onCaption(caption)}
        placeholder="Caption / description"
        className="w-full bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-2 py-1 text-[11px] text-gray-700 dark:text-gray-200"
      />
    </li>
  );
}
