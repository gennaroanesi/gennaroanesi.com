import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { QuoteCard } from "@/components/layoff-philosophy/QuoteCard";
import {
  analyzeImage,
  autoFontSize,
  type ImageAnalysis,
} from "@/lib/layoff-philosophy/image-analysis";
import {
  backgroundCategories,
  quotes as allQuotes,
  type BackgroundCategory,
  type Quote,
  type QuoteStatus,
} from "@/lib/layoff-philosophy/quotes";

const DEFAULT_FILTERS = { blur: 2, brightness: 0.35, saturation: 0.6 };
const STATUS_FILTERS: Array<QuoteStatus | "all"> = ["ready", "draft", "published", "all"];
const STATUS_LABEL: Record<QuoteStatus | "all", string> = {
  ready: "Ready",
  draft: "Drafts",
  published: "Published",
  all: "All",
};

type Filters = typeof DEFAULT_FILTERS;
type Tab = "preset" | "custom";

const CUSTOM_BG: BackgroundCategory = "emptiness";

interface SliderProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
}

function Slider({ label, value, onChange, min, max, step }: SliderProps) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span
          style={{
            fontSize: 11,
            color: "rgba(255,255,255,0.4)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {label}
        </span>
        <span
          style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", fontFamily: "monospace" }}
        >
          {value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: "rgba(200,180,140,0.7)" }}
      />
    </div>
  );
}

interface DropZoneProps {
  onImageLoad: (dataUrl: string) => void;
  currentImage: string | null;
  hint: string;
}

function DropZone({ onImageLoad, currentImage, hint }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File | null | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result;
      if (typeof result === "string") onImageLoad(result);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFile(e.dataTransfer?.files?.[0]);
      }}
      onClick={() => inputRef.current?.click()}
      style={{
        border: dragging
          ? "2px solid rgba(200,180,140,0.6)"
          : currentImage
          ? "2px solid rgba(200,180,140,0.2)"
          : "2px dashed rgba(200,180,140,0.2)",
        padding: currentImage ? 0 : "24px 16px",
        textAlign: "center",
        cursor: "pointer",
        transition: "all 0.2s",
        background: dragging ? "rgba(200,180,140,0.05)" : "rgba(255,255,255,0.015)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {currentImage ? (
        <div style={{ position: "relative" }}>
          <img
            src={currentImage}
            alt="background"
            style={{ width: "100%", height: 100, objectFit: "cover", display: "block" }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.4)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: 0,
              transition: "opacity 0.2s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0")}
          >
            <span
              style={{
                color: "rgba(255,255,255,0.8)",
                fontSize: 12,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              Replace Image
            </span>
          </div>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 13, color: "rgba(200,180,140,0.6)", marginBottom: 6 }}>
            Drop an image here or click to browse
          </div>
          <div style={{ fontSize: 11, color: "rgba(200,180,140,0.3)" }}>{hint}</div>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={(e) => handleFile(e.target.files?.[0])}
        style={{ display: "none" }}
      />
    </div>
  );
}

