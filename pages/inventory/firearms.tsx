import React, { useEffect, useState, useCallback, useRef } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import InventoryLayout from "@/layouts/inventory";
import { useRouter } from "next/router";
import {
  ItemRecord, FirearmRecord,
  FIREARM_TYPES, CALIBERS,
  inputCls, labelCls, CaliberInput,
  fmtCurrency, fmtDate,
  BaseItemFields, SaveButton, DeleteButton, EmptyState,
  ImageUploader, ImageUploaderHandle,
  InventoryTable, ColDef, useThumbnails, useSuggestions,
} from "./_shared";

const client = generateClient<Schema>();

type FirearmPart = { name: string; brand?: string | null; installedDate?: string | null; notes?: string | null };

type PanelState =
  | { kind: "new" }
  | { kind: "edit"; item: ItemRecord; firearm: FirearmRecord }
  | null;

// Combined row type for the table
type FirearmRow = ItemRecord & { _fw?: FirearmRecord };

export default function FirearmsPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [items,    setItems]    = useState<ItemRecord[]>([]);
  const [details,  setDetails]  = useState<Map<string, FirearmRecord>>(new Map());
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [panel,    setPanel]    = useState<PanelState>(null);
  const [itemDraft,    setItemDraft]    = useState<Partial<ItemRecord>>({});
  const [firearmDraft, setFirearmDraft] = useState<Partial<FirearmRecord>>({});
  const imgRef = useRef<ImageUploaderHandle>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: itemData }, { data: detailData }] = await Promise.all([
        client.models.inventoryItem.list({ filter: { category: { eq: "FIREARM" } }, limit: 500 }),
        client.models.inventoryFirearm.list({ limit: 500 }),
      ]);
      setItems(itemData ?? []);
      const map = new Map<string, FirearmRecord>();
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

  useEffect(() => {
    if (!router.isReady || router.query.new !== "1") return;
    openNew();
    router.replace("/inventory/firearms", undefined, { shallow: true });
  }, [router.isReady, router.query.new]);

  useEffect(() => {
    if (!router.isReady || !router.query.id || items.length === 0) return;
    const item = items.find((i) => i.id === router.query.id);
    const firearm = item ? details.get(item.id) : undefined;
    if (item && firearm) openEdit(item, firearm);
  }, [router.isReady, router.query.id, items, details]);

  function openNew() {
    setItemDraft({ category: "FIREARM", currency: "USD" });
    setFirearmDraft({});
    setPanel({ kind: "new" });
  }

  function openEdit(item: ItemRecord, firearm: FirearmRecord) {
    setItemDraft({ ...item });
    setFirearmDraft({ ...firearm });
    setPanel({ kind: "edit", item, firearm });
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
          category:      "FIREARM",
          datePurchased: itemDraft.datePurchased ?? null,
          vendor:        itemDraft.vendor        ?? null,
          url:           itemDraft.url           ?? null,
          pricePaid:     itemDraft.pricePaid     ?? null,
          currency:      itemDraft.currency      ?? "USD",
          notes:         itemDraft.notes         ?? null,
        });
        if (errors || !newItem) return;
        const { data: newFirearm } = await client.models.inventoryFirearm.create({
          itemId:       newItem.id,
          type:         (firearmDraft.type ?? "OTHER") as any,
          serialNumber: firearmDraft.serialNumber ?? null,
          caliber:      firearmDraft.caliber      ?? null,
          action:       firearmDraft.action        ?? null,
          finish:       firearmDraft.finish        ?? null,
          barrelLength: firearmDraft.barrelLength  ?? null,
          parts:        (firearmDraft.parts ?? []) as any,
        });
        const imageKeys = await imgRef.current?.commit(newItem.id) ?? [];
        if (imageKeys.length > 0) {
          await client.models.inventoryItem.update({ id: newItem.id, imageKeys });
        }
        if (newFirearm) {
          setItems((prev) => [{ ...newItem, imageKeys }, ...prev]);
          setDetails((prev) => new Map(prev).set(newItem.id, newFirearm));
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
        await client.models.inventoryFirearm.update({
          id:           panel.firearm.id,
          type:         (firearmDraft.type ?? "OTHER") as any,
          serialNumber: firearmDraft.serialNumber ?? null,
          caliber:      firearmDraft.caliber      ?? null,
          action:       firearmDraft.action        ?? null,
          finish:       firearmDraft.finish        ?? null,
          barrelLength: firearmDraft.barrelLength  ?? null,
          parts:        (firearmDraft.parts ?? []) as any,
        });
        const imageKeys = await imgRef.current?.commit(panel.item.id) ?? (itemDraft.imageKeys ?? []);
        await client.models.inventoryItem.update({ id: panel.item.id, imageKeys });
        const updatedItem = { ...panel.item, ...itemDraft, imageKeys } as ItemRecord;
        const updatedFirearm = { ...panel.firearm, ...firearmDraft } as FirearmRecord;
        setItems((prev) => prev.map((i) => (i.id === updatedItem.id ? updatedItem : i)));
        setDetails((prev) => new Map(prev).set(updatedItem.id, updatedFirearm));
      }
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteItem(item: ItemRecord) {
    const fw = details.get(item.id);
    if (!confirm("Delete this firearm and all its data?")) return;
    setSaving(true);
    try {
      if (fw) await client.models.inventoryFirearm.delete({ id: fw.id });
      await client.models.inventoryItem.delete({ id: item.id });
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setDetails((prev) => { const m = new Map(prev); m.delete(item.id); return m; });
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  const thumbnails = useThumbnails(items);
  const suggestions = useSuggestions(items);

  const columns: ColDef<ItemRecord>[] = [
    { key: "name",   label: "Name",     render: (r) => <span className="font-medium">{r.name}</span> },
    { key: "brand",  label: "Brand",    render: (r) => r.brand ?? "—" },
    { key: "type",   label: "Type",     render: (r) => details.get(r.id)?.type ?? "—" },
    { key: "caliber",label: "Caliber",  render: (r) => details.get(r.id)?.caliber ?? "—" },
    { key: "serial", label: "Serial #", render: (r) => details.get(r.id)?.serialNumber ?? "—" },
    { key: "date",   label: "Date",     render: (r) => fmtDate(r.datePurchased) },
    { key: "price",  label: "Price",    render: (r) => fmtCurrency(r.pricePaid, r.currency ?? "USD") },
    { key: "action", label: "Action",   render: (r) => details.get(r.id)?.action ?? "—" },
  ];

  if (authState !== "authenticated") return null;

  return (
    <InventoryLayout>
      <div className="flex h-full">

        {/* ── Table ───────────────────────────────────────────────────── */}
        <div className="flex-1 px-6 py-6 overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-purple dark:text-rose">Firearms</h1>
            <button onClick={openNew}
              className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity">
              + Add Firearm
            </button>
          </div>

          {loading ? (
            <div className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</div>
          ) : items.length === 0 ? (
            <EmptyState label="Firearm" onAdd={openNew} />
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <InventoryTable
                items={items}
                columns={columns}
                thumbnails={thumbnails}
                onEdit={(item) => {
                  const fw = details.get(item.id);
                  if (fw) openEdit(item, fw);
                }}
                onDelete={handleDeleteItem}
              />
            </div>
          )}
        </div>

        {/* ── Side panel ──────────────────────────────────────────────── */}
        {panel && (
          <div className="w-96 border-l border-gray-200 dark:border-gray-700 flex flex-col bg-white dark:bg-darkPurple overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b dark:border-gray-700 flex-shrink-0">
              <h2 className="text-base font-semibold dark:text-rose text-purple truncate">
                {panel.kind === "new" ? "New Firearm" : itemDraft.name}
              </h2>
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <BaseItemFields item={itemDraft} onChange={(p) => setItemDraft((d) => ({ ...d, ...p }))} suggestions={suggestions} />

              <hr className="border-gray-200 dark:border-gray-700" />
              <p className={labelCls}>Firearm Details</p>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Type</label>
                  <select className={inputCls}
                    value={firearmDraft.type ?? "OTHER"}
                    onChange={(e) => setFirearmDraft((d) => ({ ...d, type: e.target.value as any }))}>
                    {FIREARM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Caliber</label>
                  <CaliberInput
                    value={firearmDraft.caliber ?? ""}
                    onChange={(v) => setFirearmDraft((d) => ({ ...d, caliber: v }))}
                  />
                </div>
              </div>

              <div>
                <label className={labelCls}>Serial Number</label>
                <input type="text" className={inputCls}
                  value={firearmDraft.serialNumber ?? ""}
                  onChange={(e) => setFirearmDraft((d) => ({ ...d, serialNumber: e.target.value }))} />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Action</label>
                  <input type="text" className={inputCls} placeholder="Semi-auto"
                    value={firearmDraft.action ?? ""}
                    onChange={(e) => setFirearmDraft((d) => ({ ...d, action: e.target.value }))} />
                </div>
                <div>
                  <label className={labelCls}>Barrel Length</label>
                  <input type="text" className={inputCls} placeholder='4.02"'
                    value={firearmDraft.barrelLength ?? ""}
                    onChange={(e) => setFirearmDraft((d) => ({ ...d, barrelLength: e.target.value }))} />
                </div>
              </div>

              <div>
                <label className={labelCls}>Finish</label>
                <input type="text" className={inputCls} placeholder="Matte black"
                  value={firearmDraft.finish ?? ""}
                  onChange={(e) => setFirearmDraft((d) => ({ ...d, finish: e.target.value }))} />
              </div>

              <PartsEditor
                parts={(firearmDraft.parts ?? []) as FirearmPart[]}
                onChange={(parts) => setFirearmDraft((d) => ({ ...d, parts: parts as any }))}
              />

              <hr className="border-gray-200 dark:border-gray-700" />
              <ImageUploader
                ref={imgRef}
                itemId={panel.kind === "edit" ? panel.item.id : undefined}
                existingKeys={(panel.kind === "edit" ? panel.item.imageKeys : []) ?? []}
              />

              <SaveButton saving={saving} onSave={handleSave}
                label={panel.kind === "new" ? "Create Firearm" : "Save"} />
              {panel.kind === "edit" && (
                <DeleteButton saving={saving} onDelete={() => handleDeleteItem(panel.item)} />
              )}
            </div>
          </div>
        )}
      </div>
    </InventoryLayout>
  );
}

// ── Parts editor ──────────────────────────────────────────────────────────────

function PartsEditor({ parts, onChange }: { parts: FirearmPart[]; onChange: (p: FirearmPart[]) => void }) {
  function addPart() {
    onChange([...parts, { name: "", brand: null, installedDate: null, notes: null }]);
  }
  function removePart(i: number) {
    onChange(parts.filter((_, idx) => idx !== i));
  }
  function updatePart(i: number, patch: Partial<FirearmPart>) {
    onChange(parts.map((p, idx) => idx === i ? { ...p, ...patch } : p));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className={labelCls}>Parts / Accessories</label>
        <button onClick={addPart}
          className="text-xs text-purple dark:text-rose hover:underline">+ Add part</button>
      </div>
      {parts.length === 0 && (
        <p className="text-xs text-gray-400 italic">No parts added yet.</p>
      )}
      {parts.map((part, i) => (
        <div key={i} className="border border-gray-200 dark:border-gray-700 rounded p-3 mb-2 flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Part Name *</label>
              <input type="text" className={inputCls} placeholder="Trigger"
                value={part.name}
                onChange={(e) => updatePart(i, { name: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>Brand</label>
              <input type="text" className={inputCls} placeholder="Apex"
                value={part.brand ?? ""}
                onChange={(e) => updatePart(i, { brand: e.target.value })} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Installed Date</label>
            <input type="date" className={inputCls}
              value={part.installedDate ?? ""}
              onChange={(e) => updatePart(i, { installedDate: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Notes</label>
            <input type="text" className={inputCls}
              value={part.notes ?? ""}
              onChange={(e) => updatePart(i, { notes: e.target.value })} />
          </div>
          <button onClick={() => removePart(i)}
            className="text-xs text-red-400 hover:underline self-end">Remove</button>
        </div>
      ))}
    </div>
  );
}
