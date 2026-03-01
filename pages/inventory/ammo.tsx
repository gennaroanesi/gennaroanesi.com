import React, { useEffect, useState, useCallback, useRef } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import InventoryLayout from "@/layouts/inventory";
import { useRouter } from "next/router";
import {
  ItemRecord, AmmoRecord,
  AMMO_UNITS, CALIBERS,
  inputCls, labelCls,
  fmtCurrency, fmtDate,
  BaseItemFields, SaveButton, DeleteButton, EmptyState,
  ImageUploader, ImageUploaderHandle,
  InventoryTable, ColDef, useThumbnails,
} from "./_shared";

const client = generateClient<Schema>();

type PanelState =
  | { kind: "new" }
  | { kind: "edit"; item: ItemRecord; ammo: AmmoRecord }
  | null;

export default function AmmoPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [items,      setItems]      = useState<ItemRecord[]>([]);
  const [details,    setDetails]    = useState<Map<string, AmmoRecord>>(new Map());
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [panel,      setPanel]      = useState<PanelState>(null);
  const [itemDraft,  setItemDraft]  = useState<Partial<ItemRecord>>({});
  const [ammoDraft,  setAmmoDraft]  = useState<Partial<AmmoRecord>>({});
  const imgRef = useRef<ImageUploaderHandle>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: itemData }, { data: detailData }] = await Promise.all([
        client.models.inventoryItem.list({ filter: { category: { eq: "AMMO" } }, limit: 500 }),
        client.models.inventoryAmmo.list({ limit: 500 }),
      ]);
      setItems(itemData ?? []);
      const map = new Map<string, AmmoRecord>();
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
    router.replace("/inventory/ammo", undefined, { shallow: true });
  }, [router.isReady, router.query.new]);

  useEffect(() => {
    if (!router.isReady || !router.query.id || items.length === 0) return;
    const item = items.find((i) => i.id === router.query.id);
    const ammo = item ? details.get(item.id) : undefined;
    if (item && ammo) openEdit(item, ammo);
  }, [router.isReady, router.query.id, items, details]);

  function openNew() {
    setItemDraft({ category: "AMMO", currency: "USD" });
    setAmmoDraft({ unit: "ROUNDS", quantity: 0 });
    setPanel({ kind: "new" });
  }

  function openEdit(item: ItemRecord, ammo: AmmoRecord) {
    setItemDraft({ ...item });
    setAmmoDraft({ ...ammo });
    setPanel({ kind: "edit", item, ammo });
  }

  async function handleSave() {
    if (!itemDraft.name?.trim()) return;
    if (!ammoDraft.caliber?.trim()) return;
    setSaving(true);
    try {
      if (panel?.kind === "new") {
        const { data: newItem, errors } = await client.models.inventoryItem.create({
          name:          itemDraft.name!,
          brand:         itemDraft.brand        ?? null,
          description:   itemDraft.description  ?? null,
          category:      "AMMO",
          datePurchased: itemDraft.datePurchased ?? null,
          vendor:        itemDraft.vendor        ?? null,
          url:           itemDraft.url           ?? null,
          pricePaid:     itemDraft.pricePaid     ?? null,
          currency:      itemDraft.currency      ?? "USD",
          notes:         itemDraft.notes         ?? null,
        });
        if (errors || !newItem) return;
        const { data: newAmmo } = await client.models.inventoryAmmo.create({
          itemId:      newItem.id,
          caliber:     ammoDraft.caliber!,
          quantity:    ammoDraft.quantity ?? 0,
          unit:        (ammoDraft.unit ?? "ROUNDS") as any,
          grain:       ammoDraft.grain       ?? null,
          bulletType:  ammoDraft.bulletType  ?? null,
          velocityFps: ammoDraft.velocityFps ?? null,
        });
        const imageKeys = await imgRef.current?.commit(newItem.id) ?? [];
        if (imageKeys.length > 0) {
          await client.models.inventoryItem.update({ id: newItem.id, imageKeys });
        }
        if (newAmmo) {
          setItems((prev) => [{ ...newItem, imageKeys }, ...prev]);
          setDetails((prev) => new Map(prev).set(newItem.id, newAmmo));
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
        await client.models.inventoryAmmo.update({
          id:          panel.ammo.id,
          caliber:     ammoDraft.caliber!,
          quantity:    ammoDraft.quantity ?? 0,
          unit:        (ammoDraft.unit ?? "ROUNDS") as any,
          grain:       ammoDraft.grain       ?? null,
          bulletType:  ammoDraft.bulletType  ?? null,
          velocityFps: ammoDraft.velocityFps ?? null,
        });
        const imageKeys = await imgRef.current?.commit(panel.item.id) ?? (itemDraft.imageKeys ?? []);
        await client.models.inventoryItem.update({ id: panel.item.id, imageKeys });
        const updatedItem  = { ...panel.item,  ...itemDraft, imageKeys } as ItemRecord;
        const updatedAmmo  = { ...panel.ammo,  ...ammoDraft } as AmmoRecord;
        setItems((prev)   => prev.map((i) => i.id === updatedItem.id ? updatedItem : i));
        setDetails((prev) => new Map(prev).set(updatedItem.id, updatedAmmo));
      }
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteItem(item: ItemRecord) {
    const am = details.get(item.id);
    if (!confirm("Delete this ammo record?")) return;
    setSaving(true);
    try {
      if (am) await client.models.inventoryAmmo.delete({ id: am.id });
      await client.models.inventoryItem.delete({ id: item.id });
      setItems((prev)   => prev.filter((i) => i.id !== item.id));
      setDetails((prev) => { const m = new Map(prev); m.delete(item.id); return m; });
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  const thumbnails = useThumbnails(items);

  const columns: ColDef<ItemRecord>[] = [
    { key: "name",     label: "Name",       render: (r) => <span className="font-medium">{r.name}</span> },
    { key: "brand",    label: "Brand",      render: (r) => r.brand ?? "—" },
    { key: "caliber",  label: "Caliber",    render: (r) => details.get(r.id)?.caliber ?? "—" },
    { key: "qty",      label: "Qty",        render: (r) => details.get(r.id)?.quantity?.toLocaleString() ?? "—" },
    { key: "unit",     label: "Unit",       render: (r) => details.get(r.id)?.unit ?? "—" },
    { key: "grain",    label: "Grain",      render: (r) => { const g = details.get(r.id)?.grain; return g ? `${g} gr` : "—"; } },
    { key: "type",     label: "Bullet Type",render: (r) => details.get(r.id)?.bulletType ?? "—" },
    { key: "vel",      label: "Vel (fps)",  render: (r) => details.get(r.id)?.velocityFps?.toString() ?? "—" },
    { key: "price",    label: "Price/Unit", render: (r) => fmtCurrency(r.pricePaid, r.currency ?? "USD") },
    { key: "date",     label: "Date",       render: (r) => fmtDate(r.datePurchased) },
  ];

  // ── Totals by caliber ─────────────────────────────────────────────────────
  const caliberTotals = Array.from(details.values()).reduce((acc, a) => {
    const key = a.caliber ?? "Unknown";
    acc[key] = (acc[key] ?? 0) + (a.quantity ?? 0);
    return acc;
  }, {} as Record<string, number>);

  if (authState !== "authenticated") return null;

  return (
    <InventoryLayout>
      <div className="flex h-full">

        {/* ── Main ────────────────────────────────────────────────────── */}
        <div className="flex-1 px-6 py-6 overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-purple dark:text-rose">Ammunition</h1>
            <button onClick={openNew}
              className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity">
              + Add Ammo
            </button>
          </div>

          {/* Caliber summary pills */}
          {Object.keys(caliberTotals).length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {Object.entries(caliberTotals).map(([cal, qty]) => (
                <span key={cal}
                  className="px-3 py-1 rounded-full text-xs font-semibold"
                  style={{ backgroundColor: "#DEBA0222", color: "#DEBA02", border: "1px solid #DEBA0255" }}>
                  {cal} — {qty.toLocaleString()} rds
                </span>
              ))}
            </div>
          )}

          {loading ? (
            <div className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</div>
          ) : items.length === 0 ? (
            <EmptyState label="Ammo" onAdd={openNew} />
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <InventoryTable
                items={items}
                columns={columns}
                thumbnails={thumbnails}
                onEdit={(item) => { const am = details.get(item.id); if (am) openEdit(item, am); }}
                onDelete={handleDeleteItem}
                category="AMMO"
              />
            </div>
          )}
        </div>

        {/* ── Side panel ──────────────────────────────────────────────── */}
        {panel && (
          <div className="w-96 border-l border-gray-200 dark:border-gray-700 flex flex-col bg-white dark:bg-darkPurple overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b dark:border-gray-700 flex-shrink-0">
              <h2 className="text-base font-semibold dark:text-rose text-purple truncate">
                {panel.kind === "new" ? "New Ammo" : itemDraft.name}
              </h2>
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <BaseItemFields item={itemDraft} onChange={(p) => setItemDraft((d) => ({ ...d, ...p }))} />

              <hr className="border-gray-200 dark:border-gray-700" />
              <p className={labelCls}>Ammo Details</p>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Caliber *</label>
                  <select className={inputCls}
                    value={ammoDraft.caliber ?? ""}
                    onChange={(e) => setAmmoDraft((d) => ({ ...d, caliber: e.target.value }))}>
                    <option value="">— Select —</option>
                    {CALIBERS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Unit</label>
                  <select className={inputCls}
                    value={ammoDraft.unit ?? "ROUNDS"}
                    onChange={(e) => setAmmoDraft((d) => ({ ...d, unit: e.target.value as any }))}>
                    {AMMO_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className={labelCls}>Quantity</label>
                <input type="number" min={0} className={inputCls} placeholder="50"
                  value={ammoDraft.quantity ?? ""}
                  onChange={(e) => setAmmoDraft((d) => ({ ...d, quantity: parseInt(e.target.value) || 0 }))} />
                {(itemDraft.pricePaid ?? 0) > 0 && (ammoDraft.quantity ?? 0) > 0 && (
                  <p className="text-xs text-gray-400 mt-0.5">
                    Total: {fmtCurrency((itemDraft.pricePaid ?? 0) * (ammoDraft.quantity ?? 0), itemDraft.currency ?? "USD")}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Grain</label>
                  <input type="number" min={0} className={inputCls} placeholder="115"
                    value={ammoDraft.grain ?? ""}
                    onChange={(e) => setAmmoDraft((d) => ({ ...d, grain: parseInt(e.target.value) || null }))} />
                </div>
                <div>
                  <label className={labelCls}>Bullet Type</label>
                  <input type="text" className={inputCls} placeholder="FMJ"
                    value={ammoDraft.bulletType ?? ""}
                    onChange={(e) => setAmmoDraft((d) => ({ ...d, bulletType: e.target.value }))} />
                </div>
              </div>

              <div>
                <label className={labelCls}>Velocity (fps)</label>
                <input type="number" min={0} className={inputCls} placeholder="1150"
                  value={ammoDraft.velocityFps ?? ""}
                  onChange={(e) => setAmmoDraft((d) => ({ ...d, velocityFps: parseInt(e.target.value) || null }))} />
              </div>

              <hr className="border-gray-200 dark:border-gray-700" />
              <ImageUploader
                ref={imgRef}
                itemId={panel.kind === "edit" ? panel.item.id : undefined}
                existingKeys={(panel.kind === "edit" ? panel.item.imageKeys : []) ?? []}
              />

              <SaveButton saving={saving} onSave={handleSave}
                label={panel.kind === "new" ? "Create Ammo" : "Save"} />
              {panel.kind === "edit" && <DeleteButton saving={saving} onDelete={() => handleDeleteItem(panel.item)} />}
            </div>
          </div>
        )}
      </div>
    </InventoryLayout>
  );
}
