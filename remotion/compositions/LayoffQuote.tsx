/**
 * Remotion composition for Layoff Philosophy Reels.
 *
 * Output: 1080×1920 MP4 at 30fps. Branches on `animationStyle` to one of
 * 5 motion treatments. If `backgroundVideo` is empty, falls back to the
 * gradient from `backgroundCategory` so the comp still previews without
 * any media downloaded.
 */
import React, { useMemo } from "react";
import {
  AbsoluteFill,
  Video,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";

import { backgroundCategories, type BackgroundCategory } from "../../lib/layoff-philosophy/quotes";

// Single source of truth for default timing (in seconds). These match what
// the schema's z.default() applies when a prop is omitted.
const DEFAULTS = {
  textInStart: 0.2,
  textInEnd: 0.5,
  authorInStart: 0.7,
  authorInEnd: 1.2,
  durationSec: 8,
} as const;

const TEXT_FADE_DELTA = DEFAULTS.textInEnd - DEFAULTS.textInStart;
const AUTHOR_FADE_DELTA = DEFAULTS.authorInEnd - DEFAULTS.authorInStart;

// Schema mirrors the runtime shape so Remotion Studio can render interactive
// editors for every prop. Keep the enum values in sync with the types in
// lib/layoff-philosophy/quotes.ts.
export const layoffQuoteSchema = z.object({
  quoteText: z.string(),
  author: z.string(),
  /** Path or URL to an MP4. Empty string -> gradient fallback. */
  backgroundVideo: z.string(),
  /** Used for the gradient fallback when backgroundVideo is empty. */
  backgroundCategory: z.enum(["emptiness", "machine", "exit", "contemplation"]),
  animationStyle: z.enum([
    "kenBurns",
    "wordReveal",
    "parallax",
    "atmospheric",
    "videoBackground",
  ]),
  /** Total reel length in seconds. Drives the composition's durationInFrames. */
  durationSec: z.number().default(DEFAULTS.durationSec),
  /** Seconds at which the quote text begins fading in. */
  textInStart: z.number().default(DEFAULTS.textInStart),
  /** Seconds at which the quote text is fully visible. If <= textInStart, auto-bumps to textInStart + fade-delta. */
  textInEnd: z.number().default(DEFAULTS.textInEnd),
  /** Seconds at which the author line begins fading in. */
  authorInStart: z.number().default(DEFAULTS.authorInStart),
  /** Seconds at which the author line is fully visible. If <= authorInStart, auto-bumps to authorInStart + fade-delta. */
  authorInEnd: z.number().default(DEFAULTS.authorInEnd),
  filters: z
    .object({
      blur: z.number().optional(),
      brightness: z.number().optional(),
      saturation: z.number().optional(),
    })
    .optional(),
  fontSizeOverride: z.number().nullable().optional(),
});

// Use z.input so fields with .default() are optional on the input side —
// defaultProps can omit them and the schema fills them in.
export type LayoffQuoteProps = z.input<typeof layoffQuoteSchema>;
export type AnimationStyle = NonNullable<LayoffQuoteProps["animationStyle"]>;

export const defaultLayoffQuoteProps: LayoffQuoteProps = {
  quoteText: "Severance precedes existence",
  author: "Jean-Paul Sartre",
  backgroundVideo: "",
  backgroundCategory: "emptiness",
  animationStyle: "kenBurns",
};

/**
 * Read timing props with fallback to module defaults. If a user-supplied
 * *End is at or before its *Start (i.e. the fade would have negative or
 * zero duration), silently bump *End to *Start + the corresponding
 * default fade delta. Studio inputs remain unchanged; only the computed
 * timing is corrected.
 */
function timings(props: LayoffQuoteProps) {
  const textInStart = props.textInStart ?? DEFAULTS.textInStart;
  const rawTextInEnd = props.textInEnd ?? DEFAULTS.textInEnd;
  const textInEnd = rawTextInEnd <= textInStart ? textInStart + TEXT_FADE_DELTA : rawTextInEnd;

  const authorInStart = props.authorInStart ?? DEFAULTS.authorInStart;
  const rawAuthorInEnd = props.authorInEnd ?? DEFAULTS.authorInEnd;
  const authorInEnd =
    rawAuthorInEnd <= authorInStart ? authorInStart + AUTHOR_FADE_DELTA : rawAuthorInEnd;

  return { textInStart, textInEnd, authorInStart, authorInEnd };
}

const FONT_STACK = "Lora, Georgia, serif";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve a backgroundVideo prop into a URL that <Video> can fetch.
 * Accepts:
 *   - "" → empty (caller falls back to the gradient)
 *   - full URLs (http://, https://, file://, blob:, data:) → pass-through
 *   - Studio asset-picker output like "/assets/backgrounds/foo.mp4" → strip prefix + staticFile
 *   - bare relative paths like "backgrounds/foo.mp4" → staticFile
 */
function resolveVideoSrc(input: string): string {
  if (!input) return "";
  if (/^[a-z]+:/i.test(input)) return input;
  const cleaned = input.replace(/^\/assets\//, "").replace(/^\//, "");
  return staticFile(cleaned);
}

/** Reel-scale auto sizer (1080 wide). Roughly 2x the static-card values. */
function autoFontSize(text: string): number {
  const len = text.length;
  const longestWord = Math.max(...text.split(/\s+/).map((w) => w.length));

  let size: number;
  if (len <= 30) size = 80;
  else if (len <= 50) size = 72;
  else if (len <= 80) size = 64;
  else if (len <= 120) size = 54;
  else if (len <= 160) size = 48;
  else size = 40;

  if (longestWord > 12) size = Math.min(size, 60);
  if (longestWord > 16) size = Math.min(size, 50);

  return size;
}

/** Deterministic PRNG so particle positions are stable across frames + renders. */
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// ============================================================================
// Background layer — video OR gradient fallback, with filters
// ============================================================================

interface BackgroundProps {
  videoSrc: string;
  categoryFallback: BackgroundCategory;
  blur?: number;
  brightness?: number;
  saturation?: number;
  scale?: number;
}

const FilteredBackground: React.FC<BackgroundProps> = ({
  videoSrc,
  categoryFallback,
  blur = 2,
  brightness = 0.35,
  saturation = 0.6,
  scale = 1,
}) => {
  const filter = `blur(${blur}px) brightness(${brightness}) saturate(${saturation})`;
  const transform = `scale(${scale})`;
  const resolvedSrc = resolveVideoSrc(videoSrc);

  return (
    <AbsoluteFill>
      {resolvedSrc ? (
        <Video
          src={resolvedSrc}
          muted
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            filter,
            transform,
          }}
        />
      ) : (
        <AbsoluteFill
          style={{
            background: backgroundCategories[categoryFallback].fallbackGradient,
            filter: `brightness(${brightness}) saturate(${saturation})`,
            transform,
          }}
        />
      )}
      {/* Vignette */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.5) 100%)",
        }}
      />
    </AbsoluteFill>
  );
};

