/**
 * components/common/ui.tsx — shared UI primitives.
 *
 * Extracted verbatim from the patterns copy-pasted across finance/inventory/
 * admin so they live in one place. These are intentionally VISUAL NO-OPS: the
 * markup/classes match what pages already render, so adopting them changes
 * nothing on screen — it just removes duplication.
 *
 * Colors here use the app's real tokens (purple/rose accent, darkSurface/
 * darkBorder surfaces). Accent-colored bits (Badge) take an explicit color so
 * both the finance (emerald) and inventory (per-category) worlds can share them.
 */
import React from "react";

// ── Card ────────────────────────────────────────────────────────────────────
// The `rounded-lg border … bg-white dark:bg-darkSurface p-4` wrapper that
// appears ~55× inline plus three local `Card`/`CARD` definitions.
export const CARD_CLASS =
  "rounded-lg border border-gray-200 dark:border-darkBorder p-4 bg-white dark:bg-darkSurface";

export function Card({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return <div className={`${CARD_CLASS} ${className}`}>{children}</div>;
}

// ── Page title (h1) ───────────────────────────────────────────────────────────
// The standard list/section heading. Replaces the 5 ad-hoc h1 variants.
export function PageTitle({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return <h1 className={`text-2xl font-bold text-purple dark:text-rose ${className}`}>{children}</h1>;
}

// ── Loading placeholder ───────────────────────────────────────────────────────
// The `animate-pulse … Loading…` block copy-pasted ~25×.
export function PageLoading({ label = "Loading…", className = "" }: { label?: string; className?: string }) {
  return <p className={`text-sm text-gray-400 animate-pulse py-12 text-center ${className}`}>{label}</p>;
}

// ── Slide-over side panel ─────────────────────────────────────────────────────
// The full-screen-on-mobile / fixed-width-on-desktop editor shell copy-pasted
// ~24× (finance/inventory/admin). Header (title + ×) is built in; children are
// the scrollable body (fields + save/delete buttons). `width` overrides the
// desktop width for the wider panels (e.g. "md:w-[28rem]", "md:w-[44rem]").
export function SlideOverPanel({
  title,
  onClose,
  width = "md:w-96",
  titleClassName = "",
  titleColor,
  footer,
  children,
}: {
  title: React.ReactNode;
  onClose: () => void;
  width?: string;
  /** Extra classes on the title h2 (e.g. "truncate"). */
  titleClassName?: string;
  /** Override the title color via inline style (e.g. an inventory category accent). */
  titleColor?: string;
  /** Pinned footer rendered OUTSIDE the scrollable body (e.g. a sticky action bar). */
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={`fixed inset-0 z-40 md:static md:inset-auto ${width} border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden`}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
        <h2 className={`text-base font-semibold dark:text-rose text-purple ${titleClassName}`} style={titleColor ? { color: titleColor } : undefined}>{title}</h2>
        <button
          onClick={onClose}
          aria-label="Close panel"
          className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2"
        >×</button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
        {children}
      </div>
      {footer}
    </div>
  );
}

// ── Form field styles ─────────────────────────────────────────────────────────
// Canonical text-input structure (rounded-lg + focus ring), shared by finance and
// inventory. The focus-RING COLOR is appended per section (emerald / purple) so
// each keeps its accent — `${INPUT_BASE} focus:ring-emerald-400/50`. LABEL_CLASS
// is fully shared.
export const INPUT_BASE =
  "w-full rounded-lg border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated px-3 py-1.5 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 transition";
export const LABEL_CLASS =
  "block text-[11px] uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-1 font-medium";

// ── Buttons ───────────────────────────────────────────────────────────────────
// The filled accent CTA (`bg-purple text-rose dark:bg-rose dark:text-purple`)
// inlined ~10× as "+ Add X" / submit buttons, and the amber outline secondary.
// Standardizes padding on py-2 / py-1.5 (a couple of primary call sites used
// py-1.5 — normalized to py-2 for consistency). Both accept native <button>
// props (onClick, disabled, type, children) and an extra className.
export const PRIMARY_BTN_CLASS =
  "px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 disabled:opacity-50 transition-opacity";
export const SECONDARY_BTN_CLASS =
  "px-3 py-1.5 rounded text-xs font-semibold border border-amber-400/60 text-amber-400 hover:bg-amber-400/10 disabled:opacity-50 transition-colors";

export function PrimaryButton({ className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`${PRIMARY_BTN_CLASS} ${className}`} {...props} />;
}
export function SecondaryButton({ className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`${SECONDARY_BTN_CLASS} ${className}`} {...props} />;
}

// ── Badge / pill ──────────────────────────────────────────────────────────────
// The colored `rounded-full` pill (`bg = color+alpha`) reimplemented ~12× and as
// AccountBadge/StatusBadge/CategoryBadge. `uppercase` matches the finance chips;
// pass uppercase={false} for sentence-case pills.
export function Badge({
  color,
  children,
  uppercase = true,
  className = "",
}: {
  color: string;
  children: React.ReactNode;
  uppercase?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide ${uppercase ? "uppercase" : ""} ${className}`}
      style={{ backgroundColor: color + "22", color }}
    >
      {children}
    </span>
  );
}
