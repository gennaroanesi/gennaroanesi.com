// Shared types, config and components for all inventory pages

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import type { Schema } from "@/amplify/data/resource";
import { uploadData, getUrl, remove } from "aws-amplify/storage";
import { v4 as uuidv4 } from "uuid";
import { Tooltip } from "@heroui/tooltip";
import NextLink from "next/link";

const BUCKET_NAME = "gennaroanesi.com";

// ── Re-exported record types ──────────────────────────────────────────────────

export type ItemRecord = Schema["inventoryItem"]["type"];
export type FirearmRecord = Schema["inventoryFirearm"]["type"];
export type AmmoRecord = Schema["inventoryAmmo"]["type"];
export type FilamentRecord = Schema["inventoryFilament"]["type"];
export type InstrumentRecord = Schema["inventoryInstrument"]["type"];

export type Category = "FIREARM" | "AMMO" | "FILAMENT" | "INSTRUMENT" | "OTHER";

// ── Config ────────────────────────────────────────────────────────────────────

export const CATEGORY_CONFIG: Record<
  Category,
  { label: string; color: string; href: string }
> = {
  FIREARM:    { label: "Firearm",    color: "#587D71", href: "/inventory/firearms" },
  AMMO:       { label: "Ammo",       color: "#B8940A", href: "/inventory/ammo" },
  FILAMENT:   { label: "Filament",   color: "#8B5CF6", href: "/inventory/filaments" },
  INSTRUMENT: { label: "Instrument", color: "#EC4899", href: "/inventory/instruments" },
  OTHER:      { label: "Other",      color: "#BCABAE", href: "/inventory/other" },
};

export const FIREARM_TYPES = ["HANDGUN","RIFLE","SHOTGUN","SBR","SUPPRESSOR","OTHER"] as const;
export const AMMO_UNITS    = ["ROUNDS","BOX","CASE"] as const;
export const FILAMENT_MATS = ["PLA","ABS","PETG","TPU","ASA","NYLON","PC","PLA_CF","PETG_CF","PA","PA_CF","PA6_GF","PVA","HIPS","OTHER"] as const;
export const FILAMENT_MAT_LABELS: Record<string, string> = {
  PLA: "PLA", ABS: "ABS", PETG: "PETG", TPU: "TPU", ASA: "ASA",
  NYLON: "Nylon", PC: "PC", PLA_CF: "PLA-CF", PETG_CF: "PETG-CF",
  PA: "PA", PA_CF: "PA-CF", PA6_GF: "PA6-GF", PVA: "PVA", HIPS: "HIPS", OTHER: "Other",
};
export const FILAMENT_VARIANTS = ["Basic", "HF", "95A HF", "for AMS", "Translucent", "Matte", "Silk", "Metal", "Sparkle", "Galaxy", "Marble", "Glow", "Gradient", "CF", "GF"] as const;
export const FILAMENT_DIAMS = ["d175","d285"] as const;
export const FILAMENT_DIAM_LABELS: Record<string, string> = { d175: "1.75 mm", d285: "2.85 mm" };
export const INSTRUMENT_TYPES      = ["GUITAR","BASS","AMPLIFIER","PEDAL","KEYBOARD","OTHER"] as const;
export const INSTRUMENT_PART_TYPES = ["TUBES","BRIDGE","PICKUPS","TUNERS","STRINGS","NUT","STRAP","CASE","OTHER"] as const;
export const INSTRUMENT_PART_LABELS: Record<string, string> = {
  TUBES: "Tubes", BRIDGE: "Bridge", PICKUPS: "Pickups", TUNERS: "Tuners",
  STRINGS: "Strings", NUT: "Nut", STRAP: "Strap", CASE: "Case", OTHER: "Other",
};
export const CURRENCIES = ["USD","EUR","GBP","CAD","AUD","JPY","CHF","MXN","BRL"] as const;

export const CALIBER_GROUPS: { label: string; calibers: string[] }[] = [
  {
    label: "Handgun",
    calibers: [
      ".22 LR", ".22 WMR", ".380 ACP", "9mm Luger", "9mm Makarov",
      ".38 Special", ".357 Magnum", ".357 SIG", ".40 S&W", "10mm Auto",
      ".44 Magnum", ".44 Special", ".45 ACP", ".45 Colt", "5.7x28mm",
    ],
  },
  {
    label: "Rifle",
    calibers: [
      ".17 HMR", ".223 Remington", "5.56x45mm NATO", ".224 Valkyrie",
      "6mm ARC", "6.5 Creedmoor", "6.5 Grendel", "6.5 PRC",
      ".270 Winchester", "7mm-08 Remington", "7mm Remington Magnum",
      "7.62x39mm", "7.62x51mm NATO", ".308 Winchester", ".30-06 Springfield",
      ".300 Blackout", ".300 Win Mag", ".338 Lapua Magnum",
      ".30 Carbine", "5.45x39mm", ".50 BMG",
    ],
  },
  {
    label: "Shotgun",
    calibers: ["12 Gauge", "16 Gauge", "20 Gauge", "28 Gauge", ".410 Bore"],
  },
  { label: "Other", calibers: ["Other"] },
];

