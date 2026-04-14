import React, { useEffect, useState, useCallback, useRef } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import InventoryLayout from "@/layouts/inventory";
import { useRouter } from "next/router";
import {
  ItemRecord, PhotographyRecord,
  PHOTOGRAPHY_TYPES, PHOTOGRAPHY_ICONS,
  inputCls, labelCls,
  fmtCurrency, fmtDate,
  BaseItemFields, SaveButton, DeleteButton, EmptyState,
  ImageUploader, ImageUploaderHandle, useSuggestions,
  InventoryTable, ColDef, useThumbnails,
  useTableControls, TableControls,
} from "@/components/inventory/_shared";

const client = generateClient<Schema>();

type PanelState =
  | { kind: "new" }
  | { kind: "edit"; item: ItemRecord; photo: PhotographyRecord }
  | null;

const ACCENT = "#0EA5E9";

function focalLabel(p: PhotographyRecord): string {
  const min = p.focalLengthMin ?? null;
  const max = p.focalLengthMax ?? null;
  if (min == null && max == null) return "";
  if (min != null && max != null && min !== max) return `${min}–${max}mm`;
  return `${min ?? max}mm`;
}

export default function PhotographyPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [items,      setItems]      = useState<ItemRecord[]>([]);
  const [details,    setDetails]    = useState<Map<string, PhotographyRecord>>(new Map());
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [panel,      setPanel]      = useState<PanelState>(null);
  const [itemDraft,  setItemDraft]  = useState<Partial<ItemRecord>>({});
  const [photoDraft, setPhotoDraft] = useState<Partial<PhotographyRecord>>({});
  const imgRef = useRef<ImageUploaderHandle>(null);
  const suggestions = useSuggestions(items);
  const thumbnails  = useThumbnails(items);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: itemData }, { data: detailData }] = await Promise.all([
        client.models.inventoryItem.list({ filter: { category: { eq: "PHOTOGRAPHY" }, active: { ne: false } }, limit: 500 }),
        client.models.inventoryPhotography.list({ limit: 500 }),
      ]);
      setItems(itemData ?? []);
      const map = new Map<string, PhotographyRecord>();
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
    router.replace("/inventory/photography", undefined, { shallow: true });
  }, [router.isReady, router.query.new]);

  useEffect(() => {
    if (!router.isReady || !router.query.id || items.length === 0) return;
    const item = items.find((i) => i.id === router.query.id);
    const photo = item ? details.get(item.id) : undefined;
    if (item && photo) openEdit(item, photo);
  }, [router.isReady, router.query.id, items, details]);

  function openNew() {
    setItemDraft({ category: "PHOTOGRAPHY", currency: "USD", active: true });
    setPhotoDraft({ type: "CAMERA" });
    setPanel({ kind: "new" });
  }

  function openEdit(item: ItemRecord, photo: PhotographyRecord) {
    setItemDraft({ ...item });
    setPhotoDraft({ ...photo });
    setPanel({ kind: "edit", item, photo });
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
          category:      "PHOTOGRAPHY",
          datePurchased: itemDraft.datePurchased ?? null,
          vendor:        itemDraft.vendor        ?? null,
          url:           itemDraft.url           ?? null,
          pricePaid:     itemDraft.pricePaid     ?? null,
          currency:      itemDraft.currency      ?? "USD",
          notes:         itemDraft.notes         ?? null,
          priceSold:     itemDraft.priceSold     ?? null,
          active:        itemDraft.active        ?? true,
        });
        if (errors || !newItem) return;
        const { data: newPhoto } = await client.models.inventoryPhotography.create({
          itemId:            newItem.id,
          type:              (photoDraft.type ?? "OTHER") as any,
          serialNumber:      photoDraft.serialNumber     ?? null,
          mount:             photoDraft.mount            ?? null,
          sensorFormat:      photoDraft.sensorFormat     ?? null,
          focalLengthMin:    photoDraft.focalLengthMin   ?? null,
          focalLengthMax:    photoDraft.focalLengthMax   ?? null,
          apertureMax:       photoDraft.apertureMax      ?? null,
          stabilized:        photoDraft.stabilized       ?? null,
          weightG:           photoDraft.weightG          ?? null,
          maxFlightTimeMin:  photoDraft.maxFlightTimeMin ?? null,
          subC250g:          photoDraft.subC250g         ?? null,
        });
        const imageKeys = await imgRef.current?.commit(newItem.id) ?? [];
        if (imageKeys.length > 0) {
          await client.models.inventoryItem.update({ id: newItem.id, imageKeys });
        }
        if (newPhoto) {
          setItems((prev) => [{ ...newItem, imageKeys }, ...prev]);
          setDetails((prev) => new Map(prev).set(newItem.id, newPhoto));
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
          priceSold:     itemDraft.priceSold     ?? null,
          active:        itemDraft.active        ?? true,
        });
        await client.models.inventoryPhotography.update({
          id:                panel.photo.id,
          type:              (photoDraft.type ?? "OTHER") as any,
          serialNumber:      photoDraft.serialNumber     ?? null,
          mount:             photoDraft.mount            ?? null,
          sensorFormat:      photoDraft.sensorFormat     ?? null,
          focalLengthMin:    photoDraft.focalLengthMin   ?? null,
          focalLengthMax:    photoDraft.focalLengthMax   ?? null,
          apertureMax:       photoDraft.apertureMax      ?? null,
          stabilized:        photoDraft.stabilized       ?? null,
          weightG:           photoDraft.weightG          ?? null,
          maxFlightTimeMin:  photoDraft.maxFlightTimeMin ?? null,
          subC250g:          photoDraft.subC250g         ?? null,
        });
        const imageKeys = await imgRef.current?.commit(panel.item.id) ?? (itemDraft.imageKeys ?? []);
        await client.models.inventoryItem.update({ id: panel.item.id, imageKeys });
        const updatedItem  = { ...panel.item,  ...itemDraft,  imageKeys } as ItemRecord;
        const updatedPhoto = { ...panel.photo, ...photoDraft }           as PhotographyRecord;
        setItems((prev)   => prev.map((i) => i.id === updatedItem.id ? updatedItem : i));
        setDetails((prev) => new Map(prev).set(updatedItem.id, updatedPhoto));
      }
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (panel?.kind !== "edit") return;
    if (!confirm("Delete this photography record?")) return;
    setSaving(true);
    try {
      await client.models.inventoryPhotography.delete({ id: panel.photo.id });
      await client.models.inventoryItem.delete({ id: panel.item.id });
      setItems((prev)   => prev.filter((i) => i.id !== panel.item.id));
      setDetails((prev) => { const m = new Map(prev); m.delete(panel.item.id); return m; });
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  const columns: ColDef<ItemRecord>[] = [
    { key: "name",   label: "Name",   render: (r) => <span className="font-medium">{r.name}</span>,                                                              sortValue: (r) => r.name ?? "" },
    { key: "type",   label: "Type",   render: (r) => { const t = details.get(r.id)?.type; return t ? <span>{PHOTOGRAPHY_ICONS[t]} {t}</span> : <span>—</span>; }, sortValue: (r) => details.get(r.id)?.type ?? "" },
    { key: "mount",  label: "Mount",  render: (r) => details.get(r.id)?.mount ?? "—",                                                                             sortValue: (r) => details.get(r.id)?.mount ?? "" },
    { key: "focal",  label: "Focal",  render: (r) => { const d = details.get(r.id); return d ? focalLabel(d) || "—" : "—"; },    mobileHidden: true,              sortValue: (r) => details.get(r.id)?.focalLengthMin ?? 0 },
    { key: "sensor", label: "Sensor", render: (r) => details.get(r.id)?.sensorFormat ?? "—",                                     mobileHidden: true,              sortValue: (r) => details.get(r.id)?.sensorFormat ?? "" },
    { key: "brand",  label: "Brand",  render: (r) => r.brand ?? "—",                                                             mobileHidden: true,              sortValue: (r) => r.brand ?? "" },
    { key: "price",  label: "Price",  render: (r) => fmtCurrency(r.pricePaid, r.currency ?? "USD"),                              mobileHidden: true,              sortValue: (r) => r.pricePaid ?? 0 },
    { key: "date",   label: "Date",   render: (r) => fmtDate(r.datePurchased),                                                   mobileHidden: true,              sortValue: (r) => r.datePurchased ?? "" },
  ];

  const tableControls = useTableControls(items, (item, key) => {
    const col = columns.find((c) => c.key === key);
    return col?.sortValue?.(item);
  });

  const typeCounts = Array.from(details.values()).reduce((acc, p) => {
    const key = p.type ?? "OTHER";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const type = photoDraft.type ?? "CAMERA";
  const showFocal     = ["CAMERA", "LENS", "DRONE"].includes(type);
  const showSensor    = ["CAMERA", "DRONE"].includes(type);
  const showMount     = ["CAMERA", "LENS", "GIMBAL"].includes(type);
  const showDroneRegs = type === "DRONE";

  if (authState !== "authenticated") return null;

  return (
    <InventoryLayout>
      <div className="flex h-full">

        {/* ── Main ────────────────────────────────────────────────────── */}
        <div className="flex-1 px-3 py-4 md:px-6 md:py-6 overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold" style={{ color: ACCENT }}>Photography</h1>
            <button onClick={openNew}
              className="px-4 py-2 rounded text-sm font-semibold text-white hover:opacity-90 transition-opacity"
              style={{ backgroundColor: ACCENT }}>
              + Add Photography Item
            </button>
          </div>

          {/* Type summary pills */}
          {Object.keys(typeCounts).length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {Object.entries(typeCounts).map(([t, count]) => (
                <span key={t}
                  className="px-3 py-1 rounded-full text-xs font-semibold"
                  style={{ backgroundColor: ACCENT + "22", color: ACCENT, border: `1px solid ${ACCENT}55` }}>
                  {PHOTOGRAPHY_ICONS[t]} {t} — {count}
                </span>
              ))}
            </div>
          )}

          {loading ? (
            <div className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</div>
          ) : items.length === 0 ? (
            <EmptyState label="Photography Item" onAdd={openNew} />
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
              <InventoryTable
                items={tableControls.paged}
                columns={columns}
                thumbnails={thumbnails}
                onEdit={(item) => { const p = details.get(item.id); if (p) openEdit(item, p); }}
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
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-96 border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
              <h2 className="text-base font-semibold truncate" style={{ color: ACCENT }}>
                {panel.kind === "new" ? "New Photography Item" : itemDraft.name}
              </h2>
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <BaseItemFields item={itemDraft} onChange={(p) => setItemDraft((d) => ({ ...d, ...p }))} suggestions={suggestions} />

              <hr className="border-gray-200 dark:border-darkBorder" />
              <p className={labelCls}>Photography Details</p>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Type</label>
                  <select className={inputCls}
                    value={photoDraft.type ?? "CAMERA"}
                    onChange={(e) => setPhotoDraft((d) => ({ ...d, type: e.target.value as any }))}>
                    {PHOTOGRAPHY_TYPES.map((t) => (
                      <option key={t} value={t}>{PHOTOGRAPHY_ICONS[t]} {t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Serial #</label>
                  <input type="text" className={inputCls} placeholder="SN-XXXX"
                    value={photoDraft.serialNumber ?? ""}
                    onChange={(e) => setPhotoDraft((d) => ({ ...d, serialNumber: e.target.value }))} />
                </div>
              </div>

              {(showMount || showSensor) && (
                <div className="grid grid-cols-2 gap-2">
                  {showMount && (
                    <div>
                      <label className={labelCls}>Mount</label>
                      <input type="text" className={inputCls} placeholder="E, RF, L, EF, M4/3"
                        value={photoDraft.mount ?? ""}
                        onChange={(e) => setPhotoDraft((d) => ({ ...d, mount: e.target.value }))} />
                    </div>
                  )}
                  {showSensor && (
                    <div>
                      <label className={labelCls}>Sensor</label>
                      <input type="text" className={inputCls} placeholder='FF, APS-C, M43, 1"'
                        value={photoDraft.sensorFormat ?? ""}
                        onChange={(e) => setPhotoDraft((d) => ({ ...d, sensorFormat: e.target.value }))} />
                    </div>
                  )}
                </div>
              )}

              {showFocal && (
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className={labelCls}>Focal min (mm)</label>
                    <input type="number" step="0.1" className={inputCls} placeholder="24"
                      value={photoDraft.focalLengthMin ?? ""}
                      onChange={(e) => setPhotoDraft((d) => ({ ...d, focalLengthMin: parseFloat(e.target.value) || null }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Focal max (mm)</label>
                    <input type="number" step="0.1" className={inputCls} placeholder="70"
                      value={photoDraft.focalLengthMax ?? ""}
                      onChange={(e) => setPhotoDraft((d) => ({ ...d, focalLengthMax: parseFloat(e.target.value) || null }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Aperture f/</label>
                    <input type="number" step="0.1" className={inputCls} placeholder="2.8"
                      value={photoDraft.apertureMax ?? ""}
                      onChange={(e) => setPhotoDraft((d) => ({ ...d, apertureMax: parseFloat(e.target.value) || null }))} />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Weight (g)</label>
                  <input type="number" className={inputCls} placeholder="500"
                    value={photoDraft.weightG ?? ""}
                    onChange={(e) => setPhotoDraft((d) => ({ ...d, weightG: parseInt(e.target.value) || null }))} />
                </div>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox"
                      checked={photoDraft.stabilized ?? false}
                      onChange={(e) => setPhotoDraft((d) => ({ ...d, stabilized: e.target.checked }))} />
                    Stabilized
                  </label>
                </div>
              </div>

              {showDroneRegs && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelCls}>Max flight (min)</label>
                    <input type="number" className={inputCls} placeholder="31"
                      value={photoDraft.maxFlightTimeMin ?? ""}
                      onChange={(e) => setPhotoDraft((d) => ({ ...d, maxFlightTimeMin: parseInt(e.target.value) || null }))} />
                  </div>
                  <div className="flex items-end pb-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox"
                        checked={photoDraft.subC250g ?? false}
                        onChange={(e) => setPhotoDraft((d) => ({ ...d, subC250g: e.target.checked }))} />
                      Under 250g (no FAA reg)
                    </label>
                  </div>
                </div>
              )}

              <hr className="border-gray-200 dark:border-darkBorder" />
              <ImageUploader
                ref={imgRef}
                itemId={panel.kind === "edit" ? panel.item.id : undefined}
                existingKeys={(panel.kind === "edit" ? panel.item.imageKeys : []) ?? []}
              />

              <SaveButton saving={saving} onSave={handleSave}
                label={panel.kind === "new" ? "Create Photography Item" : "Save"} />
              {panel.kind === "edit" && <DeleteButton saving={saving} onDelete={handleDelete} />}
            </div>
          </div>
        )}
      </div>
    </InventoryLayout>
  );
}