// ============================================================================
// Shared author block
// ============================================================================

interface AuthorBlockProps {
  author: string;
  opacity: number;
  translateY?: number;
}

const AuthorBlock: React.FC<AuthorBlockProps> = ({ author, opacity, translateY = 0 }) => (
  <div
    style={{
      marginTop: 50,
      opacity,
      transform: `translateY(${translateY}px)`,
      textAlign: "center",
    }}
  >
    <div
      style={{
        width: 40,
        height: 1,
        background: "rgba(255,255,255,0.35)",
        margin: "0 auto 20px",
      }}
    />
    <div
      style={{
        fontSize: 28,
        color: "rgba(255,255,255,0.7)",
        letterSpacing: "0.08em",
        textShadow: "0 2px 12px rgba(0,0,0,0.6)",
      }}
    >
      {author}
    </div>
  </div>
);

// ============================================================================
// Style 1: Ken Burns — slow zoom + fade
// ============================================================================

const KenBurnsAnimation: React.FC<LayoffQuoteProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = timings(props);

  const textOpacity = interpolate(frame, [fps * t.textInStart, fps * t.textInEnd], [0, 1], {
    extrapolateRight: "clamp",
  });
  const textY = interpolate(frame, [fps * t.textInStart, fps * t.textInEnd], [30, 0], {
    extrapolateRight: "clamp",
  });
  const authorOpacity = interpolate(
    frame,
    [fps * t.authorInStart, fps * t.authorInEnd],
    [0, 1],
    { extrapolateRight: "clamp" }
  );
  const bgScale = interpolate(frame, [0, durationInFrames], [1.05, 1.2], {
    extrapolateRight: "clamp",
  });

  const fontSize = props.fontSizeOverride || autoFontSize(props.quoteText);

  return (
    <AbsoluteFill style={{ fontFamily: FONT_STACK }}>
      <FilteredBackground
        videoSrc={props.backgroundVideo}
        categoryFallback={props.backgroundCategory}
        scale={bgScale}
        {...props.filters}
      />
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          padding: "120px 80px",
        }}
      >
        <div
          style={{
            fontSize,
            lineHeight: 1.45,
            color: "rgba(255,255,255,0.95)",
            textAlign: "center",
            textShadow: "0 4px 24px rgba(0,0,0,0.7), 0 2px 6px rgba(0,0,0,0.5)",
            opacity: textOpacity,
            transform: `translateY(${textY}px)`,
            maxWidth: 880,
          }}
        >
          {props.quoteText}
        </div>
        <AuthorBlock author={props.author} opacity={authorOpacity} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ============================================================================
