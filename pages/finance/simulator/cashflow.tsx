import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import NextLink from "next/link";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useS3JsonState, type S3SyncStatus } from "@/hooks/useS3JsonState";
import FinanceLayout from "@/layouts/finance";
import {
  FINANCE_COLOR,
  fmtCurrency, todayIso, amountColor,
} from "@/components/finance/_shared";

// ── Types & persistence ─────────────────────────────────────────────────────
// UI-only simulator: nothing touches finance models. State is mirrored to S3
// (via useS3JsonState) so it survives across browsers/devices, plus to
// localStorage for instant cold-start and offline edits.
//
// v2 wraps Row[] in Cashflow[] so the user can model multiple "what-if"
// timelines side by side (e.g. "house purchase", "freelance gap", "max-out
// retirement"). Each tab is one Cashflow.

type Row = {
  id:          string;
  date:        string;   // YYYY-MM-DD
  description: string;
  amount:      number;
};

type Cashflow = {
  id:    string;
  name:  string;
  rows:  Row[];
};

const S3_BUCKET      = "gennaroanesi.com";
const S3_PATH        = "simulator-state/cashflow.json";
const LOCAL_KEY      = "finance:simulator:cashflow:v1";   // hook-managed mirror
const ACTIVE_LS_KEY  = "finance:simulator:cashflow:active"; // per-device, not synced

function makeId(prefix = "r"): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

function defaultRows(): Row[] {
  return [{ id: makeId(), date: todayIso(), description: "Starting balance", amount: 0 }];
}

function defaultCashflows(): Cashflow[] {
  return [{ id: makeId("c"), name: "Cashflow 1", rows: defaultRows() }];
}

/** v1 → v2 shape detection: a row of the old persistence format has `amount`
 *  and `date` at the top level instead of being wrapped in a Cashflow. */
