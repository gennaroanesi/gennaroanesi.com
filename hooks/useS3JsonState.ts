import { useCallback, useEffect, useRef, useState } from "react";
import { uploadData, getUrl } from "aws-amplify/storage";

/**
 * useS3JsonState
 *
 * Hook for storing arbitrary JSON-serializable state under a single S3 key,
 * mirrored to localStorage for offline use and instant cold-start paint.
 *
 * Cross-device sync model: on mount, S3 is the source of truth — if a remote
 * blob exists, we adopt it. localStorage is read first only to render
 * something quickly while the S3 round-trip is in flight (it gets overwritten
 * if the remote differs).
 *
 * Save model: every change writes localStorage immediately and schedules a
 * debounced upload to S3. If the upload fails (no network, perm error), the
 * status flips to "local-only" — the localStorage write still succeeded, so
 * you don't lose work; the next successful save catches S3 up.
 *
 * Pre-conditions:
 * - Caller's session must have S3 read+write to the path. The site's
 *   authPolicy in amplify/backend.ts grants read/write to authenticated users
 *   on the entire `gennaroanesi.com` bucket, so any path under the bucket
 *   works for the admin user.
 *
 * Trade-offs intentionally accepted:
 * - No conflict resolution: last writer wins (S3 on mount, then debounced
 *   per-tab on save). If two tabs are open and both edit, whichever saves
 *   last clobbers the other. Acceptable for a single-user scratchpad.
 * - No optimistic locking, no etags. The S3 PUT just overwrites.
 */

export type S3SyncStatus =
  | "loading"     // initial fetch in progress
  | "synced"      // S3 reflects local
  | "saving"      // debounced upload in flight
  | "local-only"  // S3 unreachable, localStorage is ahead
  | "error";      // unexpected failure during load

export type UseS3JsonStateOptions = {
  /** Debounce window before pushing changes to S3. Default 1500 ms. */
  debounceMs?:      number;
  /** localStorage key for the offline mirror. If omitted, no mirror. */
  localStorageKey?: string;
  /** Gate all S3 operations. When false, the hook behaves as a pure
   *  localStorage-backed state. When it flips from false → true, the hook
   *  runs its initial S3 load. Useful for waiting out auth resolution.
   *  Default: true. */
  enabled?:         boolean;
};

export type UseS3JsonStateResult<T> = {
  value:        T;
  setValue:     (next: T | ((prev: T) => T)) => void;
  status:       S3SyncStatus;
  lastSavedAt:  Date | null;
  /** Force re-fetch from S3 (e.g. when another tab might have written). */
  reload:       () => Promise<void>;
};

