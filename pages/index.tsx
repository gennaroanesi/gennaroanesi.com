import React, { useEffect, useMemo, useRef, useState } from "react";
import { FaVolumeUp, FaVolumeMute } from "react-icons/fa";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import outputs from "@/amplify_outputs.json";
import DefaultLayout from "@/layouts/default";

// Configure Amplify in this module's scope too. _app.tsx configures it for the
// browser, but getStaticProps runs in a Node context where _app never executes;
// without this the module-scope generateClient() below has no config at build
// time. Idempotent, so the double-configure with _app on the client is harmless.
Amplify.configure(outputs);

// Hard-coded SLIDES are gone — content now comes from homeCategory +
// homeMedia. The admin manages both via /admin/homepage.

type HomeCategory = Schema["homeCategory"]["type"];
type HomeMedia    = Schema["homeMedia"]["type"];

type Item = {
  id:      string;
  type:    "image" | "video";
  src:     string;
  caption: string;
};

type Slide = {
  key:   string;  // category slug
  label: string;
  items: Item[];
};

const MEDIA_URL_PREFIX = "https://s3.us-east-1.amazonaws.com/gennaroanesi.com/";
const IMAGE_INTERVAL_MS = 5000;

const client = generateClient<Schema>();

/**
 * Build the ordered carousel slides from raw homeCategory + homeMedia rows.
 * Pure + shared by getStaticProps (build time) and the client refresh so both
 * produce identical output. Drops inactive/inbox media and empty categories.
 */
function buildSlides(cats: HomeCategory[], media: HomeMedia[]): Slide[] {
  const activeCats = cats
    .filter((c) => c.isActive !== false)
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const activeMedia = media.filter((m) => m.isActive !== false && !!m.categorySlug);
  return activeCats
    .map((c) => {
      const items = activeMedia
        .filter((m) => m.categorySlug === c.slug)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map((m) => ({
          id:      m.id,
          type:    (m.kind === "VIDEO" ? "video" : "image") as Item["type"],
          src:     `${MEDIA_URL_PREFIX}${m.s3Key}`,
          caption: m.caption ?? "",
        }));
      return { key: c.slug ?? "", label: c.label ?? c.slug ?? "", items };
    })
    .filter((s) => s.items.length > 0);
}