// Style 2: Word Reveal — word-by-word stagger
// ============================================================================

const WordRevealAnimation: React.FC<LayoffQuoteProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = timings(props);

  const words = props.quoteText.split(" ");
  const fontSize = props.fontSizeOverride || autoFontSize(props.quoteText);

  // Distribute the per-word stagger across [textInStart, textInEnd]. Each word
  // fades over WORD_FADE_SEC; the last word's fade completes by textInEnd.
  const WORD_FADE_SEC = 0.15;
  const span = Math.max(0, t.textInEnd - t.textInStart - WORD_FADE_SEC);
  const wordSpacing = words.length > 1 ? span / (words.length - 1) : 0;

  const authorOpacity = interpolate(
    frame,
    [fps * t.authorInStart, fps * t.authorInEnd],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill style={{ fontFamily: FONT_STACK }}>
      <FilteredBackground
        videoSrc={props.backgroundVideo}
        categoryFallback={props.backgroundCategory}
        {...props.filters}
      />
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          padding: "120px 80px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: "0 16px",
            maxWidth: 880,
          }}
        >
          {words.map((word, i) => {
            const wordFrame = fps * (t.textInStart + i * wordSpacing);
            const fadeEnd = wordFrame + fps * WORD_FADE_SEC;
            const opacity = interpolate(frame, [wordFrame, fadeEnd], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            const y = interpolate(frame, [wordFrame, fadeEnd], [15, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            return (
              <span
                key={i}
                style={{
                  fontSize,
                  lineHeight: 1.5,
                  color: "rgba(255,255,255,0.95)",
                  textShadow: "0 4px 24px rgba(0,0,0,0.7)",
                  opacity,
                  transform: `translateY(${y}px)`,
                  display: "inline-block",
                }}
              >
                {word}
              </span>
            );
          })}
        </div>
        <AuthorBlock author={props.author} opacity={authorOpacity} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ============================================================================
// Style 3: Parallax — multi-layer depth drift + dust particles
// ============================================================================

interface Particle {
  x: number; // 0..100
  y: number; // 0..100
  size: number; // px
  driftCycleSec: number;
  phase: number; // 0..1
  alpha: number;
}

function buildParticles(count: number, seedBase: number, sizeRange: [number, number]): Particle[] {
  return Array.from({ length: count }, (_, i) => {
    const s = seedBase + i * 7;
    const [minSize, maxSize] = sizeRange;
    return {
      x: seededRandom(s + 1) * 100,
      y: seededRandom(s + 2) * 100,
      size: seededRandom(s + 3) * (maxSize - minSize) + minSize,
      driftCycleSec: 8 + seededRandom(s + 4) * 12,
      phase: seededRandom(s + 5),
      alpha: seededRandom(s + 6) * 0.12 + 0.04,
    };
  });
}

const ParallaxAnimation: React.FC<LayoffQuoteProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = timings(props);

  const fadeIn = interpolate(frame, [fps * t.textInStart, fps * t.textInEnd], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const authorIn = interpolate(
    frame,
    [fps * t.authorInStart, fps * t.authorInEnd],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Layer drifts (back: slow, mid: medium, front: slight counter)
  const drift = frame / durationInFrames;
  const backX = -3 * drift; // pct
  const backY = -2 * drift;
  const midX = 2 * drift;
  const midY = -1 * drift;
  const frontX = -1 * drift;
  const frontY = 1 * drift;

  const fontSize = props.fontSizeOverride || autoFontSize(props.quoteText);
  const particles = useMemo(() => buildParticles(15, 1000, [1, 4]), []);

  return (
    <AbsoluteFill style={{ fontFamily: FONT_STACK, overflow: "hidden", background: "#0a0a0a" }}>
      {/* Back layer: video/gradient, parallax-back */}
      <AbsoluteFill
        style={{
          transform: `translate(${backX}%, ${backY}%) scale(${1.1 + drift * 0.05})`,
        }}
      >
        <FilteredBackground
          videoSrc={props.backgroundVideo}
          categoryFallback={props.backgroundCategory}
          {...props.filters}
        />
      </AbsoluteFill>

      {/* Mid layer: warm glow accent */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at 40% 45%, rgba(180,140,80,0.06) 0%, transparent 50%)",
          transform: `translate(${midX}%, ${midY}%)`,
        }}
      />

      {/* Particle layer */}
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        {particles.map((p, i) => {
          const tt = (frame / fps + p.phase * p.driftCycleSec) / p.driftCycleSec;
          const cycle = (tt % 1) * Math.PI * 2;
          const dx = Math.sin(cycle) * 15;
          const dy = Math.cos(cycle * 0.7) * 25 - 5;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: `${p.x}%`,
                top: `${p.y}%`,
                width: p.size,
                height: p.size,
                borderRadius: "50%",
                background: `rgba(200,180,140,${p.alpha})`,
                transform: `translate(${dx}px, ${dy}px)`,
              }}
            />
          );
        })}
      </AbsoluteFill>

      {/* Front layer: text + counter-drift */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          padding: "120px 80px",
          transform: `translate(${frontX}%, ${frontY}%)`,
        }}
      >
        <div
          style={{
            fontSize,
            lineHeight: 1.45,
            color: "rgba(255,255,255,0.95)",
            textAlign: "center",
            textShadow: "0 4px 20px rgba(0,0,0,0.7), 0 2px 6px rgba(0,0,0,0.5)",
            opacity: fadeIn,
            maxWidth: 880,
          }}
        >
          {props.quoteText}
        </div>
        <AuthorBlock author={props.author} opacity={authorIn} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ============================================================================
