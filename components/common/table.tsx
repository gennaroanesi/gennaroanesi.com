/**
 * components/common/table.tsx
 *
 * Shared table primitives used by the inventory and finance sections.
 * Anything section-agnostic lives here: column defs, sort+pagination state
 * hook, a typeahead filter, a free-text search input, and a generic
 * <DataTable> that renders rows given a column config.
 *
 * The inventory-specific <InventoryTable> (with thumbnails, view/edit/delete
 * icon-columns pointing to `/inventory/item/...`) still lives in
 * components/inventory/_shared.tsx and re-exports the generic bits from here.
 */

import React, { useState, useEffect, useMemo, useRef } from "react";

// ── Shared styles ─────────────────────────────────────────────────────────────

export const thCls =
  "text-left text-xs uppercase tracking-widest text-gray-500 dark:text-gray-400 px-3 py-2 font-medium whitespace-nowrap";
export const tdCls =
  "px-3 py-2 text-sm text-gray-700 dark:text-gray-200 whitespace-nowrap";

// ── SortIcon ──────────────────────────────────────────────────────────────────

export function SortIcon({ dir }: { dir: "asc" | "desc" | null }) {
  if (dir === "asc") {
    return (
      <svg className="w-3 h-3 inline-block ml-1 text-purple dark:text-rose" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
      </svg>
    );
  }
  if (dir === "desc") {
    return (
      <svg className="w-3 h-3 inline-block ml-1 text-purple dark:text-rose" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    );
  }
  return (
    <svg className="w-3 h-3 inline-block ml-1 opacity-25" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4M16 15l-4 4-4-4" />
    </svg>
  );
}

// ── ColDef ────────────────────────────────────────────────────────────────────

export type ColDef<T> = {
  key: string;
  label: string;
  render: (row: T) => React.ReactNode;
  /** Return a primitive for sorting. If omitted, column is not sortable. */
  sortValue?: (row: T) => string | number | null | undefined;
  /**
   * Return values used by the free-text search. Defaults to stringifying
   * sortValue if not provided. Return "" to exclude from search.
   */
  searchValue?: (row: T) => string;
  className?: string;
  mobileHidden?: boolean;
  /** Override cell alignment (default left, via tdCls). */
  align?: "left" | "right" | "center";
};

// ── useTableControls ──────────────────────────────────────────────────────────
// Sort + pagination + search state, with a default sort for when the user
// hasn't clicked a header yet.

export type SortDir = "asc" | "desc";

export type UseTableControlsOptions<T> = {
  /** Column key to sort by initially. */
  defaultSortKey?: string;
  /** Initial sort direction. Default "asc". */
  defaultSortDir?: SortDir;
  /** How to extract the sort value for a given key. Usually the ColDef.sortValue lookup. */
  getSortValue: (row: T, key: string) => string | number | null | undefined;
  /** How to extract search-text for a row. Default: join of all ColDef render results stringified. */
  getSearchText?: (row: T) => string;
  /** Initial page size. Default 100. */
  initialPageSize?: number;
};

export function useTableControls<T>(
  items: T[],
  options: UseTableControlsOptions<T>,
) {
  const {
    defaultSortKey, defaultSortDir = "asc",
    getSortValue, getSearchText,
    initialPageSize = 100,
  } = options;

  const [sortKey, setSortKey] = useState<string | null>(defaultSortKey ?? null);
  const [sortDir, setSortDir] = useState<SortDir>(defaultSortDir);
  const [search,  setSearch]  = useState("");
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Sensible defaults: strings asc, numbers desc (so most-recent/biggest-first by default)
      setSortDir("asc");
    }
    setPage(1);
  }

  // Filter by free-text search (case-insensitive, matches any searched column)
  const filtered = useMemo(() => {
    if (!search.trim() || !getSearchText) return items;
    const needle = search.trim().toLowerCase();
    return items.filter((row) => getSearchText(row).toLowerCase().includes(needle));
  }, [items, search, getSearchText]);

  // Sort
  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    return [...filtered].sort((a, b) => {
      const av = getSortValue(a, sortKey);
      const bv = getSortValue(b, sortKey);
      // null/undefined sort to the end regardless of direction
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir, getSortValue]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage   = Math.min(page, totalPages);
  const start      = (safePage - 1) * pageSize;
  const paged      = sorted.slice(start, start + pageSize);

  // Reset to page 1 when the underlying data set changes size or the user searches
  useEffect(() => { setPage(1); }, [items.length, search]);

  return {
    // Data
    filtered,
    sorted,
    paged,
    // Sort
    sortKey,
    sortDir,
    handleSort,
    setSortKey, setSortDir,
    // Search
    search,
    setSearch,
    // Pagination
    page: safePage,
    setPage,
    pageSize,
    setPageSize,
    totalPages,
    totalItems: filtered.length,
    totalUnfiltered: items.length,
  };
}

// ── TableControls (pagination + info bar) ─────────────────────────────────────

const PAGE_SIZES = [25, 50, 100, 250, 500];

