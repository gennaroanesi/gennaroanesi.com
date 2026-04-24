import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import NextLink from "next/link";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import FinanceLayout from "@/layouts/finance";
import {
  FINANCE_COLOR,
  fmtCurrency, fmtDate, todayIso, amountColor,
} from "@/components/finance/_shared";

// ── Types & local persistence ────────────────────────────────────────────────
// UI-only simulator: nothing persists to the backend. localStorage saves the
// scratchpad so a tab close / refresh doesn't wipe what you were modeling.

type Row = {
  id:          string;
  date:        string;   // YYYY-MM-DD
  description: string;
  amount:      number;
};

const STORAGE_KEY = "finance:simulator:cashflow:v1";

function makeId(): string {
  return `r${Math.random().toString(36).slice(2, 10)}`;
}

function defaultRows(): Row[] {
  return [{ id: makeId(), date: todayIso(), description: "Starting balance", amount: 0 }];
}

function loadRows(): Row[] {
  if (typeof window === "undefined") return defaultRows();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultRows();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultRows();
    // Trust but verify shape — strip junk fields.
    return parsed.map((p: any) => ({
      id:          typeof p.id === "string" ? p.id : makeId(),
      date:        typeof p.date === "string" ? p.date : todayIso(),
      description: typeof p.description === "string" ? p.description : "",
      amount:      Number.isFinite(p.amount) ? p.amount : 0,
    }));
  } catch {
    return defaultRows();
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function CashflowSimulatorPage() {
  const { authState } = useRequireAuth();

  // Keep rows in insertion order. Display sort is computed below; insertion
  // order survives as the within-same-date tiebreaker.
  const [rows, setRows]       = useState<Row[]>(() => defaultRows());
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from localStorage on mount (avoids SSR mismatch).
  useEffect(() => {
    setRows(loadRows());
    setHydrated(true);
  }, []);

  // Persist on change. Skipped until after hydration so we don't blow away the
  // saved state with the SSR default during the first paint.
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
    } catch { /* quota / private-mode — ignore */ }
  }, [rows, hydrated]);

  // ── Derived: chronological order + running balance ─────────────────────
  const view = useMemo(() => {
    const order = new Map(rows.map((r, i) => [r.id, i]));
    const sorted = [...rows].sort((a, b) =>
      a.date.localeCompare(b.date) || (order.get(a.id)! - order.get(b.id)!),
    );
    let running = 0;
    let low =  Infinity;
    let high = -Infinity;
    const annotated = sorted.map((r) => {
      running += r.amount;
      if (running < low)  low  = running;
      if (running > high) high = running;
      return { ...r, balance: running };
    });
    return {
      rows:          annotated,
      finalBalance:  running,
      lowPoint:      annotated.length ? low  : 0,
      highPoint:     annotated.length ? high : 0,
    };
  }, [rows]);

  // ── Mutations ───────────────────────────────────────────────────────────
  const updateRow = useCallback((id: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => r.id === id ? { ...r, ...patch } : r));
  }, []);

  const deleteRow = useCallback((id: string) => {
    setRows((prev) => prev.length <= 1 ? prev : prev.filter((r) => r.id !== id));
  }, []);

  // Insert a new row right after the given source. Returns the new id so the
  // caller can focus its amount field.
  const insertAfter = useCallback((sourceId: string, opts?: { sameDate?: boolean }) => {
    const newId = makeId();
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.id === sourceId);
      const src = idx >= 0 ? prev[idx] : prev[prev.length - 1];
      // Carry the source row's date forward (or "same date" intentionally — same behavior).
      // The two paths exist as separate APIs in case we want to differentiate later
      // (e.g., next-day default for plain Enter).
      void opts;
      const next: Row = { id: newId, date: src?.date ?? todayIso(), description: "", amount: 0 };
      const out = prev.slice();
      out.splice(idx + 1, 0, next);
      return out;
    });
    return newId;
  }, []);

  const duplicateRow = useCallback((id: string) => {
    const newId = makeId();
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.id === id);
      if (idx < 0) return prev;
      const src = prev[idx];
      const out = prev.slice();
      out.splice(idx + 1, 0, { ...src, id: newId, description: src.description });
      return out;
    });
    return newId;
  }, []);

  const resetAll = useCallback(() => {
    if (!confirm("Clear all rows? This can't be undone.")) return;
    setRows(defaultRows());
  }, []);

  // ── Focus management ────────────────────────────────────────────────────
  // Map of <row id, field> → input element. Used so handlers can move focus
  // to a specific cell on Enter / arrow / new row.
  const inputRefs = useRef(new Map<string, HTMLInputElement | HTMLTextAreaElement>());
  const refKey = (id: string, field: "date" | "description" | "amount") => `${id}:${field}`;
  const setRef = (id: string, field: "date" | "description" | "amount") =>
    (el: HTMLInputElement | HTMLTextAreaElement | null) => {
      const k = refKey(id, field);
      if (el) inputRefs.current.set(k, el);
      else    inputRefs.current.delete(k);
    };
  const focus = (id: string, field: "date" | "description" | "amount") => {
    // Defer to the next paint so newly-inserted rows have their refs registered.
    requestAnimationFrame(() => {
      inputRefs.current.get(refKey(id, field))?.focus();
      const el = inputRefs.current.get(refKey(id, field));
      if (el && "select" in el) (el as HTMLInputElement).select();
    });
  };

  // ── Keyboard handlers per cell ──────────────────────────────────────────
  // Handler factory: returns a keydown handler that knows which cell it sits
  // on. The "view" array is the chronological one — rowIndex is index within it.
  const makeKeyHandler = (
    rowId: string,
    field: "date" | "description" | "amount",
    rowIndex: number,
  ) => (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const meta = e.metaKey || e.ctrlKey;

    // Cmd/Ctrl + D → duplicate row
    if (meta && e.key.toLowerCase() === "d") {
      e.preventDefault();
      const newId = duplicateRow(rowId);
      focus(newId, field);
      return;
    }

    // Cmd/Ctrl + Backspace on an empty amount or empty desc → delete row
    if (meta && e.key === "Backspace") {
      const row = rows.find((r) => r.id === rowId);
      const isEmpty = row && (row.amount === 0 && !row.description.trim());
      if (isEmpty && rows.length > 1) {
        e.preventDefault();
        const prevRow = view.rows[rowIndex - 1] ?? view.rows[rowIndex + 1];
        deleteRow(rowId);
        if (prevRow) focus(prevRow.id, field);
        return;
      }
    }

    // Up/Down arrows → move focus to same field on adjacent row
    if (e.key === "ArrowUp" && rowIndex > 0) {
      e.preventDefault();
      focus(view.rows[rowIndex - 1].id, field);
      return;
    }
    if (e.key === "ArrowDown" && rowIndex < view.rows.length - 1) {
      e.preventDefault();
      focus(view.rows[rowIndex + 1].id, field);
      return;
    }

    // Enter on amount → commit + add new row, focus its amount.
    // Shift+Enter behaves the same; reserved for differentiation later.
    if (e.key === "Enter" && field === "amount") {
      e.preventDefault();
      // If we're on the last row in chrono order, add after it. Otherwise add
      // after the current row's chrono position so the user can keep typing
      // forward in time.
      const newId = insertAfter(rowId, { sameDate: e.shiftKey });
      focus(newId, "amount");
    }
  };

  // ── Amount input parsing ────────────────────────────────────────────────
  // Allow signed entries with $ and commas: "$1,200.50", "-500", "+250".
  // Returns null on un-parseable so we can preserve the user's draft text.
  const parseAmount = (raw: string): number | null => {
    const cleaned = raw.replace(/[$,\s]/g, "");
    if (!cleaned || cleaned === "-" || cleaned === "+") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  };

  // Per-row local string state for the amount input so users can type "-" then
  // a number without us coercing it to 0 mid-keystroke.
  const [amountDrafts, setAmountDrafts] = useState<Record<string, string>>({});

  const onAmountChange = (rowId: string, raw: string) => {
    setAmountDrafts((d) => ({ ...d, [rowId]: raw }));
    const parsed = parseAmount(raw);
    if (parsed !== null) updateRow(rowId, { amount: parsed });
  };
  const onAmountBlur = (rowId: string) => {
    // Drop the draft so the next render shows the canonical formatted value.
    setAmountDrafts((d) => {
      const next = { ...d };
      delete next[rowId];
      return next;
    });
    const row = rows.find((r) => r.id === rowId);
    if (row && Number.isNaN(row.amount)) updateRow(rowId, { amount: 0 });
  };

  if (authState !== "authenticated") return null;

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

          <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
            <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
            <span>›</span>
            <span>Simulator</span>
            <span>›</span>
            <span>Cashflow</span>
          </div>

          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
            <div>
              <h1 className="text-2xl font-bold text-purple dark:text-rose">Cashflow Simulator</h1>
              <p className="text-xs text-gray-400 mt-0.5">
                UI-only scratchpad. Add dated entries, get a rolling balance.
                Saved locally to this browser.
              </p>
            </div>
            <button
              onClick={resetAll}
              className="text-[11px] text-gray-400 hover:text-red-500 transition-colors"
            >
              Reset
            </button>
          </div>

          {/* ── Summary ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <SummaryTile label="Final"         value={view.finalBalance} accent />
            <SummaryTile label="Low point"     value={view.lowPoint}  />
            <SummaryTile label="High point"    value={view.highPoint} />
            <SummaryTile label="Rows"          rawValue={view.rows.length.toString()} />
          </div>

          {/* ── Table ──────────────────────────────────────────────── */}
          <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-darkElevated">
                <tr className="text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium">
                  <th className="px-3 py-2 w-10">#</th>
                  <th className="px-3 py-2 w-36">Date</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2 w-32 text-right">Amount</th>
                  <th className="px-3 py-2 w-32 text-right">Balance</th>
                  <th className="px-3 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {view.rows.map((r, i) => (
                  <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-white/5">
                    <td className="px-3 py-1 text-[11px] text-gray-400 tabular-nums">{i + 1}</td>
                    <td className="px-3 py-1">
                      <input
                        ref={setRef(r.id, "date")}
                        type="date"
                        value={r.date}
                        onChange={(e) => updateRow(r.id, { date: e.target.value })}
                        onKeyDown={makeKeyHandler(r.id, "date", i)}
                        className="bg-transparent border-0 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-emerald-500 rounded px-1 w-full"
                      />
                    </td>
                    <td className="px-3 py-1">
                      <input
                        ref={setRef(r.id, "description")}
                        type="text"
                        value={r.description}
                        placeholder="—"
                        onChange={(e) => updateRow(r.id, { description: e.target.value })}
                        onKeyDown={makeKeyHandler(r.id, "description", i)}
                        className="bg-transparent border-0 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-emerald-500 rounded px-1 w-full placeholder:text-gray-400"
                      />
                    </td>
                    <td className="px-3 py-1 text-right">
                      <input
                        ref={setRef(r.id, "amount")}
                        type="text"
                        inputMode="decimal"
                        value={amountDrafts[r.id] ?? (r.amount === 0 ? "" : r.amount.toFixed(2))}
                        placeholder="0.00"
                        onChange={(e) => onAmountChange(r.id, e.target.value)}
                        onBlur={() => onAmountBlur(r.id)}
                        onKeyDown={makeKeyHandler(r.id, "amount", i)}
                        className="bg-transparent border-0 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-emerald-500 rounded px-1 w-full text-right"
                        style={{ color: amountColor(r.amount) }}
                      />
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums text-xs"
                        style={{ color: amountColor(r.balance) }}>
                      {fmtCurrency(r.balance, "USD")}
                    </td>
                    <td className="px-3 py-1 text-right">
                      <button
                        onClick={() => deleteRow(r.id)}
                        disabled={rows.length <= 1}
                        title="Delete row"
                        className="text-xs text-gray-300 hover:text-red-500 transition-colors disabled:opacity-30"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-gray-200 dark:border-darkBorder px-3 py-2 flex items-center justify-between gap-2">
              <button
                onClick={() => {
                  const last = view.rows[view.rows.length - 1];
                  const newId = insertAfter(last?.id ?? "");
                  focus(newId, "amount");
                }}
                className="text-[11px] font-semibold px-2 py-1 rounded border transition-colors"
                style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR }}
              >
                + Add row
              </button>
              <KeyboardHints />
            </div>
          </div>

          <p className="text-[10px] text-gray-400 mt-4">
            Tip: this is local-only — no transactions or accounts are touched. Use it for
            "what if I move $X on date Y" thinking. Refresh-safe via your browser's localStorage.
          </p>
        </div>
      </div>
    </FinanceLayout>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function SummaryTile({
  label, value, rawValue, accent,
}: {
  label:    string;
  value?:   number;
  rawValue?: string;
  accent?:  boolean;
}) {
  const display = rawValue ?? (value != null ? fmtCurrency(value) : "—");
  const color   = accent && value != null
    ? amountColor(value)
    : "currentColor";
  return (
    <div className="rounded-lg border border-gray-200 dark:border-darkBorder px-3 py-2">
      <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">{label}</p>
      <p className="text-base font-bold tabular-nums" style={{ color }}>{display}</p>
    </div>
  );
}

function KeyboardHints() {
  return (
    <div className="flex items-center gap-2 text-[10px] text-gray-400 flex-wrap justify-end">
      <Hint k="Enter">add row</Hint>
      <Hint k="↑↓">navigate</Hint>
      <Hint k="⌘D">duplicate</Hint>
      <Hint k="⌘⌫">delete (when empty)</Hint>
    </div>
  );
}

function Hint({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      <kbd className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-[9px] font-mono">{k}</kbd>
      <span>{children}</span>
    </span>
  );
}