// Style 4: Atmospheric — dense particles + light beam, glowing text
// ============================================================================

const AtmosphericAnimation: React.FC<LayoffQuoteProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = timings(props);

  const textOpacity = interpolate(frame, [fps * t.textInStart, fps * t.textInEnd], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const textScale = interpolate(frame, [fps * t.textInStart, fps * t.textInEnd], [0.95, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const authorOpacity = interpolate(
    frame,
    [fps * t.authorInStart, fps * t.authorInEnd],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Light beam rotates -15° -> -10° across the duration
  const beamAngle = interpolate(frame, [0, durationInFrames], [-15, -10]);
  const beamShiftX = interpolate(frame, [0, durationInFrames], [0, 10]);

  const fontSize = props.fontSizeOverride || autoFontSize(props.quoteText);
  const particles = useMemo(() => buildParticles(35, 2000, [1, 5]), []);

  return (
    <AbsoluteFill style={{ fontFamily: FONT_STACK, overflow: "hidden" }}>
      <FilteredBackground
        videoSrc={props.backgroundVideo}
        categoryFallback={props.backgroundCategory}
        brightness={(props.filters?.brightness ?? 0.25)}
        saturation={(props.filters?.saturation ?? 0.5)}
        blur={(props.filters?.blur ?? 3)}
      />

      {/* Dense particles, warm palette */}
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        {particles.map((p, i) => {
          const tt = (frame / fps + p.phase * p.driftCycleSec) / p.driftCycleSec;
          const cycle = (tt % 1) * Math.PI * 2;
          const dx = Math.sin(cycle) * 20;
          const dy = Math.cos(cycle * 0.8) * 30 - 8;
          const seed = seededRandom(2500 + i * 11);
          const warmth = 180 + seed * 40;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: `${p.x}%`,
                top: `${p.y}%`,
                width: p.size,
                height: p.size,
                borderRadius: "50%",
                background: `rgba(${Math.round(warmth)}, ${Math.round(warmth - 20)}, ${Math.round(warmth - 60)}, ${p.alpha + 0.03})`,
                filter: p.size > 3 ? "blur(1px)" : "none",
                transform: `translate(${dx}px, ${dy}px)`,
              }}
            />
          );
        })}
      </AbsoluteFill>

      {/* Light beam */}
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <div
          style={{
            position: "absolute",
            top: "-20%",
            left: "30%",
            width: "40%",
            height: "140%",
            background:
              "linear-gradient(180deg, rgba(200,180,140,0.06), transparent 60%)",
            transform: `rotate(${beamAngle}deg) translateX(${beamShiftX}%)`,
            filter: "blur(30px)",
          }}
        />
      </AbsoluteFill>

      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          padding: "120px 80px",
        }}
      >
        <div
          style={{
            fontSize,
            lineHeight: 1.45,
            color: "rgba(255,255,255,0.95)",
            textAlign: "center",
            textShadow:
              "0 0 50px rgba(200,180,140,0.2), 0 4px 18px rgba(0,0,0,0.6)",
            opacity: textOpacity,
            transform: `scale(${textScale})`,
            maxWidth: 880,
          }}
        >
          {props.quoteText}
        </div>
        <AuthorBlock author={props.author} opacity={authorOpacity} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ============================================================================