function AnalysisBadge({ analysis }: { analysis: ImageAnalysis | null }) {
  if (!analysis) return null;
  const items = [
    { label: "Brightness", value: `${analysis.avgBrightness}%` },
    { label: "Saturation", value: `${analysis.avgSaturation}%` },
    { label: "Contrast", value: `${analysis.contrast}%` },
  ];
  return (
    <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
      {items.map((item) => (
        <div
          key={item.label}
          style={{
            padding: "4px 8px",
            background: "rgba(200,180,140,0.06)",
            border: "1px solid rgba(200,180,140,0.1)",
            fontSize: 10,
            color: "rgba(200,180,140,0.5)",
            letterSpacing: "0.05em",
          }}
        >
          {item.label}: <span style={{ color: "rgba(200,180,140,0.75)" }}>{item.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function QuoteCardGenerator() {
  const [statusFilter, setStatusFilter] = useState<QuoteStatus | "all">("ready");
  const visibleQuotes = useMemo(
    () => (statusFilter === "all" ? allQuotes : allQuotes.filter((q) => q.status === statusFilter)),
    [statusFilter]
  );

  const [selectedId, setSelectedId] = useState<string>(() => visibleQuotes[0]?.id ?? allQuotes[0].id);

  useEffect(() => {
    if (!visibleQuotes.find((q) => q.id === selectedId)) {
      setSelectedId(visibleQuotes[0]?.id ?? allQuotes[0].id);
    }
  }, [visibleQuotes, selectedId]);

  const [tab, setTab] = useState<Tab>("preset");
  const [customQuote, setCustomQuote] = useState("");
  const [customAuthor, setCustomAuthor] = useState("");

  const [imagesById, setImagesById] = useState<Record<string, string>>({});
  const [customImage, setCustomImage] = useState<string | null>(null);

  const [filters, setFilters] = useState<Filters>({ ...DEFAULT_FILTERS });
  const [analysis, setAnalysis] = useState<ImageAnalysis | null>(null);
  const [autoApplied, setAutoApplied] = useState(false);
  const [fontSizeOverride, setFontSizeOverride] = useState<number | null>(null);

  const selectedQuote = useMemo<Quote | undefined>(
    () => allQuotes.find((q) => q.id === selectedId),
    [selectedId]
  );

  const currentText =
    tab === "custom" ? customQuote || "Your quote here" : selectedQuote?.text ?? "";
  const currentAuthor =
    tab === "custom" ? customAuthor || "Philosopher" : selectedQuote?.author ?? "";
  const currentBgCategory: BackgroundCategory =
    tab === "custom" ? CUSTOM_BG : selectedQuote?.backgroundCategory ?? CUSTOM_BG;
  const currentBgMeta = backgroundCategories[currentBgCategory];
  const currentImage = tab === "custom" ? customImage : imagesById[selectedId] ?? null;
  const autoFont = autoFontSize(currentText);

  // Reset font override when the underlying text changes
  useEffect(() => {
    setFontSizeOverride(null);
  }, [selectedId, customQuote, tab]);

  const handleImageLoad = useCallback(
    async (dataUrl: string) => {
      if (tab === "custom") {
        setCustomImage(dataUrl);
      } else {
        setImagesById((prev) => ({ ...prev, [selectedId]: dataUrl }));
      }
      try {
        const result = await analyzeImage(dataUrl);
        setAnalysis(result.analysis);
        setFilters({
          blur: result.blur,
          brightness: result.brightness,
          saturation: result.saturation,
        });
        setAutoApplied(true);
        setTimeout(() => setAutoApplied(false), 2000);
      } catch (e) {
        console.error("[layoff-philosophy] image analysis failed", e);
      }
    },
    [tab, selectedId]
  );

  const handleReanalyze = useCallback(async () => {
    if (!currentImage) return;
    try {
      const result = await analyzeImage(currentImage);
      setFilters({
        blur: result.blur,
        brightness: result.brightness,
        saturation: result.saturation,
      });
      setAnalysis(result.analysis);
      setAutoApplied(true);
      setTimeout(() => setAutoApplied(false), 2000);
    } catch (e) {
      console.error("[layoff-philosophy] image analysis failed", e);
    }
  }, [currentImage]);

  const handleRemoveImage = useCallback(() => {
    if (tab === "custom") setCustomImage(null);
    else
      setImagesById((prev) => {
        const next = { ...prev };
        delete next[selectedId];
        return next;
      });
    setAnalysis(null);
  }, [tab, selectedId]);

  const handleExport = useCallback(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1080;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const text = currentText;
    const author = currentAuthor;
    const hasImg = !!currentImage;
    const exportFontSize = (fontSizeOverride || autoFontSize(text)) * 2; // 2x for 1080 export

    // Wait for Lora to be loaded (avoid first-click rendering with fallback serif)
    try {
      await document.fonts.load(`400 ${exportFontSize}px Lora`);
      await document.fonts.load(`400 28px Lora`);
    } catch {
      // older browsers: fall through
    }

    const drawText = () => {
      const vig = ctx.createRadialGradient(540, 540, 0, 540, 540, 700);
      vig.addColorStop(0, hasImg ? "rgba(0,0,0,0.1)" : "rgba(0,0,0,0)");
      vig.addColorStop(1, hasImg ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.5)");
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, 1080, 1080);

      ctx.font = `400 ${exportFontSize}px Lora, Georgia, serif`;
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (hasImg) {
        ctx.shadowColor = "rgba(0,0,0,0.7)";
        ctx.shadowBlur = 24;
        ctx.shadowOffsetY = 4;
      }

      const maxW = 880;
      const words = text.split(" ");
      const lines: string[] = [];
      let cur = "";
      for (const word of words) {
        const test = cur ? cur + " " + word : word;
        if (ctx.measureText(test).width > maxW && cur) {
          lines.push(cur);
          cur = word;
        } else {
          cur = test;
        }
      }
      if (cur) lines.push(cur);

      const lh = exportFontSize * 1.45;
      const totalH = lines.length * lh;
      const startY = 540 - totalH / 2;
      lines.forEach((line, i) => ctx.fillText(line, 540, startY + i * lh + lh / 2));

      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      const botY = startY + totalH + 45;
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(516, botY);
      ctx.lineTo(564, botY);
      ctx.stroke();

      if (hasImg) {
        ctx.shadowColor = "rgba(0,0,0,0.6)";
        ctx.shadowBlur = 12;
        ctx.shadowOffsetY = 2;
      }
      ctx.font = `400 28px Lora, Georgia, serif`;
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillText(author, 540, botY + 38);

      const link = document.createElement("a");
      const slug =
        tab === "custom"
          ? "custom"
          : selectedQuote?.id ?? "quote";
      link.download = `layoff-philosophy-${slug}-${Date.now()}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    };

    if (hasImg && currentImage) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        ctx.filter = `blur(${filters.blur * 2}px) brightness(${filters.brightness}) saturate(${filters.saturation})`;
        const sc = Math.max(1080 / img.width, 1080 / img.height);
        const w = img.width * sc;
        const h = img.height * sc;
        ctx.drawImage(img, (1080 - w) / 2 - 20, (1080 - h) / 2 - 20, w + 40, h + 40);
        ctx.filter = "none";
        drawText();
      };
      img.src = currentImage;
    } else {
      // Recreate the fallback gradient at 1080×1080. The CSS gradient string isn't
      // directly drawable to canvas, so we approximate by parsing the hex stops.
      const stops = parseGradientStops(currentBgMeta.fallbackGradient);
      const grad = ctx.createLinearGradient(0, 0, 200, 1080);
      stops.forEach(({ offset, color }) => grad.addColorStop(offset, color));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 1080, 1080);
      drawText();
    }
  }, [
    currentText,
    currentAuthor,
    currentImage,
    currentBgMeta.fallbackGradient,
    filters,
    fontSizeOverride,
    selectedQuote,
    tab,
  ]);

  const btnBase: React.CSSProperties = {
    fontFamily: "Lora, Georgia, serif",
    cursor: "pointer",
    transition: "all 0.2s",
  };

  const canExport = tab === "custom" ? customQuote.trim().length > 0 : !!selectedQuote;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a0a",
        color: "#e8e0d4",
        fontFamily: "Lora, Georgia, serif",
        padding: 20,
      }}
    >
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <h1
          style={{
            fontSize: 26,
            fontWeight: 400,
            color: "rgba(200,180,140,0.9)",
            margin: 0,
            letterSpacing: "0.04em",
          }}
        >
          Layoff Philosophy
        </h1>
        <p
          style={{
            fontSize: 12,
            color: "rgba(200,180,140,0.4)",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            marginTop: 6,
          }}
        >
          We may be paraphrasing
        </p>
      </div>

      <div
        style={{
          display: "flex",
          gap: 28,
          maxWidth: 1100,
          margin: "0 auto",
          flexWrap: "wrap",
          justifyContent: "center",
        }}
      >
        {/* Preview + export */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <QuoteCard
            text={currentText}
            author={currentAuthor}
            imageData={currentImage}
            fallbackGradient={currentBgMeta.fallbackGradient}
            filters={filters}
            fontSize={fontSizeOverride}
          />
          <button
            onClick={handleExport}
            disabled={!canExport}
            style={{
              ...btnBase,
              marginTop: 14,
              padding: 13,
              background: canExport ? "rgba(200,180,140,0.1)" : "rgba(200,180,140,0.04)",
              border: "1px solid rgba(200,180,140,0.25)",
              color: canExport ? "rgba(200,180,140,0.8)" : "rgba(200,180,140,0.3)",
              fontSize: 13,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              cursor: canExport ? "pointer" : "not-allowed",
            }}
          >
            Export 1080×1080 PNG
          </button>
        </div>

        {/* Controls */}
        <div style={{ flex: 1, minWidth: 280, maxWidth: 420 }}>
          {/* Tabs */}
          <div
            style={{
              display: "flex",
              marginBottom: 20,
              borderBottom: "1px solid rgba(200,180,140,0.12)",
            }}
          >
            {(["preset", "custom"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  ...btnBase,
                  flex: 1,
                  padding: "9px 14px",
                  background: "transparent",
                  border: "none",
                  borderBottom:
                    tab === t
                      ? "2px solid rgba(200,180,140,0.6)"
                      : "2px solid transparent",
                  color: tab === t ? "rgba(200,180,140,0.9)" : "rgba(200,180,140,0.35)",
                  fontSize: 12,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                }}
              >
                {t === "preset" ? "Quotes" : "Custom"}
              </button>
            ))}
          </div>

          {tab === "preset" ? (
            <>
              {/* Status filter */}
              <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
                {STATUS_FILTERS.map((s) => {
                  const count = s === "all" ? allQuotes.length : allQuotes.filter((q) => q.status === s).length;
                  const isActive = statusFilter === s;
                  return (
                    <button
                      key={s}
                      onClick={() => setStatusFilter(s)}
                      style={{
                        ...btnBase,
                        padding: "5px 10px",
                        background: isActive ? "rgba(200,180,140,0.08)" : "transparent",
                        border: isActive
                          ? "1px solid rgba(200,180,140,0.25)"
                          : "1px solid rgba(200,180,140,0.1)",
                        color: isActive ? "rgba(240,235,225,0.85)" : "rgba(200,180,140,0.45)",
                        fontSize: 10,
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                      }}
                    >
                      {STATUS_LABEL[s]} <span style={{ opacity: 0.5 }}>{count}</span>
                    </button>
                  );
                })}
              </div>

              {/* Quote list */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 7,
                  maxHeight: 380,
                  overflowY: "auto",
                  paddingRight: 4,
                }}
              >
                {visibleQuotes.map((q) => {
                  const isActive = selectedId === q.id;
                  return (
                    <button
                      key={q.id}
                      onClick={() => {
                        setSelectedId(q.id);
                        setAnalysis(null);
                      }}
                      style={{
                        ...btnBase,
                        padding: "12px 16px",
                        textAlign: "left",
                        fontSize: 13,
                        lineHeight: 1.4,
                        background: isActive
                          ? "rgba(200,180,140,0.08)"
                          : "rgba(255,255,255,0.015)",
                        border: isActive
                          ? "1px solid rgba(200,180,140,0.25)"
                          : "1px solid rgba(255,255,255,0.05)",
                        color: isActive ? "rgba(240,235,225,0.9)" : "rgba(240,235,225,0.45)",
                      }}
                    >
                      <div>{q.text}</div>
                      <div
                        style={{
                          fontSize: 10,
                          color: "rgba(200,180,140,0.45)",
                          marginTop: 5,
                          letterSpacing: "0.08em",
                          display: "flex",
                          justifyContent: "space-between",
                        }}
                      >
                        <span>{q.author}</span>
                        <span style={{ textTransform: "uppercase", opacity: 0.7 }}>
                          {q.status}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 10,
                    color: "rgba(200,180,140,0.45)",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    marginBottom: 6,
                  }}
                >
                  Quote
                </label>
                <textarea
                  value={customQuote}
                  onChange={(e) => setCustomQuote(e.target.value)}
                  placeholder="Enter your quote..."
                  rows={3}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(200,180,140,0.12)",
                    color: "rgba(240,235,225,0.85)",
                    fontSize: 14,
                    fontFamily: "Lora, Georgia, serif",
                    resize: "vertical",
                    outline: "none",
                    lineHeight: 1.5,
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 10,
                    color: "rgba(200,180,140,0.45)",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    marginBottom: 6,
                  }}
                >
                  Attribution
                </label>
                <input
                  value={customAuthor}
                  onChange={(e) => setCustomAuthor(e.target.value)}
                  placeholder="Philosopher name..."
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(200,180,140,0.12)",
                    color: "rgba(240,235,225,0.85)",
                    fontSize: 13,
                    fontFamily: "Lora, Georgia, serif",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>
            </div>
          )}

          {/* Font Size */}
          <div style={{ marginTop: 20 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <label
                style={{
                  fontSize: 10,
                  color: "rgba(200,180,140,0.45)",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                }}
              >
                Font Size
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    fontSize: 12,
                    color: "rgba(200,180,140,0.6)",
                    fontFamily: "monospace",
                  }}
                >
                  {fontSizeOverride || autoFont}px
                </span>
                {fontSizeOverride && (
                  <button
                    onClick={() => setFontSizeOverride(null)}
                    style={{
                      ...btnBase,
                      padding: "2px 6px",
                      background: "transparent",
                      border: "1px solid rgba(200,180,140,0.15)",
                      color: "rgba(200,180,140,0.4)",
                      fontSize: 9,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                    }}
                  >
                    Auto
                  </button>
                )}
              </div>
            </div>
            <input
              type="range"
              min={14}
              max={44}
              step={1}
              value={fontSizeOverride || autoFont}
              onChange={(e) => setFontSizeOverride(parseInt(e.target.value, 10))}
              style={{ width: "100%", accentColor: "rgba(200,180,140,0.7)" }}
            />
          </div>

          {/* Image upload */}
          <div style={{ marginTop: 18 }}>
            <label
              style={{
                display: "block",
                fontSize: 10,
                color: "rgba(200,180,140,0.45)",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              Background Image
            </label>
            <DropZone
              onImageLoad={handleImageLoad}
              currentImage={currentImage}
              hint={currentBgMeta.hint}
            />
            {currentImage && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <button
                  onClick={handleRemoveImage}
                  style={{
                    ...btnBase,
                    padding: "5px 10px",
                    background: "transparent",
                    border: "1px solid rgba(200,100,100,0.2)",
                    color: "rgba(200,100,100,0.5)",
                    fontSize: 10,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                  }}
                >
                  Remove
                </button>
                {autoApplied && (
                  <span
                    style={{
                      fontSize: 11,
                      color: "rgba(120,180,120,0.7)",
                      letterSpacing: "0.05em",
                    }}
                  >
                    ✓ Auto-adjusted
                  </span>
                )}
              </div>
            )}
            <AnalysisBadge analysis={currentImage ? analysis : null} />
          </div>

          {/* Filters */}
          {currentImage && (
            <div style={{ marginTop: 18 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 10,
                }}
              >
                <label
                  style={{
                    fontSize: 10,
                    color: "rgba(200,180,140,0.45)",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                  }}
                >
                  Image Adjustments
                </label>
                <button
                  onClick={handleReanalyze}
                  style={{
                    ...btnBase,
                    padding: "3px 8px",
                    background: "rgba(200,180,140,0.06)",
                    border: "1px solid rgba(200,180,140,0.15)",
                    color: "rgba(200,180,140,0.5)",
                    fontSize: 9,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                  }}
                >
                  Re-analyze
                </button>
              </div>
              <Slider
                label="Blur"
                value={filters.blur}
                onChange={(v) => setFilters((f) => ({ ...f, blur: v }))}
                min={0}
                max={12}
                step={0.5}
              />
              <Slider
                label="Brightness"
                value={filters.brightness}
                onChange={(v) => setFilters((f) => ({ ...f, brightness: v }))}
                min={0.1}
                max={1}
                step={0.05}
              />
              <Slider
                label="Saturation"
                value={filters.saturation}
                onChange={(v) => setFilters((f) => ({ ...f, saturation: v }))}
                min={0}
                max={1.5}
                step={0.05}
              />
              <button
                onClick={() => setFilters({ ...DEFAULT_FILTERS })}
                style={{
                  ...btnBase,
                  marginTop: 2,
                  padding: "5px 10px",
                  background: "transparent",
                  border: "1px solid rgba(200,180,140,0.15)",
                  color: "rgba(200,180,140,0.4)",
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
              >
                Reset defaults
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Parse hex color stops out of a CSS linear-gradient string.
 * Accepts: "linear-gradient(160deg, #1a1410 0%, #2c1f15 30%, ...)"
 */
function parseGradientStops(gradient: string): Array<{ offset: number; color: string }> {
  const stops: Array<{ offset: number; color: string }> = [];
  const re = /(#[0-9a-fA-F]{6})\s*(\d{1,3})%/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(gradient)) !== null) {
    stops.push({
      color: match[1],
      offset: Math.min(1, Math.max(0, parseInt(match[2], 10) / 100)),
    });
  }
  if (stops.length === 0) {
    return [
      { offset: 0, color: "#1a1410" },
      { offset: 1, color: "#0d0d0d" },
    ];
  }
  // Ensure boundary stops exist
  if (stops[0].offset > 0) stops.unshift({ offset: 0, color: stops[0].color });
  if (stops[stops.length - 1].offset < 1)
    stops.push({ offset: 1, color: stops[stops.length - 1].color });
  return stops;
}
