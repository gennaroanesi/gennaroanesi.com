import { autoFontSize } from "@/lib/layoff-philosophy/image-analysis";

export interface QuoteCardProps {
  text: string;
  author: string;
  imageData: string | null;
  fallbackGradient: string;
  filters: { blur: number; brightness: number; saturation: number };
  fontSize?: number | null;
  size?: number;
}

export function QuoteCard({
  text,
  author,
  imageData,
  fallbackGradient,
  filters,
  fontSize,
  size = 540,
}: QuoteCardProps) {
  const s = size / 540;
  const hasImage = !!imageData;
  const computedFontSize = fontSize || autoFontSize(text, size);

  return (
    <div
      style={{
        width: size,
        height: size,
        position: "relative",
        overflow: "hidden",
        fontFamily: "Lora, Georgia, serif",
        flexShrink: 0,
        background: "#111",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: hasImage ? -20 : 0,
          ...(hasImage
            ? {
                backgroundImage: `url(${imageData})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                filter: `blur(${filters.blur}px) brightness(${filters.brightness}) saturate(${filters.saturation})`,
              }
            : { background: fallbackGradient }),
          transition: "filter 0.3s ease",
        }}
      />
      {!hasImage && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E\")",
            backgroundRepeat: "repeat",
            backgroundSize: "256px",
            opacity: 0.5,
            pointerEvents: "none",
          }}
        />
      )}
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background: hasImage
            ? "radial-gradient(ellipse at center, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.45) 100%)"
            : "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.5) 100%)",
        }}
      />
      <div
        style={{
          position: "relative",
          zIndex: 2,
          padding: `${60 * s}px ${48 * s}px`,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          height: "100%",
          textAlign: "center",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            fontSize: computedFontSize,
            lineHeight: 1.45,
            color: "rgba(255,255,255,0.95)",
            fontWeight: 400,
            letterSpacing: "0.01em",
            maxWidth: 440 * s,
            textShadow: hasImage
              ? "0 2px 12px rgba(0,0,0,0.7), 0 1px 3px rgba(0,0,0,0.5)"
              : "none",
          }}
        >
          {text}
        </div>
        <div style={{ marginTop: 28 * s }}>
          <div
            style={{
              width: 24 * s,
              height: 1,
              background: "rgba(255,255,255,0.35)",
              margin: `0 auto ${12 * s}px`,
            }}
          />
          <div
            style={{
              fontSize: 14 * s,
              color: "rgba(255,255,255,0.7)",
              fontWeight: 400,
              letterSpacing: "0.08em",
              textShadow: hasImage ? "0 1px 6px rgba(0,0,0,0.6)" : "none",
            }}
          >
            {author}
          </div>
        </div>
      </div>
    </div>
  );
}