// Style 5: Video Background — heavy video presence, sharper text contrast
// ============================================================================

const VideoBackgroundAnimation: React.FC<LayoffQuoteProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = timings(props);

  // Cubic-bezier-ish ease-out via spring-like clamp
  const slideProgress = interpolate(frame, [fps * t.textInStart, fps * t.textInEnd], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // soft ease: 1 - (1-x)^3
  const eased = 1 - Math.pow(1 - slideProgress, 3);
  const textY = (1 - eased) * 25;
  const textOpacity = eased;

  const authorOpacity = interpolate(
    frame,
    [fps * t.authorInStart, fps * t.authorInEnd],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const authorY = interpolate(
    frame,
    [fps * t.authorInStart, fps * t.authorInEnd],
    [10, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const fontSize = props.fontSizeOverride || autoFontSize(props.quoteText);

  return (
    <AbsoluteFill style={{ fontFamily: FONT_STACK }}>
      <FilteredBackground
        videoSrc={props.backgroundVideo}
        categoryFallback={props.backgroundCategory}
        // Less aggressive blur — let the video read clearly
        blur={props.filters?.blur ?? 0.5}
        brightness={props.filters?.brightness ?? 0.45}
        saturation={props.filters?.saturation ?? 0.7}
      />
      {/* Heavier vignette for contrast */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.6) 100%)",
        }}
      />
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          padding: "120px 80px",
        }}
      >
        <div
          style={{
            fontSize,
            lineHeight: 1.45,
            color: "rgba(255,255,255,0.95)",
            textAlign: "center",
            textShadow:
              "0 2px 18px rgba(0,0,0,0.85), 0 0 40px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.6)",
            opacity: textOpacity,
            transform: `translateY(${textY}px)`,
            maxWidth: 880,
          }}
        >
          {props.quoteText}
        </div>
        <AuthorBlock author={props.author} opacity={authorOpacity} translateY={authorY} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ============================================================================
// Composition entry — routes by animationStyle
// ============================================================================

export const LayoffQuote: React.FC<LayoffQuoteProps> = (props) => {
  switch (props.animationStyle) {
    case "kenBurns":
      return <KenBurnsAnimation {...props} />;
    case "wordReveal":
      return <WordRevealAnimation {...props} />;
    case "parallax":
      return <ParallaxAnimation {...props} />;
    case "atmospheric":
      return <AtmosphericAnimation {...props} />;
    case "videoBackground":
      return <VideoBackgroundAnimation {...props} />;
    default:
      return <KenBurnsAnimation {...props} />;
  }
};