export function TableControls({
  page, totalPages, totalItems, pageSize,
  setPage, setPageSize,
  totalUnfiltered,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  setPage: (p: number) => void;
  setPageSize: (n: number) => void;
  /** If provided and different from totalItems, renders "X of Y" to hint at filtering. */
  totalUnfiltered?: number;
}) {
  const start = Math.min((page - 1) * pageSize + 1, totalItems);
  const end   = Math.min(page * pageSize, totalItems);
  const filtered = totalUnfiltered != null && totalUnfiltered !== totalItems;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 border-t border-gray-200 dark:border-darkBorder text-xs text-gray-500 dark:text-gray-400">
      <span className="whitespace-nowrap">
        {totalItems === 0
          ? "No items"
          : filtered
            ? `${start}–${end} of ${totalItems} (filtered from ${totalUnfiltered})`
            : `${start}–${end} of ${totalItems}`}
      </span>

      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <button onClick={() => setPage(1)}            disabled={page === 1}          className="px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-30 transition-colors" title="First page">«</button>
          <button onClick={() => setPage(page - 1)}     disabled={page === 1}          className="px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-30 transition-colors">‹</button>

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

          <button onClick={() => setPage(page + 1)}     disabled={page === totalPages} className="px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-30 transition-colors">›</button>
          <button onClick={() => setPage(totalPages)}   disabled={page === totalPages} className="px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-30 transition-colors" title="Last page">»</button>
        </div>
      )}

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

// ── SearchInput ───────────────────────────────────────────────────────────────
// Free-text search input with an × to clear. Pair with useTableControls.search.

export function SearchInput({
  value, onChange, placeholder = "Search…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative inline-flex items-center">
      <svg className="absolute left-2 w-3.5 h-3.5 text-gray-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M10 18a8 8 0 100-16 8 8 0 000 16z" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="border rounded pl-7 pr-7 py-1 text-xs bg-white border-gray-300 dark:bg-darkElevated dark:border-darkBorder dark:text-gray-200 w-52 focus:outline-none focus:ring-1 focus:ring-emerald-400/50"
      />
      {value && (
        <button
          onClick={() => onChange("")}
          className="absolute right-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm leading-none"
          aria-label="Clear search"
        >
          ×
        </button>
      )}
    </div>
  );
}

// ── FilterTypeahead ───────────────────────────────────────────────────────────
// Dropdown-style filter with typeahead. Keeps the pattern used by inventory.
// Selected value is a string or "" for "all".

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
    if (e.key === "ArrowDown")                 { setHiIdx((i) => Math.min(i + 1, filtered.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp")              { setHiIdx((i) => Math.max(i - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter")                { if (filtered[hiIdx]) select(filtered[hiIdx]); e.preventDefault(); }
    else if (e.key === "Escape")               { setOpen(false); if (!value) setQuery(""); }
    else if (e.key === "Backspace" && !query) { onChange(""); }
  }

  return (
    <div className="relative">
      <div
        className={[
          "flex items-center gap-1 border rounded px-2 py-1 text-xs bg-white dark:bg-darkElevated border-gray-300 dark:border-darkBorder cursor-text",
          value ? "border-purple/60 dark:border-rose/60" : "",
        ].join(" ")}
        onClick={() => { setOpen(true); inputRef.current?.focus(); }}
      >
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

// ── DataTable ─────────────────────────────────────────────────────────────────
// Generic sortable table. Unlike InventoryTable, no hardcoded thumbnails or
// view/edit/delete column — bring your own row click handler and actions.
// Sections that want thumbnails + standardized actions (inventory) should
// keep using InventoryTable. Finance and other sections use this.

export function DataTable<T extends { id: string }>({
  rows,
  columns,
  isLoading,
  sortKey,
  sortDir,
  onSort,
  onRowClick,
  emptyMessage = "No results",
  rowClassName,
}: {
  rows: T[];
  columns: ColDef<T>[];
  isLoading?: boolean;
  sortKey?: string | null;
  sortDir?: SortDir;
  onSort?: (key: string) => void;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  /** Optional per-row className override (for selected state, etc.) */
  rowClassName?: (row: T, index: number) => string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full">
        <thead className="bg-gray-50 dark:bg-darkElevated border-b border-gray-200 dark:border-darkBorder">
          <tr>
            {columns.map((col) => {
              const isSortable = !!col.sortValue && !!onSort;
              const dir = sortKey === col.key ? (sortDir ?? null) : null;
              const alignCls = col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left";
              return (
                <th
                  key={col.key}
                  className={[
                    thCls,
                    alignCls,
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
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <tr>
              <td colSpan={columns.length} className="text-center py-8 text-sm text-gray-400">Loading…</td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="text-center py-8 text-sm text-gray-400">{emptyMessage}</td>
            </tr>
          ) : (
            rows.map((row, idx) => (
              <tr
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={[
                  "border-b border-gray-100 dark:border-darkBorder transition-colors",
                  idx % 2 === 1 ? "bg-gray-50/50 dark:bg-white/[0.02]" : "",
                  onRowClick ? "hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer" : "",
                  rowClassName ? rowClassName(row, idx) : "",
                ].filter(Boolean).join(" ")}
              >
                {columns.map((col) => {
                  const alignCls = col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "";
                  return (
                    <td
                      key={col.key}
                      className={[
                        tdCls,
                        alignCls,
                        col.mobileHidden ? "hidden md:table-cell" : "",
                        col.className ?? "",
                      ].filter(Boolean).join(" ")}
                    >
                      {col.render(row)}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
