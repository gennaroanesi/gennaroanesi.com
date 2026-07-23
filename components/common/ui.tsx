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
  children,
}: {
  title: React.ReactNode;
  onClose: () => void;
  width?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`fixed inset-0 z-40 md:static md:inset-auto ${width} border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden`}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
        <h2 className="text-base font-semibold dark:text-rose text-purple">{title}</h2>
        <button
          onClick={onClose}
          aria-label="Close panel"
          className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2"
        >×</button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
        {children}
      </div>
    </div>
  );
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
