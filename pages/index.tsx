import React, { useEffect, useRef, useState } from "react";
import { FaVolumeUp, FaVolumeMute } from "react-icons/fa";
import DefaultLayout from "@/layouts/default";

type MediaKind = "photo" | "flying" | "guitar";

type Item = {
  type: "image" | "video";
  src: string;
  caption: string;
};

type Slide = {
  key: MediaKind;
  label: string;
  items: Item[];
};

// Swap these for real assets when ready.
const SLIDES: Slide[] = [
  {
    key: "flying",
    label: "flying",
    items: [
      {
        type: "video",
        src: "https://s3.us-east-1.amazonaws.com/gennaroanesi.com/public/videos/partial_panel.web.mp4",
        caption: "Partial panel at Kileen TX, Nov 2026",
      },
      {
        type: "video",
        src: "https://s3.us-east-1.amazonaws.com/gennaroanesi.com/public/videos/telluride_approach.web.mp4",
        caption: "Approach at Telluride CO, Dec 2025",
      },
      {
        type: "video",
        src: "https://s3.us-east-1.amazonaws.com/gennaroanesi.com/public/videos/night_approach_kgtu.web.mp4",
        caption: "Night Approach at Georgetown TX, Mar 2026",
      },
      
    ]
  },
    {
    key: "photo",
    label: "photos",
    items: [
      {
        type: "image",
        src: "https://s3.us-east-1.amazonaws.com/gennaroanesi.com/public/images/455A8627.web.jpg",
        caption: "Santorini, Oct 2025",
      },
      {
        type: "image",
        src: "https://s3.us-east-1.amazonaws.com/gennaroanesi.com/public/images/455A1335.web.jpg",
        caption: "Copper, Dec 2023",
      },
      {
        type: "image",
        src: "https://s3.us-east-1.amazonaws.com/gennaroanesi.com/public/images/455A7313.web.jpg",
        caption: "London, Jul 2022",
      },
      {
        type: "image",
        src: "https://s3.us-east-1.amazonaws.com/gennaroanesi.com/public/images/455A8481.web.jpg",
        caption: "Capri, Jul 2023",
      },
    ],
  },
  {
    key: "guitar",
    label: "guitar",
    items: [
      {
        type: "video",
        src: "https://s3.us-east-1.amazonaws.com/gennaroanesi.com/public/videos/money_heist.mp4",
        caption: "Money Heist Theme",
      },
      {
        type: "video",
        src: "https://s3.us-east-1.amazonaws.com/gennaroanesi.com/public/videos/deja_blues.mp4",
        caption: "Michael Lee Firkins - Deja Blues",
      },
    ],
  },
];

const IMAGE_INTERVAL_MS = 5000;

export default function IndexPage() {
  const [active, setActive] = useState<MediaKind>("photo");
  const [itemIdx, setItemIdx] = useState(0);
  const [muted, setMuted] = useState(true);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});

  const activeSlide = SLIDES.find((s) => s.key === active)!;
  const safeItemIdx = Math.min(itemIdx, activeSlide.items.length - 1);
  const activeItem = activeSlide.items[safeItemIdx];

  // Reset carousel when switching slides.
  useEffect(() => {
    setItemIdx(0);
  }, [active]);

  // Auto-advance when the active item is an image and slide has multiple items.
  useEffect(() => {
    if (activeSlide.items.length <= 1) return;
    if (activeItem.type !== "image") return;
    const id = setInterval(() => {
      setItemIdx((i) => (i + 1) % activeSlide.items.length);
    }, IMAGE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, itemIdx, activeSlide.items.length, activeItem.type]);

  // Play only the active video; pause every other video (including inactive slides).
  useEffect(() => {
    for (const slide of SLIDES) {
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
  }, [active, itemIdx]);

  const advanceFromVideo = (slideKey: MediaKind, itemIndex: number) => {
    const slide = SLIDES.find((s) => s.key === slideKey)!;
    if (slide.items.length <= 1) return;
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
    if (startX === null) return;
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
        {SLIDES.map((slide) => (
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
                  key={item.src}
                  className={`absolute inset-0 transition-opacity duration-[1200ms] ${
                    showOpacity ? "opacity-100" : "opacity-0"
                  }`}
                >
                  {item.type === "image" ? (
                    <img
                      src={item.src}
                      alt=""
                      className="h-full w-full object-cover"
                      loading={
                        slide.key === "photo" && i === 0 ? "eager" : "lazy"
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

        <div
          className="absolute top-20 right-4 sm:top-24 sm:right-10 z-10"
          style={{ paddingTop: "env(safe-area-inset-top)" }}
        >
          <span className="text-sm sm:text-base uppercase tracking-widest text-white/75">
            {activeItem.caption}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          aria-label={muted ? "Unmute" : "Mute"}
          aria-pressed={!muted}
          className={`absolute bottom-28 right-4 sm:bottom-32 sm:right-10 z-10 h-11 w-11 flex items-center justify-center rounded-full bg-black/40 hover:bg-black/60 text-white backdrop-blur-sm transition-opacity duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/80 ${
            activeItem.type === "video"
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
              activeSlide.items.length > 1
                ? "opacity-100"
                : "opacity-0 pointer-events-none"
            }`}
            aria-hidden={activeSlide.items.length <= 1}
          >
            {activeSlide.items.map((_, i) => (
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
              {SLIDES.map((s) => {
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