export const CALIBERS = CALIBER_GROUPS.flatMap((g) => g.calibers);

// ── CaliberInput ──────────────────────────────────────────────────────────────

export function CaliberInput({
  value,
  onChange,
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef  = useRef<HTMLUListElement>(null);
  const [open,  setOpen]  = useState(false);
  const [hiIdx, setHiIdx] = useState(0);

  // All calibers flattened with group info for rendering
  const allOptions = CALIBER_GROUPS.flatMap((g) =>
    g.calibers.map((c) => ({ caliber: c, group: g.label }))
  );

  const filtered = value.trim() === ""
    ? allOptions
    : allOptions.filter((o) =>
        o.caliber.toLowerCase().includes(value.toLowerCase())
      );

  // Group filtered results for display
  const grouped = CALIBER_GROUPS
    .map((g) => ({ label: g.label, calibers: filtered.filter((o) => o.group === g.label).map((o) => o.caliber) }))
    .filter((g) => g.calibers.length > 0);

  // Flat list for keyboard nav index
  const flatFiltered = grouped.flatMap((g) => g.calibers);

  function select(cal: string) {
    onChange(cal);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) { setOpen(true); return; }
    if (e.key === "ArrowDown") { setHiIdx((i) => Math.min(i + 1, flatFiltered.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { setHiIdx((i) => Math.max(i - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter") { if (flatFiltered[hiIdx]) select(flatFiltered[hiIdx]); e.preventDefault(); }
    else if (e.key === "Escape") { setOpen(false); }
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        autoComplete="off"
        className={inputCls}
        placeholder="Start typing…"
        value={value}
        required={required}
        onFocus={() => { setOpen(true); setHiIdx(0); }}
        onBlur={() => {
          setTimeout(() => {
            if (!listRef.current?.contains(document.activeElement)) setOpen(false);
          }, 150);
        }}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHiIdx(0); }}
        onKeyDown={handleKeyDown}
      />
      {open && flatFiltered.length > 0 && (
        <ul
          ref={listRef}
          className="absolute z-50 left-0 right-0 mt-0.5 max-h-56 overflow-y-auto rounded-lg border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated shadow-lg text-sm"
        >
          {grouped.map((group) => (
            <li key={group.label}>
              <div className="px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-widest text-gray-400 dark:text-gray-500 font-semibold select-none">
                {group.label}
              </div>
              <ul>
                {group.calibers.map((cal) => {
                  const flatIdx = flatFiltered.indexOf(cal);
                  const isHi   = flatIdx === hiIdx;
                  return (
                    <li
                      key={cal}
                      onMouseDown={() => select(cal)}
                      onMouseEnter={() => setHiIdx(flatIdx)}
                      className={[
                        "px-4 py-1.5 cursor-pointer transition-colors text-gray-800 dark:text-gray-200",
                        isHi ? "bg-gray-100 dark:bg-white/10" : "hover:bg-gray-50 dark:hover:bg-white/5",
                      ].join(" ")}
                    >
                      {cal}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

export const inputCls =
  "w-full border rounded px-2 py-1.5 text-sm bg-white text-gray-800 border-gray-300 dark:bg-darkElevated dark:text-gray-100 dark:border-darkBorder";
export const labelCls =
  "text-xs uppercase tracking-widest text-gray-500 dark:text-gray-400 mb-1 block";
export const thCls =
  "text-left text-xs uppercase tracking-widest text-gray-500 dark:text-gray-400 px-3 py-2 font-medium whitespace-nowrap";
export const tdCls =
  "px-3 py-2 text-sm text-gray-700 dark:text-gray-200 whitespace-nowrap";

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Filament color map ───────────────────────────────────────────────────────
// Maps lowercase color names/aliases to CSS hex values.
export const FILAMENT_COLOR_MAP: Record<string, string> = {
  // Neutrals
  black:           "#1a1a1a",
  white:           "#f5f5f5",
  gray:            "#757575",
  grey:            "#757575",
  "dark gray":     "#424242",
  "dark grey":     "#424242",
  "light gray":    "#bdbdbd",
  "light grey":    "#bdbdbd",
  silver:          "#c0c0c0",
  natural:         "#f5deb3",
  translucent:     "#c8e6f5",
  transparent:     "#c8e6f5",
  // Reds / Pinks
  red:             "#d32f2f",
  "dark red":      "#7f0000",
  pink:            "#f48fb1",
  "cherry pink":   "#de3163",
  // Oranges
  orange:          "#e65100",
  "pumpkin orange":"#d2691e",
  // Yellows
  yellow:          "#f9a825",
  gold:            "#ffd700",
  "sunflower yellow": "#ffc200",
  tan:             "#d2b48c",
  copper:          "#b87333",
  // Greens
  green:           "#2e7d32",
  // Blues
  blue:            "#1565c0",
  // Purples
  purple:          "#6a1b9a",
};

// Resolve a color name to hex, falling back to a neutral
export function resolveFilamentColor(color: string | null | undefined): string {
  if (!color) return "#bcabae";
  return FILAMENT_COLOR_MAP[color.toLowerCase().trim()] ?? "#bcabae";
}

// Round color dot — used in summary cards and detail page
export function ColorDot({
  color, size = 16, title,
}: {
  color: string | null | undefined;
  size?: number;
  title?: string;
}) {
  const hex = resolveFilamentColor(color);
  const isLight = hex === "#f5f5f5" || hex === "#c8e6f5" || hex === "#f5deb3" || hex === "#bdbdbd" || hex === "#c0c0c0" || hex === "#ffd700" || hex === "#ffc200";
  return (
    <span
      title={title ?? color ?? ""}
      className="rounded-full flex-shrink-0 inline-block"
      style={{
        width:  size,
        height: size,
        backgroundColor: hex,
        border: `1.5px solid ${isLight ? "#00000033" : "#ffffff22"}`,
        boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
      }}
    />
  );
}

// Row of color dots for a set of filament records
export function FilamentColorDots({
  colors, size = 16, max = 12,
}: {
  colors: (string | null | undefined)[];
  size?: number;
  max?: number;
}) {
  // Deduplicate by resolved hex so near-duplicate names don't show twice
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of colors) {
    const hex = resolveFilamentColor(c);
    if (!seen.has(hex)) { seen.add(hex); unique.push(c ?? ""); }
  }
  const visible  = unique.slice(0, max);
  const overflow = unique.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((c, i) => (
        <ColorDot key={i} color={c} size={size} title={c} />
      ))}
      {overflow > 0 && (
        <span className="text-[10px] text-gray-400 leading-none">+{overflow}</span>
      )}
    </div>
  );
}

export function fmtCurrency(amount: number | null | undefined, currency = "USD") {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

export function fmtDate(date: string | null | undefined) {
  if (!date) return "—";
  return new Date(date + "T12:00:00").toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });
}

// ── Category badge ────────────────────────────────────────────────────────────

export function CategoryBadge({ category }: { category: string }) {
  const cfg = CATEGORY_CONFIG[category as Category] ?? CATEGORY_CONFIG.OTHER;
  return (
    <span
      className="inline-block px-2 py-0.5 rounded text-xs font-semibold"
      style={{
        backgroundColor: cfg.color + "33",
        color: cfg.color,
        border: `1px solid ${cfg.color}55`,
      }}
    >
      {cfg.label}
    </span>
  );
}

// ── SaveButton ────────────────────────────────────────────────────────────────

export function SaveButton({
  saving, onSave, label = "Save",
}: {
  saving: boolean; onSave: () => void; label?: string;
}) {
  return (
    <button
      onClick={onSave}
      disabled={saving}
      className="w-full py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 disabled:opacity-50 transition-opacity"
    >
      {saving ? "Saving…" : label}
    </button>
  );
}

// ── DeleteButton ──────────────────────────────────────────────────────────────

export function DeleteButton({ saving, onDelete }: { saving: boolean; onDelete: () => void }) {
  return (
    <button
      onClick={onDelete}
      disabled={saving}
      className="w-full py-2 rounded text-sm font-semibold border border-red-400 text-red-400 hover:bg-red-400 hover:text-white disabled:opacity-50 transition-colors"
    >
      Delete
    </button>
  );
}

// ── Base item form fields ─────────────────────────────────────────────────────

export function BaseItemFields({
  item,
  onChange,
  suggestions = {},
}: {
  item: Partial<ItemRecord>;
  onChange: (patch: Partial<ItemRecord>) => void;
  suggestions?: { brands?: string[]; vendors?: string[] };
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Name *</label>
          <input type="text" className={inputCls} placeholder="Glock 19"
            value={item.name ?? ""}
            onChange={(e) => onChange({ name: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>Brand</label>
          <input type="text" list="suggest-brands" className={inputCls} placeholder="Glock"
            value={item.brand ?? ""}
            onChange={(e) => onChange({ brand: e.target.value })} />
          {(suggestions.brands?.length ?? 0) > 0 && (
            <datalist id="suggest-brands">
              {suggestions.brands!.map((b) => <option key={b} value={b} />)}
            </datalist>
          )}
        </div>
      </div>
      <div>
        <label className={labelCls}>Description</label>
        <textarea rows={2} className={`${inputCls} resize-none`}
          value={item.description ?? ""}
          onChange={(e) => onChange({ description: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Date Purchased</label>
          <input type="date" className={inputCls}
            value={item.datePurchased ?? ""}
            onChange={(e) => onChange({ datePurchased: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>Vendor</label>
          <input type="text" list="suggest-vendors" className={inputCls} placeholder="Brownells"
            value={item.vendor ?? ""}
            onChange={(e) => onChange({ vendor: e.target.value })} />
          {(suggestions.vendors?.length ?? 0) > 0 && (
            <datalist id="suggest-vendors">
              {suggestions.vendors!.map((v) => <option key={v} value={v} />)}
            </datalist>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Total Paid</label>
          <input type="number" min={0} step={0.01} className={inputCls} placeholder="0.00"
            value={item.pricePaid ?? ""}
            onChange={(e) => onChange({ pricePaid: parseFloat(e.target.value) || null })} />
        </div>
        <div>
          <label className={labelCls}>Currency</label>
          <select className={inputCls} value={item.currency ?? "USD"}
            onChange={(e) => onChange({ currency: e.target.value })}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className={labelCls}>URL</label>
        <input type="url" className={inputCls} placeholder="https://…"
          value={item.url ?? ""}
          onChange={(e) => onChange({ url: e.target.value })} />
      </div>
      <div>
        <label className={labelCls}>Notes</label>
        <textarea rows={2} className={`${inputCls} resize-none`}
          value={item.notes ?? ""}
          onChange={(e) => onChange({ notes: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Price Sold</label>
          <input type="number" min={0} step={0.01} className={inputCls} placeholder="0.00"
            value={item.priceSold ?? ""}
            onChange={(e) => onChange({ priceSold: parseFloat(e.target.value) || null })} />
        </div>
        <div className="flex flex-col justify-end pb-1">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <span className={labelCls}>Active</span>
            <button
              type="button"
              role="switch"
              aria-checked={item.active !== false}
              onClick={() => onChange({ active: !(item.active !== false) })}
              className="relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none"
              style={{ backgroundColor: item.active !== false ? "#8B5CF6" : "#9ca3af" }}>
              <span
                className="pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform"
                style={{ transform: item.active !== false ? "translateX(16px)" : "translateX(0)" }}
              />
            </button>
          </label>
        </div>
      </div>
    </>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

export function EmptyState({
  label, onAdd, showCategoryLinks,
}: {
  label: string; onAdd: () => void; showCategoryLinks?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4 text-gray-400">
      <p className="text-sm">No {label} yet.</p>
      {showCategoryLinks ? (
        <div className="flex flex-wrap gap-2 justify-center">
          {(Object.entries(CATEGORY_CONFIG) as [Category, (typeof CATEGORY_CONFIG)[Category]][]).map(([cat, cfg]) => (
            <a key={cat} href={`${cfg.href}?new=1`}
              className="px-3 py-1.5 rounded text-xs font-semibold border transition-colors"
              style={{ borderColor: cfg.color + "88", color: cfg.color, backgroundColor: cfg.color + "18" }}>
              + {cfg.label}
            </a>
          ))}
        </div>
      ) : (
        <button onClick={onAdd}
          className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity">
          + Add {label}
        </button>
      )}
    </div>
  );
}

// ── useSuggestions ────────────────────────────────────────────────────────────

export function useSuggestions(items: ItemRecord[]) {
  const brands  = [...new Set(items.map((i) => i.brand).filter(Boolean)  as string[])].sort();
  const vendors = [...new Set(items.map((i) => i.vendor).filter(Boolean) as string[])].sort();
  return { brands, vendors };
}

// ── useThumbnails ─────────────────────────────────────────────────────────────

export function useThumbnails(items: { id: string; imageKeys?: (string | null)[] | null }[]) {
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const cacheKey = items.map((i) => i.id + (i.imageKeys?.[0] ?? "")).join(",");

  const resolveUrls = useCallback(
    async (cancelled: { current: boolean }) => {
      const entries = await Promise.all(
        items
          .filter((it) => it.imageKeys && it.imageKeys.length > 0)
          .map(async (it) => {
            const key = it.imageKeys![0]!;
            try {
              const { url } = await getUrl({ path: key, options: { bucket: BUCKET_NAME, expiresIn: 3600 } });
              return [it.id, url.toString()] as [string, string];
            } catch { return null; }
          }),
      );
      if (!cancelled.current) {
        setUrls(new Map(entries.filter(Boolean) as [string, string][]));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cacheKey],
  );

  useEffect(() => {
    const cancelled = { current: false };
    resolveUrls(cancelled);
    return () => { cancelled.current = true; };
  }, [resolveUrls]);

  return urls;
}

// ── Thumbnail cell ────────────────────────────────────────────────────────────

export function Thumbnail({ url, name }: { url?: string; name?: string | null }) {
  if (!url) {
    return (
      <div className="w-10 h-10 rounded-md bg-gray-100 dark:bg-darkElevated flex items-center justify-center flex-shrink-0">
        <span className="text-gray-300 dark:text-gray-600 text-lg select-none">📷</span>
      </div>
    );
  }
  return (
    <img src={url} alt={name ?? ""} className="w-10 h-10 rounded-md object-cover flex-shrink-0 border border-gray-200 dark:border-darkBorder" />
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function EyeIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  );
}

function SortIcon({ dir }: { dir: "asc" | "desc" | null }) {
  if (dir === "asc") return (
    <svg className="w-3 h-3 inline-block ml-1 text-purple dark:text-rose" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
    </svg>
  );
  if (dir === "desc") return (
    <svg className="w-3 h-3 inline-block ml-1 text-purple dark:text-rose" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
  return (
    <svg className="w-3 h-3 inline-block ml-1 opacity-25" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4M16 15l-4 4-4-4" />
    </svg>
  );
}

// ── FilterTypeahead ──────────────────────────────────────────────────────────
// Reusable typeahead filter used throughout the inventory. Pass options derived
// from your data; selected value is a string or "" for "all". Renders an
// inline pill when active with an × to clear.
//
// RULE: Always use <FilterTypeahead> for inventory filters — never plain <select>.

export function FilterTypeahead({
  label,
  placeholder,
  value,
  options,
  onChange,
}: {
  label: string;
  placeholder?: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef  = useRef<HTMLUListElement>(null);
  const [query,  setQuery]  = useState("");
  const [open,   setOpen]   = useState(false);
  const [hiIdx,  setHiIdx]  = useState(0);

  // When an external clear happens, reset query
  useEffect(() => { if (!value) setQuery(""); }, [value]);

  const filtered = query.trim() === ""
    ? options
    : options.filter((o) => o.toLowerCase().includes(query.toLowerCase()));

  function select(v: string) {
    onChange(v);
    setQuery(v);
    setOpen(false);
  }

  function clear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange("");
    setQuery("");
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) { setOpen(true); return; }
    if (e.key === "ArrowDown")  { setHiIdx((i) => Math.min(i + 1, filtered.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp")    { setHiIdx((i) => Math.max(i - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter")      { if (filtered[hiIdx]) select(filtered[hiIdx]); e.preventDefault(); }
    else if (e.key === "Escape")     { setOpen(false); if (!value) setQuery(""); }
    else if (e.key === "Backspace" && !query) { onChange(""); }
  }

  const displayValue = value || query;

  return (
    <div className="relative">
      <div className={[
        "flex items-center gap-1 border rounded px-2 py-1 text-xs bg-white dark:bg-darkElevated border-gray-300 dark:border-darkBorder cursor-text",
        value ? "border-purple/60 dark:border-rose/60" : "",
      ].join(" ")} onClick={() => { setOpen(true); inputRef.current?.focus(); }}>
        {!value && !query && (
          <span className="text-gray-400 select-none shrink-0">{label}:</span>
        )}
        {value ? (
          <span className="flex items-center gap-1 bg-purple/10 dark:bg-rose/10 text-purple dark:text-rose rounded px-1.5 py-0.5 text-[11px] font-medium shrink-0">
            <span className="text-gray-400 text-[10px] mr-0.5">{label}:</span>
            {value}
            <button onClick={clear} className="ml-0.5 opacity-60 hover:opacity-100 leading-none">×</button>
          </span>
        ) : (
          <input
            ref={inputRef}
            type="text"
            autoComplete="off"
            className="flex-1 min-w-[60px] bg-transparent outline-none text-gray-700 dark:text-gray-200 text-xs placeholder:text-gray-300"
            placeholder={placeholder ?? "Type to filter…"}
            value={query}
            onFocus={() => { setOpen(true); setHiIdx(0); }}
            onBlur={() => {
              setTimeout(() => {
                if (!listRef.current?.contains(document.activeElement)) setOpen(false);
              }, 150);
            }}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); setHiIdx(0); }}
            onKeyDown={handleKeyDown}
          />
        )}
        {value && (
          // hidden input so keyboard still works after selection
          <input
            ref={inputRef}
            type="text"
            className="w-0 h-0 opacity-0 absolute"
            onFocus={() => { onChange(""); setQuery(""); setTimeout(() => { setOpen(true); inputRef.current?.focus(); }, 0); }}
            readOnly
          />
        )}
      </div>

      {open && filtered.length > 0 && (
        <ul
          ref={listRef}
          className="absolute z-50 left-0 right-0 mt-0.5 max-h-52 overflow-y-auto rounded-lg border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated shadow-lg text-sm"
        >
          {filtered.map((opt, idx) => (
            <li
              key={opt}
              onMouseDown={() => select(opt)}
              onMouseEnter={() => setHiIdx(idx)}
              className={[
                "px-3 py-1.5 cursor-pointer transition-colors text-gray-800 dark:text-gray-200",
                idx === hiIdx ? "bg-gray-100 dark:bg-white/10" : "hover:bg-gray-50 dark:hover:bg-white/5",
              ].join(" ")}
            >
              {opt}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── useTableControls ──────────────────────────────────────────────────────────
// Sort + pagination state in one hook.

export type SortDir = "asc" | "desc";

export function useTableControls<T>(
  items: T[],
  getSortValue: (item: T, key: string) => string | number | null | undefined,
) {
  const [sortKey, setSortKey]   = useState<string | null>(null);
  const [sortDir, setSortDir]   = useState<SortDir>("asc");
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage]         = useState(1);

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(1);
  }

  const sorted = sortKey
    ? [...items].sort((a, b) => {
        const av = getSortValue(a, sortKey) ?? "";
        const bv = getSortValue(b, sortKey) ?? "";
        const cmp =
          typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
        return sortDir === "asc" ? cmp : -cmp;
      })
    : items;

  const totalPages  = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage    = Math.min(page, totalPages);
  const start       = (safePage - 1) * pageSize;
  const paged       = sorted.slice(start, start + pageSize);

  // reset to page 1 when items change
  useEffect(() => { setPage(1); }, [items]);

  return {
    sorted,
    paged,
    sortKey,
    sortDir,
    handleSort,
    page: safePage,
    setPage,
    pageSize,
    setPageSize,
    totalPages,
    totalItems: items.length,
  };
}

// ── TableControls (pagination bar) ───────────────────────────────────────────

const PAGE_SIZES = [25, 50, 100, 250, 500];

export function TableControls({
  page, totalPages, totalItems, pageSize,
  setPage, setPageSize,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  setPage: (p: number) => void;
  setPageSize: (n: number) => void;
}) {
  const start = Math.min((page - 1) * pageSize + 1, totalItems);
  const end   = Math.min(page * pageSize, totalItems);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 border-t border-gray-200 dark:border-darkBorder text-xs text-gray-500 dark:text-gray-400">

      {/* Left: row count info */}
      <span className="whitespace-nowrap">
        {totalItems === 0 ? "No items" : `${start}–${end} of ${totalItems}`}
      </span>

      {/* Center: page buttons */}
      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPage(1)}
            disabled={page === 1}
            className="px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-30 transition-colors"
            title="First page"
          >«</button>
          <button
            onClick={() => setPage(page - 1)}
            disabled={page === 1}
            className="px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-30 transition-colors"
          >‹</button>

          {/* page number pills — show up to 7 around current */}
          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
            .reduce<(number | "…")[]>((acc, p, idx, arr) => {
              if (idx > 0 && (p as number) - (arr[idx - 1] as number) > 1) acc.push("…");
              acc.push(p);
              return acc;
            }, [])
            .map((p, i) =>
              p === "…" ? (
                <span key={`ellipsis-${i}`} className="px-1">…</span>
              ) : (
                <button
                  key={p}
                  onClick={() => setPage(p as number)}
                  className={[
                    "w-6 h-6 rounded text-center transition-colors",
                    p === page
                      ? "bg-purple text-rose dark:bg-rose dark:text-purple font-semibold"
                      : "hover:bg-gray-100 dark:hover:bg-white/10",
                  ].join(" ")}
                >
                  {p}
                </button>
              )
            )}

          <button
            onClick={() => setPage(page + 1)}
            disabled={page === totalPages}
            className="px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-30 transition-colors"
          >›</button>
          <button
            onClick={() => setPage(totalPages)}
            disabled={page === totalPages}
            className="px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-30 transition-colors"
            title="Last page"
          >»</button>
        </div>
      )}

      {/* Right: page size selector */}
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <span>Rows:</span>
        <select
          value={pageSize}
          onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
          className="border rounded px-1 py-0.5 text-xs bg-white border-gray-300 dark:bg-darkElevated dark:border-darkBorder dark:text-gray-200 cursor-pointer"
        >
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
    </div>
  );
}

// ── ColDef ────────────────────────────────────────────────────────────────────

export type ColDef<T> = {
  key: string;
  label: string;
  render: (row: T) => React.ReactNode;
  /** Return a primitive for sorting. If omitted, column is not sortable. */
  sortValue?: (row: T) => string | number | null | undefined;
  className?: string;
  mobileHidden?: boolean;
};

// ── InventoryTable ────────────────────────────────────────────────────────────

export function InventoryTable<
  T extends { id: string; imageKeys?: (string | null)[] | null; name?: string | null }
>({
  items,
  columns,
  thumbnails,
  onEdit,
  onDelete,
  isLoading,
  sortKey,
  sortDir,
  onSort,
}: {
  items: T[];
  columns: ColDef<T>[];
  thumbnails: Map<string, string>;
  onEdit: (item: T) => void;
  onDelete: (item: T) => void;
  isLoading?: boolean;
  sortKey?: string | null;
  sortDir?: SortDir;
  onSort?: (key: string) => void;
}) {
  const DUMMY_ID = "__dummy__";
  const dummyRow = { id: DUMMY_ID, name: null } as unknown as T;
  const rows = [dummyRow, ...items];

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full">
        <thead className="bg-gray-50 dark:bg-darkElevated border-b border-gray-200 dark:border-darkBorder">
          <tr>
            <th className={`${thCls} w-12`}> </th>
            {columns.map((col) => {
              const isSortable = !!col.sortValue && !!onSort;
              const dir = sortKey === col.key ? (sortDir ?? null) : null;
              return (
                <th
                  key={col.key}
                  className={[
                    thCls,
                    col.mobileHidden ? "hidden md:table-cell" : "",
                    col.className ?? "",
                    isSortable ? "cursor-pointer select-none hover:text-gray-600 dark:hover:text-gray-300 transition-colors" : "",
                  ].join(" ")}
                  onClick={isSortable ? () => onSort!(col.key) : undefined}
                >
                  {col.label}
                  {isSortable && <SortIcon dir={dir} />}
                </th>
              );
            })}
            <th className={`${thCls} w-32 text-right`}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <tr>
              <td colSpan={columns.length + 2} className="text-center py-8 text-sm text-gray-400">
                Loading…
              </td>
            </tr>
          ) : (
            rows.map((item, rowIdx) => {
              const isDummy = item.id === DUMMY_ID;
              return (
                <tr
                  key={item.id}
                  className={[
                    "border-b border-gray-100 dark:border-darkBorder transition-colors",
                    rowIdx % 2 === 1 ? "bg-gray-50/50 dark:bg-white/[0.02]" : "",
                    isDummy
                      ? "opacity-30 pointer-events-none select-none"
                      : "hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer",
                  ].join(" ")}
                >
                  <td className={tdCls}>
                    {isDummy ? (
                      <div className="w-10 h-10 rounded-md bg-gray-200 dark:bg-darkElevated" />
                    ) : (
                      <button onClick={() => onEdit(item)} className="block focus:outline-none" tabIndex={-1}>
                        <Thumbnail url={thumbnails.get(item.id)} name={item.name} />
                      </button>
                    )}
                  </td>

                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`${tdCls} ${col.mobileHidden ? "hidden md:table-cell" : ""} ${col.className ?? ""}`}
                    >
                      {isDummy ? (
                        <span className="inline-block w-20 h-3 rounded bg-gray-200 dark:bg-darkElevated" />
                      ) : (
                        col.render(item)
                      )}
                    </td>
                  ))}

                  <td className={tdCls}>
                    <div className="flex items-center justify-end gap-1">
                      <Tooltip content="View detail" size="sm">
                        <span>
                          {isDummy ? (
                            <span className="p-1.5 inline-flex text-gray-200 dark:text-gray-700"><EyeIcon /></span>
                          ) : (
                            <NextLink
                              href={`/inventory/item/${item.id}`}
                              className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/10 transition-colors text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 inline-flex"
                            >
                              <EyeIcon />
                            </NextLink>
                          )}
                        </span>
                      </Tooltip>
                      <Tooltip content="Edit" size="sm">
                        <button
                          onClick={() => onEdit(item)}
                          disabled={isDummy}
                          className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/10 transition-colors text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:pointer-events-none"
                        >
                          <PencilIcon />
                        </button>
                      </Tooltip>
                      <Tooltip content="Delete" size="sm" color="danger">
                        <button
                          onClick={() => onDelete(item)}
                          disabled={isDummy}
                          className="p-1.5 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-gray-400 hover:text-red-500 disabled:pointer-events-none"
                        >
                          <TrashIcon />
                        </button>
                      </Tooltip>
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── resolveAllUrls ────────────────────────────────────────────────────────────

export async function resolveAllUrls(keys: string[]): Promise<string[]> {
  return Promise.all(
    keys.map(async (key) => {
      try {
        const { url } = await getUrl({ path: key, options: { bucket: BUCKET_NAME, expiresIn: 3600 } });
        return url.toString();
      } catch { return ""; }
    }),
  );
}

// ── ImageUploader ─────────────────────────────────────────────────────────────

export type ImageUploaderHandle = {
  commit: (itemId: string) => Promise<string[]>;
  hasPending: boolean;
};

type SlotState =
  | { kind: "existing"; key: string; url?: string }
  | { kind: "pending"; file: File; preview: string };

export const ImageUploader = forwardRef<
  ImageUploaderHandle,
  { itemId?: string; existingKeys?: (string | null)[] }
>(function ImageUploader({ existingKeys = [] }, ref) {
  const [slots,     setSlots]     = useState<SlotState[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver,  setDragOver]  = useState(false);
  const [dragIdx,      setDragIdx]      = useState<number | null>(null);
  const [dragOverIdx,  setDragOverIdx]  = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const existingKeysKey = existingKeys.join(",");

  useEffect(() => {
    let cancelled = false;
    async function resolveUrls() {
      const resolved: SlotState[] = await Promise.all(
        (existingKeys.filter(Boolean) as string[]).map(async (key) => {
          try {
            const { url } = await getUrl({ path: key, options: { bucket: BUCKET_NAME, expiresIn: 3600 } });
            return { kind: "existing" as const, key, url: url.toString() };
          } catch { return { kind: "existing" as const, key }; }
        }),
      );
      if (!cancelled) setSlots(resolved);
    }
    resolveUrls();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingKeysKey]);

  useImperativeHandle(ref, () => ({
    hasPending: slots.some((s) => s.kind === "pending"),
    commit: async (id: string) => {
      setUploading(true);
      try {
        const finalSlots: { kind: "existing"; key: string; url?: string }[] = [];
        for (const slot of slots) {
          if (slot.kind === "existing") {
            finalSlots.push(slot);
          } else {
            const ext = slot.file.name.split(".").pop() ?? "jpg";
            const key = `inventory/${id}/${uuidv4()}.${ext}`;
            await uploadData({ path: key, data: slot.file, options: { bucket: BUCKET_NAME, contentType: slot.file.type } }).result;
            const { url } = await getUrl({ path: key, options: { bucket: BUCKET_NAME, expiresIn: 3600 } });
            finalSlots.push({ kind: "existing", key, url: url.toString() });
            URL.revokeObjectURL(slot.preview);
          }
        }
        setSlots(finalSlots);
        return finalSlots.map((s) => s.key);
      } finally { setUploading(false); }
    },
  }), [slots]);

  function addFiles(files: FileList | null) {
    if (!files) return;
    const newSlots: SlotState[] = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .map((file) => ({ kind: "pending", file, preview: URL.createObjectURL(file) }));
    setSlots((prev) => [...prev, ...newSlots]);
  }

  async function removeSlot(idx: number) {
    const slot = slots[idx];
    if (slot.kind === "existing") {
      if (!confirm("Remove this image? This cannot be undone.")) return;
      try { await remove({ path: slot.key, options: { bucket: BUCKET_NAME } }); } catch { /* best effort */ }
    } else {
      URL.revokeObjectURL(slot.preview);
    }
    setSlots((prev) => prev.filter((_, i) => i !== idx));
  }

  function onDragStart(idx: number) { setDragIdx(idx); }
  function onDragEnter(idx: number) { setDragOverIdx(idx); }
  function onDragEnd() {
    if (dragIdx !== null && dragOverIdx !== null && dragIdx !== dragOverIdx) {
      setSlots((prev) => {
        const next = [...prev];
        const [moved] = next.splice(dragIdx, 1);
        next.splice(dragOverIdx, 0, moved);
        return next;
      });
    }
    setDragIdx(null);
    setDragOverIdx(null);
  }

  const imageUrl = (slot: SlotState) => slot.kind === "existing" ? slot.url : slot.preview;

  return (
    <div>
      <label className={labelCls}>Photos</label>
      {slots.length > 0 && (
        <div className="grid grid-cols-3 gap-2 mb-2">
          {slots.map((slot, idx) => (
            <div key={idx} draggable
              onDragStart={() => onDragStart(idx)} onDragEnter={() => onDragEnter(idx)}
              onDragEnd={onDragEnd} onDragOver={(e) => e.preventDefault()}
              className={[
                "relative group rounded overflow-hidden border-2 cursor-grab active:cursor-grabbing transition-all",
                dragOverIdx === idx && dragIdx !== idx ? "border-purple dark:border-rose scale-95" : "border-transparent",
                idx === 0 ? "col-span-3 aspect-video" : "aspect-square",
              ].join(" ")}
            >
              <img src={imageUrl(slot) ?? ""} alt={`Photo ${idx + 1}`} className="w-full h-full object-cover" />
              {slot.kind === "pending" && (
                <span className="absolute top-1 left-1 text-[10px] bg-gold text-darkPurple font-bold px-1.5 py-0.5 rounded">Pending</span>
              )}
              <span className="absolute top-1 right-6 text-[10px] bg-black/50 text-white px-1.5 py-0.5 rounded">{idx + 1}</span>
              <button onClick={() => removeSlot(idx)}
                className="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-500 text-white text-xs leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">×</button>
              <div className="absolute bottom-1 left-1 opacity-0 group-hover:opacity-60 transition-opacity text-white text-xs select-none">⠿</div>
            </div>
          ))}
        </div>
      )}
      <div
        className={[
          "border-2 border-dashed rounded-lg p-4 text-center transition-colors cursor-pointer",
          dragOver ? "border-purple dark:border-rose bg-purple/10" : "border-gray-300 dark:border-gray-600 hover:border-purple dark:hover:border-rose",
        ].join(" ")}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
      >
        <p className="text-xs text-gray-400">{uploading ? "Uploading…" : "Drop images here or click to browse"}</p>
        <p className="text-[10px] text-gray-300 dark:text-gray-600 mt-0.5">Drag thumbnails above to reorder · First image is the cover</p>
      </div>
      <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
    </div>
  );
});
