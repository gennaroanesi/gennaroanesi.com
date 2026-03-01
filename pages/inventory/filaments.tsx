import React, { useEffect, useState, useCallback, useRef } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import InventoryLayout from "@/layouts/inventory";
import { useRouter } from "next/router";
import {
  ItemRecord, FilamentRecord,
  FILAMENT_MATS, FILAMENT_DIAMS,
  inputCls, labelCls, thCls, tdCls,
  fmtCurrency, fmtDate,
  BaseItemFields, SaveButton, DeleteButton, EmptyState,
  ImageUploader, ImageUploaderHandle, useSuggestions,
} from "./_shared";

const client = generateClient<Schema>();

type PanelState =
  | { kind: "new" }
  | { kind: "edit"; item: ItemRecord; filament: FilamentRecord }
  | null;

// Swatch colors for common filament colors (best effort)
const COLOR_SWATCHES: Record<string, string> = {
  black: "#1a1a1a", white: "#f5f5f5", red: "#d32f2f", blue: "#1565c0",
  green: "#2e7d32", yellow: "#f9a825", orange: "#e65100", purple: "#6a1b9a",
  pink: "#c2185b", gray: "#616161", grey: "#616161", silver: "#9e9e9e",
  brown: "#4e342e", transparent: "#e0f7fa", natural: "#f5deb3",
};

function colorSwatch(color: string | null | undefined) {
  if (!color) return null;
  const key = color.toLowerCase().trim();
  const hex = COLOR_SWATCHES[key];
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block w-3 h-3 rounded-full border border-gray-300 dark:border-gray-600 flex-shrink-0"
        style={{ backgroundColor: hex ?? "#bcabae" }}
      />
      {color}
    </span>
  );
}

