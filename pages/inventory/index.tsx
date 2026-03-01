import React, { useEffect, useState, useCallback } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import InventoryLayout from "@/layouts/inventory";
import NextLink from "next/link";
import {
  ItemRecord, FirearmRecord, AmmoRecord, FilamentRecord, InstrumentRecord,
  Category,
  CATEGORY_CONFIG,
  thCls, tdCls,
  fmtCurrency, fmtDate,
  CategoryBadge, EmptyState,
} from "@/components/inventory/_shared";

const client = generateClient<Schema>();

type SortKey = "name" | "category" | "datePurchased" | "pricePaid" | "brand";
type SortDir = "asc" | "desc";

export default function InventoryPage() {
  const { authState } = useRequireAuth();

  const [items,     setItems]     = useState<ItemRecord[]>([]);
  const [firearms,  setFirearms]  = useState<FirearmRecord[]>([]);
  const [ammos,     setAmmos]     = useState<AmmoRecord[]>([]);
  const [filaments, setFilaments] = useState<FilamentRecord[]>([]);
  const [instruments, setInstruments] = useState<InstrumentRecord[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState("");
  const [catFilter, setCatFilter] = useState<Category | "ALL">("ALL");
  const [sortKey,   setSortKey]   = useState<SortKey>("datePurchased");
  const [sortDir,   setSortDir]   = useState<SortDir>("desc");

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: itemData }, { data: fwData }, { data: amData }, { data: flData }, { data: instData }] =
        await Promise.all([
          client.models.inventoryItem.list({ limit: 500 }),
          client.models.inventoryFirearm.list({ limit: 500 }),
          client.models.inventoryAmmo.list({ limit: 500 }),
          client.models.inventoryFilament.list({ limit: 500 }),
          client.models.inventoryInstrument.list({ limit: 500 }),
        ]);
      setItems(itemData ?? []);
      setFirearms(fwData ?? []);
      setAmmos(amData ?? []);
      setFilaments(flData ?? []);
      setInstruments(instData ?? []);
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

  const firearmByCaliber = firearms.reduce((acc, fw) => {
    const k = fw.caliber ?? "Unknown";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const ammoByCaliberQty = ammos.reduce((acc, am) => {
    const k = am.caliber ?? "Unknown";
    const totalRounds = (am.quantity ?? 0) * (am.roundsPerUnit ?? 1);
    acc[k] = (acc[k] ?? 0) + totalRounds;
    return acc;
  }, {} as Record<string, number>);

  const filamentByMaterial = filaments.reduce((acc, fl) => {
    const k = fl.material ?? "OTHER";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const instrumentByType = instruments.reduce((acc, inst) => {
    const k = inst.type ?? "OTHER";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const breakdowns: Record<string, Record<string, number>> = {
    FIREARM:    firearmByCaliber,
    AMMO:       ammoByCaliberQty,
    FILAMENT:   filamentByMaterial,
    INSTRUMENT: instrumentByType,
  };

  function breakdownLabel(cat: string, key: string, val: number) {
    if (cat === "AMMO") return `${key} · ${val.toLocaleString()} rds`;
    return `${key} · ${val}`;
  }

  if (authState !== "authenticated") return null;

  return (
    <InventoryLayout>
      <div className="px-3 py-4 md:px-6 md:py-6 overflow-auto h-full">

        {/* ── Header ────────────────────────────────────────────────────── */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-purple dark:text-rose">Inventory</h1>
        </div>

        {/* ── Summary cards ─────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 mb-6">
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
              {breakdowns[cat] && Object.keys(breakdowns[cat]).length > 0 && (
                <div className="flex flex-col gap-0.5 mt-1 border-t pt-1.5" style={{ borderColor: cfg.color + "33" }}>
                  {Object.entries(breakdowns[cat])
                    .sort((a, b) => b[1] - a[1])
                    .map(([key, val]) => (
                      <span key={key} className="text-[11px] leading-tight" style={{ color: cfg.color + "cc" }}>
                        {breakdownLabel(cat, key, val)}
                      </span>
                    ))}
                </div>
              )}
            </NextLink>
          ))}
        </div>

        {/* ── Filters ───────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row flex-wrap gap-2 mb-4">
          <input
            type="text"
            placeholder="Search name, brand, vendor…"
            className="border rounded px-3 py-1.5 text-sm dark:bg-purple dark:text-rose dark:border-gray-600 bg-white text-gray-800 border-gray-300 w-full sm:w-64"
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
                    ["name",         "Name",       ""],
                    ["brand",        "Brand",      "hidden sm:table-cell"],
                    ["category",     "Category",   "hidden md:table-cell"],
                    ["datePurchased","Date",       "hidden md:table-cell"],
                    ["pricePaid",    "Total Paid", "hidden sm:table-cell"],
                  ] as [SortKey, string, string][]).map(([k, label, cls]) => (
                    <th key={k} className={`${thCls} ${cls}`}>
                      <button className="flex items-center hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                        onClick={() => toggleSort(k)}>
                        {label}<SortIcon k={k} />
                      </button>
                    </th>
                  ))}
                  <th className={`${thCls} hidden md:table-cell`}>Vendor</th>
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
                      <td className={`${tdCls} hidden sm:table-cell`}>{it.brand ?? "—"}</td>
                      <td className={`${tdCls} hidden md:table-cell`}><CategoryBadge category={it.category ?? "OTHER"} /></td>
                      <td className={`${tdCls} hidden md:table-cell`}>{fmtDate(it.datePurchased)}</td>
                      <td className={`${tdCls} hidden sm:table-cell`}>{fmtCurrency(it.pricePaid, it.currency ?? "USD")}</td>
                      <td className={`${tdCls} hidden md:table-cell`}>{it.vendor ?? "—"}</td>
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