export function useS3JsonState<T>(
  s3Path:       string,
  defaultValue: T | (() => T),
  opts:         UseS3JsonStateOptions = {},
): UseS3JsonStateResult<T> {
  const debounceMs = opts.debounceMs      ?? 1500;
  const lsKey      = opts.localStorageKey ?? null;
  const enabled    = opts.enabled         ?? true;

  const [value, setValue]             = useState<T>(defaultValue);
  const [status, setStatus]           = useState<S3SyncStatus>("loading");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [hydrated, setHydrated]       = useState(false);

  // Track the last JSON we successfully wrote (to S3 OR to local if S3 isn't
  // reachable) so we can detect no-op saves and skip them.
  const lastSavedJsonRef = useRef<string>("");
  const saveTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Once we've run the initial S3 load once, don't run it again when
  // `enabled` toggles — a caller re-disabling shouldn't re-fetch on re-enable.
  const hasLoadedRef     = useRef(false);

  // ── Local helpers ─────────────────────────────────────────────────────
  const readLocal = useCallback((): T | undefined => {
    if (!lsKey || typeof window === "undefined") return undefined;
    try {
      const raw = window.localStorage.getItem(lsKey);
      if (!raw) return undefined;
      return JSON.parse(raw) as T;
    } catch { return undefined; }
  }, [lsKey]);

  const writeLocal = useCallback((v: T) => {
    if (!lsKey || typeof window === "undefined") return;
    try { window.localStorage.setItem(lsKey, JSON.stringify(v)); } catch { /* quota / private mode */ }
  }, [lsKey]);

  // ── S3 helpers ────────────────────────────────────────────────────────
  const downloadFromS3 = useCallback(async (): Promise<T | null> => {
    try {
      const { url } = await getUrl({ path: s3Path });
      const res = await fetch(url.toString());
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`s3 fetch ${res.status}`);
      return (await res.json()) as T;
    } catch (err: any) {
      // Different Amplify versions surface "missing object" differently —
      // sometimes as a thrown error, sometimes as a 404. Treat both as null.
      const msg = String(err?.message ?? err);
      if (/404|NotFound|NoSuchKey|AccessDenied/i.test(msg)) return null;
      throw err;
    }
  }, [s3Path]);

  const uploadToS3 = useCallback(async (v: T) => {
    await uploadData({
      path: s3Path,
      data: new Blob([JSON.stringify(v)], { type: "application/json" }),
      options: { contentType: "application/json" },
    }).result;
    lastSavedJsonRef.current = JSON.stringify(v);
    setLastSavedAt(new Date());
  }, [s3Path]);

  // ── Hydration: paint local first, then reconcile with S3 ──────────────
  // Runs the first time `enabled` is true. Prior to that the hook behaves as
  // a localStorage-backed scratchpad so the caller can safely render while
  // waiting on auth resolution.
  useEffect(() => {
    // Paint local immediately regardless of enabled — fast first paint.
    const local = readLocal();
    if (local !== undefined) setValue(local);

    if (!enabled || hasLoadedRef.current) {
      if (!enabled) {
        // While gated, we haven't tried S3 yet — keep status honest.
        setStatus("loading");
      }
      return;
    }
    hasLoadedRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        const remote = await downloadFromS3();
        if (cancelled) return;
        if (remote !== null) {
          setValue(remote);
          writeLocal(remote);
          lastSavedJsonRef.current = JSON.stringify(remote);
          setStatus("synced");
        } else {
          // No remote yet. If we have a local copy, push it as the seed.
          if (local !== undefined) {
            try {
              await uploadToS3(local);
              setStatus("synced");
            } catch (err) {
              console.warn(`[useS3JsonState:${s3Path}] seed upload failed:`, err);
              setStatus("local-only");
            }
          } else {
            setStatus("synced");
          }
        }
      } catch (err) {
        console.warn(`[useS3JsonState:${s3Path}] load failed:`, err);
        if (!cancelled) setStatus("local-only");
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // ── Debounced save on change ──────────────────────────────────────────
  // Always writes to localStorage on change so offline edits survive; the
  // S3 upload part is gated on `hydrated && enabled` so we don't stomp
  // remote state before we've read it, or fire writes without auth.
  useEffect(() => {
    writeLocal(value);
    if (!hydrated || !enabled) return;
    const json = JSON.stringify(value);
    if (json === lastSavedJsonRef.current) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setStatus("saving");
    saveTimerRef.current = setTimeout(() => {
      uploadToS3(value)
        .then(() => setStatus("synced"))
        .catch((err) => {
          console.warn(`[useS3JsonState:${s3Path}] save failed:`, err);
          setStatus("local-only");
        });
    }, debounceMs);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [value, hydrated, enabled, debounceMs, writeLocal, uploadToS3, s3Path]);

  const setValueWrapped = useCallback((next: T | ((prev: T) => T)) => {
    setValue((prev) => typeof next === "function" ? (next as (p: T) => T)(prev) : next);
  }, []);

  const reload = useCallback(async () => {
    setStatus("loading");
    try {
      const remote = await downloadFromS3();
      if (remote !== null) {
        setValue(remote);
        writeLocal(remote);
        lastSavedJsonRef.current = JSON.stringify(remote);
      }
      setStatus("synced");
    } catch (err) {
      console.warn(`[useS3JsonState:${s3Path}] reload failed:`, err);
      setStatus("local-only");
    }
  }, [downloadFromS3, writeLocal, s3Path]);

  return { value, setValue: setValueWrapped, status, lastSavedAt, reload };
}
