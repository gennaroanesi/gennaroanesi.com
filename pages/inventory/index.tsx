import React, { useEffect, useState, useCallback } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import InventoryLayout from "@/layouts/inventory";
import NextLink from "next/link";
import {
  ItemRecord, Category,
  CATEGORY_CONFIG,
  thCls, tdCls,
  fmtCurrency, fmtDate,
  CategoryBadge, EmptyState,
} from "./_shared";

const client = generateClient<Schema>();

type SortKey = "name" | "category" | "datePurchased" | "pricePaid" | "brand";
type SortDir = "asc" | "desc";

export default function InventoryPage() {
  const { authState } = useRequireAuth();

  const [items,     setItems]     = useState<ItemRecord[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState("");
  const [catFilter, setCatFilter] = useState<Category | "ALL">("ALL");
  const [sortKey,   setSortKey]   = useState<SortKey>("datePurchased");
  const [sortDir,   setSortDir]   = useState<SortDir>("desc");

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.models.inventoryItem.list({ limit: 500 });
      setItems(data ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchItems();
  }, [authState, fetchItems]);

  // ── Filter + sort ─────────────────────────────────────────────────────────
  const filtered = items
    .filter((it) => catFilter === "ALL" || it.category === catFilter)
    .filter((it) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        it.name?.toLowerCase().includes(q) ||
        it.brand?.toLowerCase().includes(q) ||
        it.vendor?.toLowerCase().includes(q) ||
        it.description?.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      let av: any = a[sortKey] ?? "";
      let bv: any = b[sortKey] ?? "";
      if (sortKey === "pricePaid") { av = av ?? 0; bv = bv ?? 0; }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <span className="ml-1 opacity-20">↕</span>;
    return <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  const totalSpend = items.reduce((acc, it) => acc + (it.pricePaid ?? 0), 0);
  const countByCat = Object.keys(CATEGORY_CONFIG).reduce((acc, k) => {
    acc[k] = items.filter((it) => it.category === k).length;
    return acc;
  }, {} as Record<string, number>);

  if (authState !== "authenticated") return null;

  return (
    <InventoryLayout>
      <div className="px-6 py-6 overflow-auto h-full">

        {/* ── Header ────────────────────────────────────────────────────── */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-purple dark:text-rose">Inventory</h1>
        </div>

        {/* ── Summary cards ─────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          {(Object.entries(CATEGORY_CONFIG) as [Category, typeof CATEGORY_CONFIG[Category]][]).map(([cat, cfg]) => (
            <NextLink
              key={cat}
              href={cfg.href}
              className="rounded-lg border p-3 flex flex-col gap-1 hover:opacity-80 transition-opacity cursor-pointer"
              style={{ borderColor: cfg.color + "55", backgroundColor: cfg.color + "11" }}
            >
              <span className="text-xs uppercase tracking-widest font-medium" style={{ color: cfg.color }}>
                {cfg.label}
              </span>
              <span className="text-2xl font-bold text-gray-700 dark:text-gray-200">
                {countByCat[cat] ?? 0}
              </span>
            </NextLink>
          ))}
        </div>

        {/* ── Filters ───────────────────────────────────────────────────── */}
        <div className="flex flex-wrap gap-3 mb-4">
          <input
            type="text"
            placeholder="Search name, brand, vendor…"
            className="border rounded px-3 py-1.5 text-sm dark:bg-purple dark:text-rose dark:border-gray-600 bg-white text-gray-800 border-gray-300 w-64"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="border rounded px-3 py-1.5 text-sm dark:bg-purple dark:text-rose dark:border-gray-600 bg-white text-gray-700 border-gray-300"
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value as Category | "ALL")}
          >
            <option value="ALL">All categories</option>
            {(Object.entries(CATEGORY_CONFIG) as [Category, any][]).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <span className="text-sm text-gray-400 self-center">
            {filtered.length} item{filtered.length !== 1 ? "s" : ""}
            {" · "}
            {fmtCurrency(totalSpend)} total
          </span>
        </div>

        {/* ── Table ─────────────────────────────────────────────────────── */}
        {loading ? (
          <div className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</div>
        ) : filtered.length === 0 ? (
          <EmptyState label="items" onAdd={() => {}} showCategoryLinks />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-darkPurple border-b border-gray-200 dark:border-gray-700">
                <tr>
                  {([
                    ["name",         "Name"],
                    ["brand",        "Brand"],
                    ["category",     "Category"],
                    ["datePurchased","Date"],
                    ["pricePaid",    "Price"],
                  ] as [SortKey, string][]).map(([k, label]) => (
                    <th key={k} className={thCls}>
                      <button className="flex items-center hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                        onClick={() => toggleSort(k)}>
                        {label}<SortIcon k={k} />
                      </button>
                    </th>
                  ))}
                  <th className={thCls}>Vendor</th>
                  <th className={thCls}>Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {filtered.map((it) => {
                  const cfg = CATEGORY_CONFIG[it.category as Category] ?? CATEGORY_CONFIG.OTHER;
                  return (
                    <tr key={it.id}
                      className="hover:bg-gray-50 dark:hover:bg-purple/30 transition-colors">
                      <td className={`${tdCls} font-medium`}>{it.name}</td>
                      <td className={tdCls}>{it.brand ?? "—"}</td>
                      <td className={tdCls}><CategoryBadge category={it.category ?? "OTHER"} /></td>
                      <td className={tdCls}>{fmtDate(it.datePurchased)}</td>
                      <td className={tdCls}>{fmtCurrency(it.pricePaid, it.currency ?? "USD")}</td>
                      <td className={tdCls}>{it.vendor ?? "—"}</td>
                      <td className={tdCls}>
                        <NextLink
                          href={`${cfg.href}?id=${it.id}`}
                          className="text-xs font-medium underline"
                          style={{ color: cfg.color }}
                        >
                          View →
                        </NextLink>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </InventoryLayout>
  );
}