export default function FilamentsPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [items,          setItems]          = useState<ItemRecord[]>([]);
  const [details,        setDetails]        = useState<Map<string, FilamentRecord>>(new Map());
  const [loading,        setLoading]        = useState(true);
  const [saving,         setSaving]         = useState(false);
  const [panel,          setPanel]          = useState<PanelState>(null);
  const [itemDraft,      setItemDraft]      = useState<Partial<ItemRecord>>({});
  const [filamentDraft,  setFilamentDraft]  = useState<Partial<FilamentRecord>>({});
  const imgRef = useRef<ImageUploaderHandle>(null);
  const suggestions = useSuggestions(items);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: itemData }, { data: detailData }] = await Promise.all([
        client.models.inventoryItem.list({ filter: { category: { eq: "FILAMENT" } }, limit: 500 }),
        client.models.inventoryFilament.list({ limit: 500 }),
      ]);
      setItems(itemData ?? []);
      const map = new Map<string, FilamentRecord>();
      (detailData ?? []).forEach((d) => map.set(d.itemId, d));
      setDetails(map);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchData();
  }, [authState, fetchData]);

  // Open new panel if ?new=1 param present
  useEffect(() => {
    if (!router.isReady || router.query.new !== "1") return;
    openNew();
    router.replace("/inventory/filaments", undefined, { shallow: true });
  }, [router.isReady, router.query.new]);

  useEffect(() => {
    if (!router.isReady || !router.query.id || items.length === 0) return;
    const item = items.find((i) => i.id === router.query.id);
    const filament = item ? details.get(item.id) : undefined;
    if (item && filament) openEdit(item, filament);
  }, [router.isReady, router.query.id, items, details]);

  function openNew() {
    setItemDraft({ category: "FILAMENT", currency: "USD" });
    setFilamentDraft({ material: "PLA", diameter: "1.75", weightG: 1000 });
    setPanel({ kind: "new" });
  }

  function openEdit(item: ItemRecord, filament: FilamentRecord) {
    setItemDraft({ ...item });
    setFilamentDraft({ ...filament });
    setPanel({ kind: "edit", item, filament });
  }

  async function handleSave() {
    if (!itemDraft.name?.trim()) return;
    setSaving(true);
    try {
      if (panel?.kind === "new") {
        const { data: newItem, errors } = await client.models.inventoryItem.create({
          name:          itemDraft.name!,
          brand:         itemDraft.brand        ?? null,
          description:   itemDraft.description  ?? null,
          category:      "FILAMENT",
          datePurchased: itemDraft.datePurchased ?? null,
          vendor:        itemDraft.vendor        ?? null,
          url:           itemDraft.url           ?? null,
          pricePaid:     itemDraft.pricePaid     ?? null,
          currency:      itemDraft.currency      ?? "USD",
          notes:         itemDraft.notes         ?? null,
        });
        if (errors || !newItem) return;
        const { data: newFilament } = await client.models.inventoryFilament.create({
          itemId:   newItem.id,
          material: (filamentDraft.material ?? "PLA") as any,
          color:    filamentDraft.color    ?? null,
          weightG:  filamentDraft.weightG  ?? null,
          diameter: (filamentDraft.diameter ?? "1.75") as any,
        });
        const imageKeys = await imgRef.current?.commit(newItem.id) ?? [];
        if (imageKeys.length > 0) {
          await client.models.inventoryItem.update({ id: newItem.id, imageKeys });
        }
        if (newFilament) {
          setItems((prev) => [{ ...newItem, imageKeys }, ...prev]);
          setDetails((prev) => new Map(prev).set(newItem.id, newFilament));
        }
      } else if (panel?.kind === "edit") {
        await client.models.inventoryItem.update({
          id:            panel.item.id,
          name:          itemDraft.name!,
          brand:         itemDraft.brand        ?? null,
          description:   itemDraft.description  ?? null,
          datePurchased: itemDraft.datePurchased ?? null,
          vendor:        itemDraft.vendor        ?? null,
          url:           itemDraft.url           ?? null,
          pricePaid:     itemDraft.pricePaid     ?? null,
          currency:      itemDraft.currency      ?? "USD",
          notes:         itemDraft.notes         ?? null,
        });
        await client.models.inventoryFilament.update({
          id:       panel.filament.id,
          material: (filamentDraft.material ?? "PLA") as any,
          color:    filamentDraft.color    ?? null,
          weightG:  filamentDraft.weightG  ?? null,
          diameter: (filamentDraft.diameter ?? "1.75") as any,
        });
        const imageKeys = await imgRef.current?.commit(panel.item.id) ?? (itemDraft.imageKeys ?? []);
        await client.models.inventoryItem.update({ id: panel.item.id, imageKeys });
        const updatedItem     = { ...panel.item,     ...itemDraft, imageKeys }     as ItemRecord;
        const updatedFilament = { ...panel.filament, ...filamentDraft } as FilamentRecord;
        setItems((prev)   => prev.map((i) => i.id === updatedItem.id ? updatedItem : i));
        setDetails((prev) => new Map(prev).set(updatedItem.id, updatedFilament));
      }
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (panel?.kind !== "edit") return;
    if (!confirm("Delete this filament record?")) return;
    setSaving(true);
    try {
      await client.models.inventoryFilament.delete({ id: panel.filament.id });
      await client.models.inventoryItem.delete({ id: panel.item.id });
      setItems((prev)   => prev.filter((i) => i.id !== panel.item.id));
      setDetails((prev) => { const m = new Map(prev); m.delete(panel.item.id); return m; });
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  // ── Totals by material ────────────────────────────────────────────────────
  const materialTotals = Array.from(details.values()).reduce((acc, f) => {
    const key = f.material ?? "OTHER";
    acc[key] = (acc[key] ?? 0) + (f.weightG ?? 0);
    return acc;
  }, {} as Record<string, number>);

  if (authState !== "authenticated") return null;

  return (
    <InventoryLayout>
      <div className="flex h-full">

        {/* ── Main ────────────────────────────────────────────────────── */}
        <div className="flex-1 px-6 py-6 overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-purple dark:text-rose">Filaments</h1>
            <button onClick={openNew}
              className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity">
              + Add Filament
            </button>
          </div>

          {/* Material summary pills */}
          {Object.keys(materialTotals).length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {Object.entries(materialTotals).map(([mat, grams]) => (
                <span key={mat}
                  className="px-3 py-1 rounded-full text-xs font-semibold"
                  style={{ backgroundColor: "#8B5CF622", color: "#8B5CF6", border: "1px solid #8B5CF655" }}>
                  {mat} — {(grams / 1000).toFixed(2)} kg
                </span>
              ))}
            </div>
          )}

          {loading ? (
            <div className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</div>
          ) : items.length === 0 ? (
            <EmptyState label="Filament" onAdd={openNew} />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
              <table className="w-full">
                <thead className="bg-gray-50 dark:bg-darkPurple border-b border-gray-200 dark:border-gray-700">
                  <tr>
                    {["Name", "Brand", "Material", "Color", "Weight", "Diameter", "Price", "Date"].map((h) => (
                      <th key={h} className={thCls}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {items.map((it) => {
                    const fl = details.get(it.id);
                    return (
                      <tr key={it.id}
                        className="hover:bg-gray-50 dark:hover:bg-purple/30 transition-colors cursor-pointer"
                        onClick={() => fl && openEdit(it, fl)}>
                        <td className={`${tdCls} font-medium`}>{it.name}</td>
                        <td className={tdCls}>{it.brand ?? "—"}</td>
                        <td className={tdCls}>
                          <span className="font-mono text-xs px-1.5 py-0.5 rounded"
                            style={{ backgroundColor: "#8B5CF622", color: "#8B5CF6" }}>
                            {fl?.material ?? "—"}
                          </span>
                        </td>
                        <td className={tdCls}>{colorSwatch(fl?.color) ?? "—"}</td>
                        <td className={tdCls}>{fl?.weightG ? `${fl.weightG} g` : "—"}</td>
                        <td className={tdCls}>{fl?.diameter ? `${fl.diameter} mm` : "—"}</td>
                        <td className={tdCls}>{fmtCurrency(it.pricePaid, it.currency ?? "USD")}</td>
                        <td className={tdCls}>{fmtDate(it.datePurchased)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Side panel ──────────────────────────────────────────────── */}
        {panel && (
          <div className="w-96 border-l border-gray-200 dark:border-gray-700 flex flex-col bg-white dark:bg-darkPurple overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b dark:border-gray-700 flex-shrink-0">
              <h2 className="text-base font-semibold dark:text-rose text-purple truncate">
                {panel.kind === "new" ? "New Filament" : itemDraft.name}
              </h2>
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <BaseItemFields item={itemDraft} onChange={(p) => setItemDraft((d) => ({ ...d, ...p }))} suggestions={suggestions} />

              <hr className="border-gray-200 dark:border-gray-700" />
              <p className={labelCls}>Filament Details</p>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Material</label>
                  <select className={inputCls}
                    value={filamentDraft.material ?? "PLA"}
                    onChange={(e) => setFilamentDraft((d) => ({ ...d, material: e.target.value as any }))}>
                    {FILAMENT_MATS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Diameter</label>
                  <select className={inputCls}
                    value={filamentDraft.diameter ?? "1.75"}
                    onChange={(e) => setFilamentDraft((d) => ({ ...d, diameter: e.target.value as any }))}>
                    {FILAMENT_DIAMS.map((d) => <option key={d} value={d}>{d} mm</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Color</label>
                  <input type="text" className={inputCls} placeholder="Black"
                    value={filamentDraft.color ?? ""}
                    onChange={(e) => setFilamentDraft((d) => ({ ...d, color: e.target.value }))} />
                </div>
                <div>
                  <label className={labelCls}>Weight (g)</label>
                  <input type="number" min={0} className={inputCls} placeholder="1000"
                    value={filamentDraft.weightG ?? ""}
                    onChange={(e) => setFilamentDraft((d) => ({ ...d, weightG: parseInt(e.target.value) || null }))} />
                </div>
              </div>

              <hr className="border-gray-200 dark:border-gray-700" />
              <ImageUploader
                ref={imgRef}
                itemId={panel.kind === "edit" ? panel.item.id : undefined}
                existingKeys={(panel.kind === "edit" ? panel.item.imageKeys : []) ?? []}
              />

              <SaveButton saving={saving} onSave={handleSave}
                label={panel.kind === "new" ? "Create Filament" : "Save"} />
              {panel.kind === "edit" && <DeleteButton saving={saving} onDelete={handleDelete} />}
            </div>
          </div>
        )}
      </div>
    </InventoryLayout>
  );
}