export default function IndexPage({ initialSlides }: { initialSlides: Slide[] }) {
  const [slides, setSlides] = useState<Slide[]>(initialSlides);
  const [loading, setLoading] = useState(initialSlides.length === 0);
  const [active, setActive] = useState<string>(initialSlides[0]?.key ?? "");   // active category slug
  const [itemIdx, setItemIdx] = useState(0);
  const [muted, setMuted] = useState(true);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});

  // ── Background refresh via apiKey ───────────────────────────────────────
  // The slides are already server-rendered via getStaticProps (ISR), so this
  // is a silent revalidation on mount — it picks up admin edits made since the
  // last ISR regeneration without a visible spinner. Preserves the current
  // active tab so a refresh mid-view doesn't yank the user back to the first.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [catsRes, mediaRes] = await Promise.all([
          client.models.homeCategory.list({ authMode: "apiKey", limit: 100 }),
          client.models.homeMedia.list({ authMode: "apiKey", limit: 1000 }),
        ]);
        if (cancelled) return;
        const built = buildSlides(catsRes.data ?? [], mediaRes.data ?? []);
        setSlides(built);
        setActive((cur) => (built.some((s) => s.key === cur) ? cur : built[0]?.key ?? ""));
      } catch (err) {
        console.warn("[home] refresh failed:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const activeSlide = useMemo(
    () => slides.find((s) => s.key === active) ?? slides[0] ?? null,
    [slides, active],
  );
  const safeItemIdx = activeSlide ? Math.min(itemIdx, activeSlide.items.length - 1) : 0;
  const activeItem  = activeSlide ? activeSlide.items[safeItemIdx] : null;

  // Reset carousel when switching slides.
  useEffect(() => { setItemIdx(0); }, [active]);

  // Auto-advance when the active item is an image and slide has multiple items.
  useEffect(() => {
    if (!activeSlide || !activeItem) return;
    if (activeSlide.items.length <= 1) return;
    if (activeItem.type !== "image") return;
    const id = setInterval(() => {
      setItemIdx((i) => (i + 1) % activeSlide.items.length);
    }, IMAGE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, itemIdx, activeSlide, activeItem]);

  // Play only the active video; pause every other video (including inactive slides).
  useEffect(() => {
    for (const slide of slides) {
      slide.items.forEach((item, i) => {
        if (item.type !== "video") return;
        const el = videoRefs.current[`${slide.key}-${i}`];
        if (!el) return;
        const isActiveVideo = slide.key === active && i === itemIdx;
        if (isActiveVideo) {
          el.play().catch(() => {});
        } else {
          el.pause();
        }
      });
    }
  }, [active, itemIdx, slides]);

  const advanceFromVideo = (slideKey: string, itemIndex: number) => {
    const slide = slides.find((s) => s.key === slideKey);
    if (!slide || slide.items.length <= 1) return;
    if (slideKey !== active || itemIndex !== itemIdx) return;
    setItemIdx((i) => (i + 1) % slide.items.length);
  };

  // ── Swipe handling ─────────────────────────────────────────────────────────
  const touchStartX = useRef<number | null>(null);
  const SWIPE_THRESHOLD = 50; // px

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const startX = touchStartX.current;
    touchStartX.current = null;
    if (startX === null || !activeSlide) return;
    const delta = e.changedTouches[0].clientX - startX;
    if (Math.abs(delta) < SWIPE_THRESHOLD) return;
    if (activeSlide.items.length <= 1) return;
    const len = activeSlide.items.length;
    if (delta < 0) {
      setItemIdx((i) => (i + 1) % len);
    } else {
      setItemIdx((i) => (i - 1 + len) % len);
    }
  };

  return (
    <DefaultLayout>
      <div
        className="relative -mt-16 h-[100dvh] w-full overflow-hidden bg-black touch-pan-y"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {slides.map((slide) => (
          <div
            key={slide.key}
            className={`absolute inset-0 transition-opacity duration-700 ${
              slide.key === active
                ? "opacity-100"
                : "opacity-0 pointer-events-none"
            }`}
          >
            {slide.items.map((item, i) => {
              const showOpacity = i === (slide.key === active ? itemIdx : 0);
              return (
                <div
                  key={item.id}
                  className={`absolute inset-0 transition-opacity duration-[1200ms] ${
                    showOpacity ? "opacity-100" : "opacity-0"
                  }`}
                >
                  {item.type === "image" ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={item.src}
                      alt=""
                      className="h-full w-full object-cover"
                      loading={
                        slide.key === active && i === 0 ? "eager" : "lazy"
                      }
                    />
                  ) : (
                    <video
                      ref={(el) => {
                        videoRefs.current[`${slide.key}-${i}`] = el;
                      }}
                      src={item.src}
                      className="h-full w-full object-cover"
                      muted={muted}
                      playsInline
                      preload="metadata"
                      loop={slide.items.length === 1}
                      onEnded={() => advanceFromVideo(slide.key, i)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}

        <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/80 pointer-events-none" />

        {!loading && slides.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-white/60 text-sm">
            No home page content yet.
          </div>
        )}

        {activeItem && activeItem.caption && (
          <div
            className="absolute top-20 right-4 sm:top-24 sm:right-10 z-10"
            style={{ paddingTop: "env(safe-area-inset-top)" }}
          >
            <span className="text-sm sm:text-base uppercase tracking-widest text-white/75">
              {activeItem.caption}
            </span>
          </div>
        )}

        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          aria-label={muted ? "Unmute" : "Mute"}
          aria-pressed={!muted}
          className={`absolute bottom-28 right-4 sm:bottom-32 sm:right-10 z-10 h-11 w-11 flex items-center justify-center rounded-full bg-black/40 hover:bg-black/60 text-white backdrop-blur-sm transition-opacity duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/80 ${
            activeItem?.type === "video"
              ? "opacity-100"
              : "opacity-0 pointer-events-none"
          }`}
        >
          {muted ? <FaVolumeMute className="h-4 w-4" /> : <FaVolumeUp className="h-4 w-4" />}
        </button>

        <div
          className="absolute inset-x-0 bottom-0 z-10 flex flex-col items-center"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom), 2rem)" }}
        >
          {/* Carousel dots — only shown when the active slide has multiple items */}
          <div
            className={`flex items-center gap-2 mb-4 transition-opacity duration-300 ${
              activeSlide && activeSlide.items.length > 1
                ? "opacity-100"
                : "opacity-0 pointer-events-none"
            }`}
            aria-hidden={!activeSlide || activeSlide.items.length <= 1}
          >
            {activeSlide?.items.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setItemIdx(i)}
                aria-label={`Item ${i + 1}`}
                className="p-2 -m-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/80 rounded-full"
              >
                <span
                  className={`block h-1.5 rounded-full transition-all duration-300 ${
                    i === itemIdx ? "w-6 bg-white" : "w-1.5 bg-white/40"
                  }`}
                />
              </button>
            ))}
          </div>

          <nav className="flex justify-center">
            <ul className="flex items-center gap-8 sm:gap-16">
              {slides.map((s) => {
                const isActive = s.key === active;
                return (
                  <li key={s.key}>
                    <button
                      type="button"
                      onClick={() => { setItemIdx(0); setActive(s.key); }}
                      aria-pressed={isActive}
                      className="group relative px-2 py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/80 rounded-sm"
                    >
                      <span
                        className={`block text-2xl sm:text-3xl lg:text-4xl tracking-tight transition-colors duration-200 ${
                          isActive
                            ? "text-white"
                            : "text-white/50 group-hover:text-white/90"
                        }`}
                      >
                        {s.label}
                      </span>
                      <span
                        className={`absolute left-2 right-2 -bottom-0.5 h-[2px] bg-gold transition-transform duration-300 origin-center ${
                          isActive ? "scale-x-100" : "scale-x-0"
                        }`}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      </div>
    </DefaultLayout>
  );
}

/**
 * Pre-render the carousel content into the served HTML so the hero paints
 * immediately instead of waiting on a client-side GraphQL round-trip.
 *
 * ISR: the page regenerates at most once every `revalidate` seconds. Reads use
 * the public apiKey from amplify_outputs.json — which the Amplify pipeline
 * regenerates with prod values at deploy time (sandbox locally), so this is
 * automatically environment-correct. On failure we still ship an empty page and
 * let the client refresh recover, with a shorter revalidate to retry sooner.
 */
export async function getStaticProps() {
  try {
    const [catsRes, mediaRes] = await Promise.all([
      client.models.homeCategory.list({ authMode: "apiKey", limit: 100 }),
      client.models.homeMedia.list({ authMode: "apiKey", limit: 1000 }),
    ]);
    const initialSlides = buildSlides(catsRes.data ?? [], mediaRes.data ?? []);
    return { props: { initialSlides }, revalidate: 300 };
  } catch (err) {
    console.warn("[home] getStaticProps load failed:", err);
    return { props: { initialSlides: [] as Slide[] }, revalidate: 60 };
  }
}
