import React, { useEffect, useState, useCallback, useRef } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import InventoryLayout from "@/layouts/inventory";
import { useRouter } from "next/router";
import {
  ItemRecord, FilamentRecord,
  FILAMENT_MATS, FILAMENT_MAT_LABELS, FILAMENT_VARIANTS, FILAMENT_DIAMS, FILAMENT_DIAM_LABELS,
  inputCls, labelCls,
  fmtCurrency, fmtDate,
  BaseItemFields, SaveButton, DeleteButton, EmptyState,
  ImageUploader, ImageUploaderHandle, useSuggestions,
  InventoryTable, ColDef, useThumbnails,
  useTableControls, TableControls,
  FilamentColorDots, ColorDot, resolveFilamentColor,
} from "@/components/inventory/_shared";

const client = generateClient<Schema>();

type PanelState =
  | { kind: "new" }
  | { kind: "edit"; item: ItemRecord; filament: FilamentRecord }
  | null;

function colorSwatch(color: string | null | undefined) {
  if (!color) return null;
  return (
    <span className="flex items-center gap-1.5">
      <ColorDot color={color} size={12} />
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
  const thumbnails  = useThumbnails(items);

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
    setFilamentDraft({ material: "PLA", diameter: "d175", weightG: 1000, quantity: 1 });
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
          variant:  filamentDraft.variant  ?? null,
          color:    filamentDraft.color    ?? null,
          weightG:  filamentDraft.weightG  ?? null,
          diameter: (filamentDraft.diameter ?? "d175") as any,
          quantity: filamentDraft.quantity ?? 1,
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
          variant:  filamentDraft.variant  ?? null,
          color:    filamentDraft.color    ?? null,
          weightG:  filamentDraft.weightG  ?? null,
          diameter: (filamentDraft.diameter ?? "d175") as any,
          quantity: filamentDraft.quantity ?? 1,
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

  const columns: ColDef<ItemRecord>[] = [
    { key: "name",     label: "Name",     render: (r) => <span className="font-medium">{r.name}</span>,                                                 sortValue: (r) => r.name ?? "" },
    { key: "material", label: "Material", render: (r) => {
      const d = details.get(r.id);
      const mat = d?.material;
      const variant = d?.variant;
      return mat ? (
        <span className="flex items-center gap-1">
          <span className="font-mono text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: "#8B5CF622", color: "#8B5CF6" }}>
            {FILAMENT_MAT_LABELS[mat] ?? mat}
          </span>
          {variant && <span className="text-xs text-gray-400">{variant}</span>}
        </span>
      ) : <span>—</span>;
    }, sortValue: (r) => details.get(r.id)?.material ?? "" },
    { key: "color",    label: "Color",    render: (r) => colorSwatch(details.get(r.id)?.color) ?? <span>—</span>,                                     sortValue: (r) => details.get(r.id)?.color ?? "" },
    { key: "weight",   label: "Weight",   render: (r) => { const w = details.get(r.id)?.weightG; return w ? `${w} g` : "—"; }, mobileHidden: true, sortValue: (r) => details.get(r.id)?.weightG ?? 0 },
    { key: "diam",     label: "Diameter", render: (r) => { const d = details.get(r.id)?.diameter; return d ? FILAMENT_DIAM_LABELS[d] ?? d : "—"; }, mobileHidden: true, sortValue: (r) => details.get(r.id)?.diameter ?? "" },
    { key: "brand",    label: "Brand",    render: (r) => r.brand ?? "—",                                               mobileHidden: true, sortValue: (r) => r.brand ?? "" },
    { key: "price",    label: "Price",    render: (r) => fmtCurrency(r.pricePaid, r.currency ?? "USD"),          mobileHidden: true, sortValue: (r) => r.pricePaid ?? 0 },
    { key: "date",     label: "Date",     render: (r) => fmtDate(r.datePurchased),                                mobileHidden: true, sortValue: (r) => r.datePurchased ?? "" },
  ];

  const tableControls = useTableControls(items, (item, key) => {
    const col = columns.find((c) => c.key === key);
    return col?.sortValue?.(item);
  });

  // ── Totals + colors by material ──────────────────────────────────────────
  const materialTotals = Array.from(details.values()).reduce((acc, f) => {
    const key = f.material ?? "OTHER";
    acc[key] = (acc[key] ?? 0) + (f.weightG ?? 0);
    return acc;
  }, {} as Record<string, number>);

  const materialColors = Array.from(details.values()).reduce((acc, f) => {
    const key = f.material ?? "OTHER";
    if (!acc[key]) acc[key] = [];
    acc[key].push(f.color);
    return acc;
  }, {} as Record<string, (string | null | undefined)[]>);

  if (authState !== "authenticated") return null;

  return (
    <InventoryLayout>
      <div className="flex h-full">

        {/* ── Main ────────────────────────────────────────────────────── */}
        <div className="flex-1 px-3 py-4 md:px-6 md:py-6 overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-purple dark:text-rose">Filaments</h1>
            <button onClick={openNew}
              className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity">
              + Add Filament
            </button>
          </div>

          {/* Material summary cards with color dots */}
          {Object.keys(materialTotals).length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {Object.entries(materialTotals)
                .sort((a, b) => b[1] - a[1])
                .map(([mat, grams]) => (
                  <div key={mat}
                    className="flex flex-col gap-1.5 px-3 py-2 rounded-lg"
                    style={{ backgroundColor: "#8B5CF611", border: "1px solid #8B5CF633" }}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold" style={{ color: "#8B5CF6" }}>
                        {FILAMENT_MAT_LABELS[mat] ?? mat}
                      </span>
                      <span className="text-[10px] text-gray-400">
                        {(grams / 1000).toFixed(1)} kg
                      </span>
                    </div>
                    <FilamentColorDots colors={materialColors[mat] ?? []} size={14} max={16} />
                  </div>
                ))}
            </div>
          )}

          {loading ? (
            <div className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</div>
          ) : items.length === 0 ? (
            <EmptyState label="Filament" onAdd={openNew} />
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <InventoryTable
                items={tableControls.paged}
                columns={columns}
                thumbnails={thumbnails}
                onEdit={(item) => { const fl = details.get(item.id); if (fl) openEdit(item, fl); }}
                onDelete={handleDelete}
                sortKey={tableControls.sortKey}
                sortDir={tableControls.sortDir}
                onSort={tableControls.handleSort}
              />
              <TableControls
                page={tableControls.page}
                totalPages={tableControls.totalPages}
                totalItems={tableControls.totalItems}
                pageSize={tableControls.pageSize}
                setPage={tableControls.setPage}
                setPageSize={tableControls.setPageSize}
              />
            </div>
          )}
        </div>

        {/* ── Side panel ──────────────────────────────────────────────── */}
        {panel && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-96 border-l border-gray-200 dark:border-gray-700 flex flex-col bg-white dark:bg-darkPurple overflow-hidden">
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
                    {FILAMENT_MATS.map((m) => <option key={m} value={m}>{FILAMENT_MAT_LABELS[m] ?? m}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Diameter</label>
                  <select className={inputCls}
                    value={filamentDraft.diameter ?? "d175"}
                    onChange={(e) => setFilamentDraft((d) => ({ ...d, diameter: e.target.value as any }))}>
                    {FILAMENT_DIAMS.map((d) => <option key={d} value={d}>{FILAMENT_DIAM_LABELS[d]}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className={labelCls}>Variant</label>
                <input type="text" list="filament-variants" className={inputCls} placeholder="HF, Translucent, Matte…"
                  value={filamentDraft.variant ?? ""}
                  onChange={(e) => setFilamentDraft((d) => ({ ...d, variant: e.target.value }))} />
                <datalist id="filament-variants">
                  {FILAMENT_VARIANTS.map((v) => <option key={v} value={v} />)}
                </datalist>
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

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Quantity (spools)</label>
                  <input type="number" min={1} className={inputCls} placeholder="1"
                    value={filamentDraft.quantity ?? 1}
                    onChange={(e) => setFilamentDraft((d) => ({ ...d, quantity: parseInt(e.target.value) || 1 }))} />
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
