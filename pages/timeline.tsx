import React, { useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import DefaultLayout from "@/layouts/default";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";

type Category = "aviation" | "dev" | "work" | "life";

type Entry = Schema["timelineEntry"]["type"];
type Media = Schema["timelineMedia"]["type"];

const CATEGORIES: Record<Category, { label: string; color: string }> = {
  aviation: { label: "Aviation", color: "#DEBA02" },
  dev: { label: "Personal Projects", color: "#60a5fa" },
  work: { label: "Work", color: "#587D71" },
  life: { label: "Life", color: "#a78bfa" },
};

// Public bucket — files under public/* are guest-readable per the bucket
// policy in amplify/backend.ts. Direct URLs are simpler than presigning.
const MEDIA_URL_PREFIX = "https://s3.us-east-1.amazonaws.com/gennaroanesi.com/";

const ALL = new Set<Category>(Object.keys(CATEGORIES) as Category[]);

const client = generateClient<Schema>();

function formatDate(ym: string) {
  const [y, m] = ym.split("-");
  const month = new Date(Number(y), Number(m) - 1).toLocaleString("en-US", {
    month: "short",
  });
  return `${month} ${y}`;
}

export default function TimelinePage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [media, setMedia]     = useState<Media[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive]   = useState<Set<Category>>(new Set(ALL));
  // Lightbox: which media item (if any) is full-screen. Closing on ESC or
  // backdrop click. We hold the whole record so render doesn't re-derive
  // anything from the entry/media maps.
  const [lightbox, setLightbox] = useState<Media | null>(null);

  // ESC closes the lightbox. Listener only attaches while one is open.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightbox(null); };
    window.addEventListener("keydown", onKey);
    // Lock background scroll while open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [lightbox]);

  // Public read via apiKey — visitors aren't authenticated.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [eRes, mRes] = await Promise.all([
          client.models.timelineEntry.list({ authMode: "apiKey", limit: 500 }),
          client.models.timelineMedia.list({ authMode: "apiKey", limit: 1000 }),
        ]);
        if (cancelled) return;
        setEntries(eRes.data ?? []);
        setMedia(mRes.data ?? []);
      } catch (err) {
        console.warn("[timeline] load failed:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Group media by entry id, sort by sortOrder asc within each entry.
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

  // Sort entries by date desc, then by sortOrder desc within the same date.
  const sorted = useMemo(
    () => [...entries].sort((a, b) => {
      const dc = (b.date ?? "").localeCompare(a.date ?? "");
      if (dc !== 0) return dc;
      return (b.sortOrder ?? 0) - (a.sortOrder ?? 0);
    }),
    [entries],
  );
  const filtered = sorted.filter((p) => active.has(p.category as Category));

  const toggle = (c: Category) => {
    setActive((prev) => {
      if (prev.size === 1 && prev.has(c)) return new Set(ALL);
      return new Set([c]);
    });
  };
  const showAll = () => setActive(new Set(ALL));

  return (
    <DefaultLayout>
      <div
        className="flex flex-col px-6 sm:px-10 pt-8 sm:pt-12"
        style={{ height: "calc(100dvh - 4rem)" }}
      >
        <div className="max-w-3xl mx-auto w-full flex flex-col min-h-0 flex-1">
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-medium text-purple dark:text-rose mb-3 flex-shrink-0">
            Timeline
          </h1>
          <p className="text-base text-purple/70 dark:text-rose/70 mb-6 sm:mb-8 flex-shrink-0">
            A running log of what I've been working on, building, flying and
            playing.
          </p>

          {/* Category filter */}
          <div className="flex flex-wrap items-center gap-2 mb-6 sm:mb-8 flex-shrink-0">
            <button
              type="button"
              onClick={showAll}
              className={`px-3 py-1.5 text-xs uppercase tracking-widest border transition-colors ${
                active.size === ALL.size
                  ? "border-purple dark:border-rose text-purple dark:text-rose"
                  : "border-darkBorder text-purple/50 dark:text-rose/50 hover:text-purple dark:hover:text-rose"
              }`}
            >
              All
            </button>
            {(Object.keys(CATEGORIES) as Category[]).map((c) => {
              const cat = CATEGORIES[c];
              const on = active.has(c) && active.size !== ALL.size;
              const allOn = active.size === ALL.size;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggle(c)}
                  className="px-3 py-1.5 text-xs uppercase tracking-widest border transition-colors"
                  style={
                    on
                      ? { color: cat.color, borderColor: cat.color }
                      : allOn
                        ? {
                            color: cat.color,
                            borderColor: "transparent",
                            backgroundColor: "rgba(255,255,255,0.04)",
                          }
                        : { opacity: 0.4 }
                  }
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full mr-2 align-middle"
                    style={{ backgroundColor: cat.color }}
                  />
                  {cat.label}
                </button>
              );
            })}
          </div>

          {/* Timeline */}
          <ol className="relative flex-1 min-h-0 overflow-y-auto pb-8 scrollbar-hide">
            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-darkBorder" />

            {loading && entries.length === 0 ? (
              <li className="pl-8 text-sm text-purple/60 dark:text-rose/60 animate-pulse">
                Loading…
              </li>
            ) : filtered.map((p) => {
              const cat = CATEGORIES[p.category as Category];
              if (!cat) return null;
              const url = p.url ?? null;
              const items = mediaByEntry.get(p.id) ?? [];
              return (
                <li key={p.id} className="relative pl-8 pb-8 sm:pb-10 last:pb-0">
                  <span
                    className="absolute left-0 top-[6px] h-[15px] w-[15px] rounded-full ring-4 ring-gray-50 dark:ring-darkBg"
                    style={{ backgroundColor: cat.color }}
                    aria-hidden
                  />

                  <div className="flex items-center justify-between gap-3 mb-1">
                    <span className="font-mono text-xs uppercase tracking-widest text-purple/60 dark:text-rose/60">
                      {formatDate(p.date)}
                    </span>
                    <span
                      className="text-[10px] sm:text-xs uppercase tracking-widest"
                      style={{ color: cat.color }}
                    >
                      {cat.label}
                    </span>
                  </div>

                  <h3 className="text-lg sm:text-xl font-medium text-purple dark:text-rose leading-snug">
                    {url ? (() => {
                      const isExternal = /^https?:\/\//i.test(url);
                      const arrow = isExternal ? "↗" : "→";
                      const className =
                        "underline decoration-purple/20 dark:decoration-rose/20 underline-offset-4 hover:decoration-gold hover:text-gold transition-colors";
                      return isExternal ? (
                        <a href={url} target="_blank" rel="noreferrer" className={className}>
                          {p.title}
                          <span className="ml-1.5 text-purple/40 dark:text-rose/40" aria-hidden>{arrow}</span>
                        </a>
                      ) : (
                        <NextLink href={url} className={className}>
                          {p.title}
                          <span className="ml-1.5 text-purple/40 dark:text-rose/40" aria-hidden>{arrow}</span>
                        </NextLink>
                      );
                    })() : (
                      p.title
                    )}
                  </h3>
                  {p.description && (
                    <p className="mt-1 text-sm sm:text-base text-purple/75 dark:text-rose/75 leading-relaxed">
                      {p.description}
                    </p>
                  )}

                  {/* Media row — horizontal scroll of thumbnails. Click opens
                      the lightbox modal. */}
                  {items.length > 0 && (
                    <div className="mt-3 flex gap-2 overflow-x-auto scrollbar-hide">
                      {items.map((m) => {
                        const url = `${MEDIA_URL_PREFIX}${m.s3Key}`;
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => setLightbox(m)}
                            title={m.caption ?? undefined}
                            className="flex-shrink-0 block rounded overflow-hidden border border-darkBorder hover:border-purple dark:hover:border-rose transition-colors p-0"
                          >
                            {m.kind === "VIDEO" ? (
                              <div className="relative w-32 h-20 bg-black flex items-center justify-center">
                                <video
                                  src={url}
                                  className="w-full h-full object-cover"
                                  muted
                                  playsInline
                                  preload="metadata"
                                />
                                <span className="absolute text-white/90 text-xl drop-shadow" aria-hidden>▶</span>
                              </div>
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={url}
                                alt={m.caption ?? ""}
                                className="w-32 h-20 object-cover"
                                loading="lazy"
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}

            {!loading && filtered.length === 0 && (
              <li className="pl-8 text-sm text-purple/60 dark:text-rose/60">
                No projects in this filter.
              </li>
            )}
          </ol>
        </div>
      </div>

      {/* Lightbox — full-screen image / video viewer.
          Backdrop click closes; the inner figure stops propagation so
          clicks on the media itself don't dismiss. ESC also closes (see
          the effect above).
          Sizing: caps media at 78vh (mobile-portrait friendly) so caption
          + close button always have breathing room; figure becomes
          scrollable past that for tall captions on tiny viewports. */}
      {lightbox && (() => {
        const url = `${MEDIA_URL_PREFIX}${lightbox.s3Key}`;
        return (
          <div
            role="dialog"
            aria-modal="true"
            onClick={() => setLightbox(null)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-3 sm:p-8"
          >
            <button
              type="button"
              onClick={() => setLightbox(null)}
              className="absolute top-2 right-2 sm:top-4 sm:right-4 p-3 text-white/70 hover:text-white text-3xl leading-none"
              aria-label="Close"
            >
              ×
            </button>
            <figure
              onClick={(e) => e.stopPropagation()}
              className="flex flex-col items-center gap-3 max-w-full max-h-full overflow-y-auto"
            >
              {lightbox.kind === "VIDEO" ? (
                <video
                  src={url}
                  controls
                  autoPlay
                  playsInline
                  className="max-w-full max-h-[78vh] rounded shadow-2xl"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={url}
                  alt={lightbox.caption ?? ""}
                  className="max-w-full max-h-[78vh] rounded shadow-2xl object-contain"
                />
              )}
              {lightbox.caption && (
                <figcaption className="text-sm text-white/70 text-center max-w-2xl px-3">
                  {lightbox.caption}
                </figcaption>
              )}
            </figure>
          </div>
        );
      })()}
    </DefaultLayout>
  );
}
