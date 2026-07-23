/**
 * lib/colors.ts — single source of truth for SEMANTIC colors in the "tool"
 * surfaces (finance / inventory / admin).
 *
 * These encode meaning, not brand: use POSITIVE for gains/income/success,
 * NEGATIVE for losses/expenses/errors, WARNING for pending/near-threshold. The
 * finance SECTION accent is a separate role (FINANCE_ACCENT / FINANCE_COLOR) —
 * it's the emerald used for buttons, section highlights and BUY chips, and is
 * deliberately distinct from POSITIVE green.
 *
 * The aviation (flying) and dispatch surfaces are intentional SUB-BRANDS with
 * their own palettes (brighter greens/reds, HUD blues) and do NOT use these
 * tokens — don't migrate their colors here.
 *
 * Tailwind mirrors of these live in tailwind.config.js (`positive`/`negative`/
 * `warning`) for className usage; keep the two in sync.
 */

/** Positive — gain / income / success / goal-hit. Tailwind green-500. */
export const POSITIVE = "#22c55e";
/** Negative — loss / expense / over-budget / error. Tailwind red-500. */
export const NEGATIVE = "#ef4444";
/** Warning — pending / near-threshold / unmatched. Tailwind amber-500. */
export const WARNING = "#f59e0b";
/** Finance section accent (emerald-500). Distinct from POSITIVE by role. */
export const FINANCE_ACCENT = "#10b981";

/**
 * Append a hex alpha byte to a `#rrggbb` color → `#rrggbbaa`. Pass the byte
 * directly, e.g. `withAlpha(POSITIVE, 0x22)` for the ~13% tint used on chips.
 * Replaces the scattered `color + "22"` string concatenations.
 */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.max(0, Math.min(255, Math.round(alpha)));
  return hex + a.toString(16).padStart(2, "0");
}
