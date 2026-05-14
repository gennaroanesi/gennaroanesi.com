import React, { useEffect, useState, useCallback } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import InventoryLayout from "@/layouts/inventory";
import NextLink from "next/link";
import {
  ItemRecord, Category, CATEGORY_CONFIG,
  thCls, tdCls,
  fmtCurrency,
  CategoryBadge,
} from "@/components/inventory/_shared";

const client = generateClient<Schema>();

type SortKey = "name" | "category" | "pricePaid" | "brand" | "vendor";
type SortDir = "asc" | "desc";

export default function WishlistPage() {
  const { authState } = useRequireAuth();

  const [items,    setItems]    = useState<ItemRecord[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [search,   setSearch]   = useState("");
  const [catFilter,setCatFilter]= useState<Category | "ALL">("ALL");
  const [sortKey,  setSortKey]  = useState<SortKey>("name");
  const [sortDir,  setSortDir]  = useState<SortDir>("asc");
  const [showPicker, setShowPicker] = useState(false);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.models.inventoryItem.list({
        filter: { status: { eq: "WISHLIST" } },
        limit: 500,
      });
      setItems(data ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchItems();
  }, [authState, fetchItems]);

  const filtered = items
    .filter((it) => catFilter === "ALL" || it.category === catFilter)
    .filter((it) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        it.name?.toLowerCase().includes(q) ||
        it.brand?.toLowerCase().includes(q) ||
        it.vendor?.toLowerCase().includes(q) ||
        it.description?.toLowerCase().includes(q) ||
        it.notes?.toLowerCase().includes(q)
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

  const estTotal = filtered.reduce((acc, it) => acc + (it.pricePaid ?? 0), 0);

  if (authState !== "authenticated") return null;

  return (
    <InventoryLayout>
      <div className="px-3 py-4 md:px-6 md:py-6 overflow-auto h-full">

        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold text-purple dark:text-rose">Wishlist</h1>
          <button
            onClick={() => setShowPicker(true)}
            className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity"
          >
            + Add to wishlist
          </button>
        </div>

        <div className="flex flex-col sm:flex-row flex-wrap gap-2 mb-4">
          <input
            type="text"
            placeholder="Search name, brand, vendor, notes…"
            className="border rounded px-3 py-1.5 text-sm bg-white text-gray-800 border-gray-300 dark:bg-darkElevated dark:text-gray-100 dark:border-darkBorder w-full sm:w-64"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="border rounded px-3 py-1.5 text-sm bg-white text-gray-700 border-gray-300 dark:bg-darkElevated dark:text-gray-100 dark:border-darkBorder"
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
            {" · est. "}
            {fmtCurrency(estTotal)} total
          </span>
        </div>

        {loading ? (
          <div className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 dark:border-darkBorder py-16 text-center">
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Your wishlist is empty.
            </p>
            <button
              onClick={() => setShowPicker(true)}
              className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity"
            >
              + Add to wishlist
            </button>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 dark:bg-darkElevated border-b border-gray-200 dark:border-darkBorder">
                  <tr>
                    {([
                      ["name",      "Name",       ""],
                      ["brand",     "Brand",      "hidden sm:table-cell"],
                      ["category",  "Category",   "hidden md:table-cell"],
                      ["pricePaid", "Est. Price", "hidden sm:table-cell"],
                      ["vendor",    "Vendor",     "hidden md:table-cell"],
                    ] as [SortKey, string, string][]).map(([k, label, cls]) => (
                      <th key={k} className={`${thCls} ${cls}`}>
                        <button className="flex items-center hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                          onClick={() => toggleSort(k)}>
                          {label}<SortIcon k={k} />
                        </button>
                      </th>
                    ))}
                    <th className={`${thCls} hidden lg:table-cell`}>Link</th>
                    <th className={thCls}>Edit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {filtered.map((it) => {
                    const cfg = CATEGORY_CONFIG[it.category as Category] ?? CATEGORY_CONFIG.OTHER;
                    return (
                      <tr key={it.id} className="hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
                        <td className={`${tdCls} font-medium`}>{it.name}</td>
                        <td className={`${tdCls} hidden sm:table-cell`}>{it.brand ?? "—"}</td>
                        <td className={`${tdCls} hidden md:table-cell`}><CategoryBadge category={it.category ?? "OTHER"} /></td>
                        <td className={`${tdCls} hidden sm:table-cell`}>{fmtCurrency(it.pricePaid, it.currency ?? "USD")}</td>
                        <td className={`${tdCls} hidden md:table-cell`}>{it.vendor ?? "—"}</td>
                        <td className={`${tdCls} hidden lg:table-cell`}>
                          {it.url ? (
                            <a href={it.url} target="_blank" rel="noopener noreferrer"
                              className="text-xs underline text-purple dark:text-rose">
                              Open ↗
                            </a>
                          ) : "—"}
                        </td>
                        <td className={tdCls}>
                          <NextLink
                            href={`${cfg.href}?id=${it.id}`}
                            className="text-xs font-medium underline"
                            style={{ color: cfg.color }}
                          >
                            Edit →
                          </NextLink>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {showPicker && (
          <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={() => setShowPicker(false)}>
            <div className="bg-white dark:bg-darkSurface rounded-lg max-w-sm w-full p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <h2 className="text-base font-semibold text-purple dark:text-rose mb-1">Pick a category</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">Which kind of item do you want to wishlist?</p>
              <div className="grid grid-cols-2 gap-2">
                {(Object.entries(CATEGORY_CONFIG) as [Category, any][]).map(([cat, cfg]) => (
                  <NextLink
                    key={cat}
                    href={`${cfg.href}?new=1&wishlist=1`}
                    className="rounded-lg border p-3 text-sm font-medium hover:opacity-80 transition-opacity"
                    style={{ borderColor: cfg.color + "66", color: cfg.color }}
                  >
                    {cfg.label}
                  </NextLink>
                ))}
              </div>
            </div>
          </div>
        )}

      </div>
    </InventoryLayout>
  );
}