function looksLikeLegacyRows(value: unknown): value is Row[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const first = value[0] as any;
  return first
    && typeof first === "object"
    && "amount" in first
    && "date" in first
    && !("rows" in first);
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function CashflowSimulatorPage() {
  const { authState } = useRequireAuth();

  const { value: cashflows, setValue: setCashflows, status: syncStatus, lastSavedAt } =
    useS3JsonState<Cashflow[]>(S3_PATH, defaultCashflows, {
      bucket: S3_BUCKET,
      localStorageKey: LOCAL_KEY,
      // Gate S3 ops on auth — Amplify Storage needs credentials. The hook
      // still mirrors to localStorage while we wait, so no keystrokes lost.
      enabled: authState === "authenticated",
    });

  // One-shot migration from v1 (Row[]) to v2 (Cashflow[]). Runs whenever a
  // legacy shape is detected; the next save effect persists the wrapped form.
  useEffect(() => {
    if (looksLikeLegacyRows(cashflows)) {
      const legacy = cashflows as unknown as Row[];
      setCashflows([{ id: makeId("c"), name: "Cashflow 1", rows: legacy }]);
    } else if (Array.isArray(cashflows) && cashflows.length === 0) {
      setCashflows(defaultCashflows());
    }
  }, [cashflows, setCashflows]);

  // Active cashflow id — per-device, not synced (each device may have its own
  // active scratchpad). Validated whenever `cashflows` changes identity (NOT
  // just length) — the S3 load often replaces the initial placeholder with
  // a same-length-but-different-id set, and row/rename ops target by id, so
  // drift here silently no-ops every edit.
  const [activeId, setActiveId] = useState<string>("");
  useEffect(() => {
    const hasActive = !!activeId && cashflows.some((c) => c.id === activeId);
    if (hasActive) return;
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(ACTIVE_LS_KEY);
    if (saved && cashflows.some((c) => c.id === saved)) {
      setActiveId(saved);
    } else if (cashflows.length > 0) {
      setActiveId(cashflows[0].id);
    }
  }, [cashflows, activeId]);
  useEffect(() => {
    if (typeof window === "undefined" || !activeId) return;
    window.localStorage.setItem(ACTIVE_LS_KEY, activeId);
  }, [activeId]);

  const active = useMemo(
    () => cashflows.find((c) => c.id === activeId) ?? cashflows[0],
    [cashflows, activeId],
  );
  const rows = active?.rows ?? [];

  // ── Mutations on the active cashflow's rows ────────────────────────────
  const setActiveRows = useCallback((updater: (prev: Row[]) => Row[]) => {
    setCashflows((prev) => prev.map((c) => c.id === activeId ? { ...c, rows: updater(c.rows) } : c));
  }, [activeId, setCashflows]);

  const updateRow = useCallback((id: string, patch: Partial<Row>) => {
    setActiveRows((prev) => prev.map((r) => r.id === id ? { ...r, ...patch } : r));
  }, [setActiveRows]);

  const deleteRow = useCallback((id: string) => {
    setActiveRows((prev) => prev.length <= 1 ? prev : prev.filter((r) => r.id !== id));
  }, [setActiveRows]);

  // Insert a new row right after the given source. Returns the new id so the
  // caller can focus its amount field.
  const insertAfter = useCallback((sourceId: string, opts?: { sameDate?: boolean }) => {
    const newId = makeId();
    setActiveRows((prev) => {
      const idx = prev.findIndex((r) => r.id === sourceId);
      const src = idx >= 0 ? prev[idx] : prev[prev.length - 1];
      void opts; // sameDate currently identical to default (carry forward)
      const next: Row = { id: newId, date: src?.date ?? todayIso(), description: "", amount: 0 };
      const out = prev.slice();
      out.splice(idx + 1, 0, next);
      return out;
    });
    return newId;
  }, [setActiveRows]);

  const duplicateRow = useCallback((id: string) => {
    const newId = makeId();
    setActiveRows((prev) => {
      const idx = prev.findIndex((r) => r.id === id);
      if (idx < 0) return prev;
      const src = prev[idx];
      const out = prev.slice();
      out.splice(idx + 1, 0, { ...src, id: newId });
      return out;
    });
    return newId;
  }, [setActiveRows]);

  const resetActive = useCallback(() => {
    if (!confirm(`Clear all rows on "${active?.name ?? "this cashflow"}"?`)) return;
    setActiveRows(() => defaultRows());
  }, [active?.name, setActiveRows]);

  // ── Mutations on the cashflows list ─────────────────────────────────────
  const addCashflow = useCallback(() => {
    const newId = makeId("c");
    setCashflows((prev) => [
      ...prev,
      { id: newId, name: `Cashflow ${prev.length + 1}`, rows: defaultRows() },
    ]);
    setActiveId(newId);
  }, [setCashflows]);

  const deleteCashflow = useCallback((id: string) => {
    if (cashflows.length <= 1) {
      alert("Can't delete the last cashflow — reset it instead.");
      return;
    }
    const c = cashflows.find((x) => x.id === id);
    if (!confirm(`Delete cashflow "${c?.name ?? id}" and all its rows?`)) return;
    const remaining = cashflows.filter((x) => x.id !== id);
    setCashflows(remaining);
    if (activeId === id) {
      setActiveId(remaining[0].id);
    }
  }, [cashflows, activeId, setCashflows]);

  const renameActive = useCallback((name: string) => {
    setCashflows((prev) => prev.map((c) => c.id === activeId ? { ...c, name } : c));
  }, [activeId, setCashflows]);

  // ── Derived: chronological order + running balance for the active flow ─
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

  // ── Focus management ────────────────────────────────────────────────────
  const inputRefs = useRef(new Map<string, HTMLInputElement | HTMLTextAreaElement>());
  const refKey = (id: string, field: "date" | "description" | "amount") => `${id}:${field}`;
  const setRef = (id: string, field: "date" | "description" | "amount") =>
    (el: HTMLInputElement | HTMLTextAreaElement | null) => {
      const k = refKey(id, field);
      if (el) inputRefs.current.set(k, el);
      else    inputRefs.current.delete(k);
    };
  const focus = (id: string, field: "date" | "description" | "amount") => {
    requestAnimationFrame(() => {
      const el = inputRefs.current.get(refKey(id, field));
      el?.focus();
      if (el && "select" in el) (el as HTMLInputElement).select();
    });
  };

  // ── Keyboard handlers per cell ──────────────────────────────────────────
  const makeKeyHandler = (
    rowId: string,
    field: "date" | "description" | "amount",
    rowIndex: number,
  ) => (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const meta = e.metaKey || e.ctrlKey;

    if (meta && e.key.toLowerCase() === "d") {
      e.preventDefault();
      const newId = duplicateRow(rowId);
      focus(newId, field);
      return;
    }

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

    if (e.key === "Enter" && field === "amount") {
      e.preventDefault();
      const newId = insertAfter(rowId, { sameDate: e.shiftKey });
      focus(newId, "amount");
    }
  };

  // ── Amount input parsing + per-row draft buffer ────────────────────────
  const parseAmount = (raw: string): number | null => {
    const cleaned = raw.replace(/[$,\s]/g, "");
    if (!cleaned || cleaned === "-" || cleaned === "+") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  };

  const [amountDrafts, setAmountDrafts] = useState<Record<string, string>>({});

  const onAmountChange = (rowId: string, raw: string) => {
    setAmountDrafts((d) => ({ ...d, [rowId]: raw }));
    const parsed = parseAmount(raw);
    if (parsed !== null) updateRow(rowId, { amount: parsed });
  };
  const onAmountBlur = (rowId: string) => {
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
                Synced to S3 so it follows you across devices.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <SyncStatusChip status={syncStatus} lastSavedAt={lastSavedAt} />
            </div>
          </div>

          {/* ── Cashflow tabs ────────────────────────────────────────── */}
          <div className="mb-4 flex items-center gap-1 overflow-x-auto pb-1">
            {cashflows.map((c) => {
              const isActive = c.id === active?.id;
              return (
                <button
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
                  className={[
                    "flex-shrink-0 px-3 py-1.5 rounded-t border-b-2 text-xs font-medium transition-colors",
                    isActive
                      ? ""
                      : "border-transparent text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5",
                  ].join(" ")}
                  style={isActive ? { borderColor: FINANCE_COLOR, color: FINANCE_COLOR } : undefined}
                >
                  {c.name}
                </button>
              );
            })}
            <button
              onClick={addCashflow}
              className="flex-shrink-0 px-3 py-1.5 text-xs font-semibold text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
              title="Add a new cashflow"
            >
              + Add
            </button>
          </div>

          {/* ── Active cashflow header (rename + actions) ─────────────── */}
          {active && (
            <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-1 min-w-[240px]">
                <input
                  type="text"
                  value={active.name}
                  onChange={(e) => renameActive(e.target.value)}
                  placeholder="Cashflow name"
                  className="bg-transparent border-b border-gray-200 dark:border-darkBorder text-base font-semibold text-gray-700 dark:text-gray-200 focus:outline-none focus:border-emerald-500 px-1 py-0.5 max-w-sm w-full"
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={resetActive}
                  className="text-[11px] text-gray-400 hover:text-amber-500 transition-colors"
                >
                  Clear rows
                </button>
                <button
                  onClick={() => deleteCashflow(active.id)}
                  disabled={cashflows.length <= 1}
                  className="text-[11px] text-gray-400 hover:text-red-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={cashflows.length <= 1 ? "Can't delete the last cashflow" : "Delete this cashflow"}
                >
                  Delete cashflow
                </button>
              </div>
            </div>
          )}

          {/* ── Summary ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <SummaryTile label="Final"      value={view.finalBalance} accent />
            <SummaryTile label="Low point"  value={view.lowPoint}  />
            <SummaryTile label="High point" value={view.highPoint} />
            <SummaryTile label="Rows"       rawValue={view.rows.length.toString()} />
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
            Tip: this is a scratchpad — no transactions or accounts are touched. Use it for
            "what if I move $X on date Y" thinking. State syncs to S3 with a localStorage
            fallback for offline edits.
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

function SyncStatusChip({
  status, lastSavedAt,
}: {
  status:      S3SyncStatus;
  lastSavedAt: Date | null;
}) {
  const config: Record<S3SyncStatus, { label: string; color: string; pulse?: boolean }> = {
    loading:      { label: "Loading…",     color: "#9ca3af", pulse: true },
    saving:       { label: "Saving…",      color: "#9ca3af", pulse: true },
    synced:       { label: "✓ Synced",     color: FINANCE_COLOR },
    "local-only": { label: "⚠ Local only", color: "#f59e0b" },
    error:        { label: "× Error",      color: "#ef4444" },
  };
  const c = config[status];
  const tooltip = lastSavedAt && status === "synced"
    ? `Last saved to S3 at ${lastSavedAt.toLocaleTimeString()}`
    : status === "local-only"
    ? "S3 unreachable — changes are only in this browser. Will retry on next edit."
    : undefined;
  return (
    <span
      className={["text-[10px] font-medium tabular-nums", c.pulse ? "animate-pulse" : ""].join(" ")}
      style={{ color: c.color }}
      title={tooltip}
    >
      {c.label}
    </span>
  );
}
