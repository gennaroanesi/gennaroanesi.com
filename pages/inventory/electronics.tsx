import React, { useEffect, useState, useCallback, useRef } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import InventoryLayout from "@/layouts/inventory";
import { useRouter } from "next/router";
import {
  ItemRecord, ElectronicRecord,
  ELECTRONICS_TYPES, ELECTRONICS_ICONS, ELECTRONICS_LABELS,
  inputCls, labelCls,
  fmtCurrency, fmtDate,
  BaseItemFields, SaveButton, DeleteButton, EmptyState,
  ImageUploader, ImageUploaderHandle, useSuggestions,
  InventoryTable, ColDef, useThumbnails,
  useTableControls, TableControls,
  SearchBar, useInventorySearch,
} from "@/components/inventory/_shared";
import { SlideOverPanel, PageLoading } from "@/components/common/ui";
import { mutate, reportError } from "@/components/common/mutate";

const client = generateClient<Schema>();

type PanelState =
  | { kind: "new" }
  | { kind: "edit"; item: ItemRecord; detail: ElectronicRecord }
  | null;

const ACCENT = "#10B981";

// Types whose canonical "value" lives in the `valueText` field.
const VALUE_TYPES = new Set([
  "RESISTOR", "CAPACITOR", "INDUCTOR", "DIODE", "LED", "TRANSISTOR", "IC",
]);
// Types where electrical ratings (V / A / W / tolerance) are meaningful.
const ELECTRICAL_TYPES = new Set([
  "RESISTOR", "CAPACITOR", "INDUCTOR", "DIODE", "LED", "TRANSISTOR", "IC",
]);

export default function ElectronicsPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [items,       setItems]       = useState<ItemRecord[]>([]);
  const [details,     setDetails]     = useState<Map<string, ElectronicRecord>>(new Map());
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [panel,       setPanel]       = useState<PanelState>(null);
  const [itemDraft,   setItemDraft]   = useState<Partial<ItemRecord>>({});
  const [detailDraft, setDetailDraft] = useState<Partial<ElectronicRecord>>({});
  const imgRef = useRef<ImageUploaderHandle>(null);
  const suggestions = useSuggestions(items);
  const thumbnails  = useThumbnails(items);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: itemData }, { data: detailData }] = await Promise.all([
        client.models.inventoryItem.list({ filter: { category: { eq: "ELECTRONICS" } }, limit: 500 }),
        client.models.inventoryElectronic.list({ limit: 500 }),
      ]);
      setItems((itemData ?? []).filter((it) => (it.status ?? "OWNED") === "OWNED"));
      const map = new Map<string, ElectronicRecord>();
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
    openNew(router.query.wishlist === "1");
    router.replace("/inventory/electronics", undefined, { shallow: true });
  }, [router.isReady, router.query.new, router.query.wishlist]);

  useEffect(() => {
    if (!router.isReady || !router.query.id || items.length === 0) return;
    const item = items.find((i) => i.id === router.query.id);
    const detail = item ? details.get(item.id) : undefined;
    if (item && detail) openEdit(item, detail);
  }, [router.isReady, router.query.id, items, details]);

  function openNew(isWishlist = false) {
    setItemDraft({ category: "ELECTRONICS", currency: "USD", status: isWishlist ? "WISHLIST" : "OWNED" });
    setDetailDraft({ type: "RESISTOR" });
    setPanel({ kind: "new" });
  }

  function openEdit(item: ItemRecord, detail: ElectronicRecord) {
    setItemDraft({ ...item });
    setDetailDraft({ ...detail });
    setPanel({ kind: "edit", item, detail });
  }

  async function handleSave() {
    if (!itemDraft.name?.trim()) return;
    setSaving(true);
    try {
      if (panel?.kind === "new") {
        const newItem = await mutate(client.models.inventoryItem.create({
          name:          itemDraft.name!,
          brand:         itemDraft.brand        ?? null,
          description:   itemDraft.description  ?? null,
          category:      "ELECTRONICS",
          datePurchased: itemDraft.datePurchased ?? null,
          vendor:        itemDraft.vendor        ?? null,
          url:           itemDraft.url           ?? null,
          pricePaid:     itemDraft.pricePaid     ?? null,
          currency:      itemDraft.currency      ?? "USD",
          notes:         itemDraft.notes         ?? null,
          priceSold:     itemDraft.priceSold     ?? null,
          status:        itemDraft.status        ?? "OWNED",
        }));
        if (!newItem) return;
        const newDetail = await mutate(client.models.inventoryElectronic.create({
          itemId:          newItem.id,
          type:            (detailDraft.type ?? "OTHER") as any,
          partNumber:      detailDraft.partNumber     ?? null,
          packaging:       detailDraft.packaging      ?? null,
          quantity:        detailDraft.quantity       ?? null,
          valueText:       detailDraft.valueText      ?? null,
          voltageRating:   detailDraft.voltageRating  ?? null,
          currentRatingA:  detailDraft.currentRatingA ?? null,
          powerRatingW:    detailDraft.powerRatingW   ?? null,
          tolerancePct:    detailDraft.tolerancePct   ?? null,
          color:           detailDraft.color          ?? null,
        }));
        const imageKeys = await imgRef.current?.commit(newItem.id) ?? [];
        if (imageKeys.length > 0) {
          await mutate(client.models.inventoryItem.update({ id: newItem.id, imageKeys }));
        }
        if (newDetail) {
          setItems((prev) => [{ ...newItem, imageKeys }, ...prev]);
          setDetails((prev) => new Map(prev).set(newItem.id, newDetail));
        }
      } else if (panel?.kind === "edit") {
        await mutate(client.models.inventoryItem.update({
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
          status:        itemDraft.status        ?? "OWNED",
        }));
        await mutate(client.models.inventoryElectronic.update({
          id:              panel.detail.id,
          type:            (detailDraft.type ?? "OTHER") as any,
          partNumber:      detailDraft.partNumber     ?? null,
          packaging:       detailDraft.packaging      ?? null,
          quantity:        detailDraft.quantity       ?? null,
          valueText:       detailDraft.valueText      ?? null,
          voltageRating:   detailDraft.voltageRating  ?? null,
          currentRatingA:  detailDraft.currentRatingA ?? null,
          powerRatingW:    detailDraft.powerRatingW   ?? null,
          tolerancePct:    detailDraft.tolerancePct   ?? null,
          color:           detailDraft.color          ?? null,
        }));
        const imageKeys = await imgRef.current?.commit(panel.item.id) ?? (itemDraft.imageKeys ?? []);
        await mutate(client.models.inventoryItem.update({ id: panel.item.id, imageKeys }));
        const updatedItem   = { ...panel.item,   ...itemDraft,   imageKeys } as ItemRecord;
        const updatedDetail = { ...panel.detail, ...detailDraft } as ElectronicRecord;
        setItems((prev)   => prev.map((i) => i.id === updatedItem.id ? updatedItem : i));
        setDetails((prev) => new Map(prev).set(updatedItem.id, updatedDetail));
      }
      setPanel(null);
    } catch (e) {
      reportError(e, "Save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (panel?.kind !== "edit") return;
    if (!confirm("Delete this electronics record?")) return;
    setSaving(true);
    try {
      await mutate(client.models.inventoryElectronic.delete({ id: panel.detail.id }));
      await mutate(client.models.inventoryItem.delete({ id: panel.item.id }));
      setItems((prev)   => prev.filter((i) => i.id !== panel.item.id));
      setDetails((prev) => { const m = new Map(prev); m.delete(panel.item.id); return m; });
      setPanel(null);
    } catch (e) {
      reportError(e, "Delete");
    } finally {
      setSaving(false);
    }
  }

  const columns: ColDef<ItemRecord>[] = [
    { key: "name",   label: "Name",       render: (r) => <span className="font-medium">{r.name}</span>,                                                                  sortValue: (r) => r.name ?? "" },
    { key: "type",   label: "Type",       render: (r) => { const t = details.get(r.id)?.type; return t ? <span>{ELECTRONICS_ICONS[t]} {ELECTRONICS_LABELS[t] ?? t}</span> : <span>—</span>; }, sortValue: (r) => details.get(r.id)?.type ?? "" },
    { key: "value",  label: "Value",      render: (r) => details.get(r.id)?.valueText ?? "—",                                                                            sortValue: (r) => details.get(r.id)?.valueText ?? "" },
    { key: "part",   label: "Part #",     render: (r) => details.get(r.id)?.partNumber ?? "—",                                              mobileHidden: true,           sortValue: (r) => details.get(r.id)?.partNumber ?? "" },
    { key: "pkg",    label: "Package",    render: (r) => details.get(r.id)?.packaging ?? "—",                                               mobileHidden: true,           sortValue: (r) => details.get(r.id)?.packaging ?? "" },
    { key: "qty",    label: "Qty",        render: (r) => details.get(r.id)?.quantity?.toLocaleString() ?? "—",                                                           sortValue: (r) => details.get(r.id)?.quantity ?? 0 },
    { key: "brand",  label: "Brand",      render: (r) => r.brand ?? "—",                                                                    mobileHidden: true,           sortValue: (r) => r.brand ?? "" },
    { key: "price",  label: "Total Paid", render: (r) => fmtCurrency(r.pricePaid, r.currency ?? "USD"),                                     mobileHidden: true,           sortValue: (r) => r.pricePaid ?? 0 },
    { key: "date",   label: "Date",       render: (r) => fmtDate(r.datePurchased),                                                          mobileHidden: true,           sortValue: (r) => r.datePurchased ?? "" },
  ];

  const getSearchableText = useCallback((it: ItemRecord) => {
    const d = details.get(it.id);
    return [
      it.name, it.brand, it.vendor, it.description, it.notes,
      d?.type ? ELECTRONICS_LABELS[d.type] : null,
      d?.partNumber, d?.packaging, d?.valueText, d?.color,
    ];
  }, [details]);
  const { search, setSearch, filtered } = useInventorySearch(items, getSearchableText);

  const tableControls = useTableControls(filtered, (item, key) => {
    const col = columns.find((c) => c.key === key);
    return col?.sortValue?.(item);
  });

  const typeCounts = Array.from(details.values()).reduce((acc, d) => {
    const key = d.type ?? "OTHER";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const type = detailDraft.type ?? "RESISTOR";
  const showValue       = VALUE_TYPES.has(type);
  const showPart        = ["IC", "TRANSISTOR", "DIODE", "MODULE", "LED"].includes(type);
  const showPackage     = ["RESISTOR","CAPACITOR","INDUCTOR","DIODE","LED","TRANSISTOR","IC"].includes(type);
  const showElectrical  = ELECTRICAL_TYPES.has(type);
  const showColor       = ["LED", "WIRE_CONNECTOR"].includes(type);

  if (authState !== "authenticated") return null;

  return (
    <InventoryLayout>
      <div className="flex h-full">

        {/* ── Main ────────────────────────────────────────────────────── */}
        <div className="flex-1 px-3 py-4 md:px-6 md:py-6 overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold" style={{ color: ACCENT }}>Electronics</h1>
            <button onClick={() => openNew()}
              className="px-4 py-2 rounded text-sm font-semibold text-white hover:opacity-90 transition-opacity"
              style={{ backgroundColor: ACCENT }}>
              + Add Electronics
            </button>
          </div>

          <div className="mb-4">
            <SearchBar value={search} onChange={setSearch} placeholder="Search electronics…" />
          </div>

          {/* Type summary pills */}
          {Object.keys(typeCounts).length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {Object.entries(typeCounts).map(([t, count]) => (
                <span key={t}
                  className="px-3 py-1 rounded-full text-xs font-semibold"
                  style={{ backgroundColor: ACCENT + "22", color: ACCENT, border: `1px solid ${ACCENT}55` }}>
                  {ELECTRONICS_ICONS[t]} {ELECTRONICS_LABELS[t] ?? t} — {count}
                </span>
              ))}
            </div>
          )}

          {loading ? (
            <PageLoading />
          ) : items.length === 0 ? (
            <EmptyState label="Electronics" onAdd={openNew} />
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
              <InventoryTable
                items={tableControls.paged}
                columns={columns}
                thumbnails={thumbnails}
                onEdit={(item) => { const d = details.get(item.id); if (d) openEdit(item, d); }}
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
          <SlideOverPanel
            title={panel.kind === "new" ? "New Electronics Item" : itemDraft.name}
            onClose={() => setPanel(null)}
            titleColor={ACCENT}
            titleClassName="truncate"
          >
              <BaseItemFields item={itemDraft} onChange={(p) => setItemDraft((d) => ({ ...d, ...p }))} suggestions={suggestions} />

              <hr className="border-gray-200 dark:border-darkBorder" />
              <p className={labelCls}>Electronics Details</p>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Type</label>
                  <select className={inputCls}
                    value={detailDraft.type ?? "RESISTOR"}
                    onChange={(e) => setDetailDraft((d) => ({ ...d, type: e.target.value as any }))}>
                    {ELECTRONICS_TYPES.map((t) => (
                      <option key={t} value={t}>{ELECTRONICS_ICONS[t]} {ELECTRONICS_LABELS[t]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Quantity on hand</label>
                  <input type="number" min={0} className={inputCls} placeholder="100"
                    value={detailDraft.quantity ?? ""}
                    onChange={(e) => setDetailDraft((d) => ({ ...d, quantity: parseInt(e.target.value) || null }))} />
                </div>
              </div>

              {(showValue || showPart) && (
                <div className="grid grid-cols-2 gap-2">
                  {showValue && (
                    <div>
                      <label className={labelCls}>Value</label>
                      <input type="text" className={inputCls} placeholder="10kΩ, 100µF 25V"
                        value={detailDraft.valueText ?? ""}
                        onChange={(e) => setDetailDraft((d) => ({ ...d, valueText: e.target.value }))} />
                    </div>
                  )}
                  {showPart && (
                    <div>
                      <label className={labelCls}>Part #</label>
                      <input type="text" className={inputCls} placeholder="2N3904, NE555"
                        value={detailDraft.partNumber ?? ""}
                        onChange={(e) => setDetailDraft((d) => ({ ...d, partNumber: e.target.value }))} />
                    </div>
                  )}
                </div>
              )}

              {showPackage && (
                <div>
                  <label className={labelCls}>Package</label>
                  <input type="text" className={inputCls} placeholder="THT, SMD-0805, DIP-8, TO-220"
                    value={detailDraft.packaging ?? ""}
                    onChange={(e) => setDetailDraft((d) => ({ ...d, packaging: e.target.value }))} />
                </div>
              )}

              {showElectrical && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelCls}>Voltage (V)</label>
                    <input type="number" step="0.01" className={inputCls} placeholder="25"
                      value={detailDraft.voltageRating ?? ""}
                      onChange={(e) => setDetailDraft((d) => ({ ...d, voltageRating: parseFloat(e.target.value) || null }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Current (A)</label>
                    <input type="number" step="0.001" className={inputCls} placeholder="0.2"
                      value={detailDraft.currentRatingA ?? ""}
                      onChange={(e) => setDetailDraft((d) => ({ ...d, currentRatingA: parseFloat(e.target.value) || null }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Power (W)</label>
                    <input type="number" step="0.01" className={inputCls} placeholder="0.25"
                      value={detailDraft.powerRatingW ?? ""}
                      onChange={(e) => setDetailDraft((d) => ({ ...d, powerRatingW: parseFloat(e.target.value) || null }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Tolerance (%)</label>
                    <input type="number" step="0.01" className={inputCls} placeholder="5"
                      value={detailDraft.tolerancePct ?? ""}
                      onChange={(e) => setDetailDraft((d) => ({ ...d, tolerancePct: parseFloat(e.target.value) || null }))} />
                  </div>
                </div>
              )}

              {showColor && (
                <div>
                  <label className={labelCls}>Color</label>
                  <input type="text" className={inputCls} placeholder="Red, blue, white"
                    value={detailDraft.color ?? ""}
                    onChange={(e) => setDetailDraft((d) => ({ ...d, color: e.target.value }))} />
                </div>
              )}

              <hr className="border-gray-200 dark:border-darkBorder" />
              <ImageUploader
                ref={imgRef}
                itemId={panel.kind === "edit" ? panel.item.id : undefined}
                existingKeys={(panel.kind === "edit" ? panel.item.imageKeys : []) ?? []}
              />

              <SaveButton saving={saving} onSave={handleSave} disabled={!itemDraft.name?.trim()}
                label={panel.kind === "new" ? "Create Electronics Item" : "Save"} />
              {panel.kind === "edit" && <DeleteButton saving={saving} onDelete={handleDelete} />}
          </SlideOverPanel>
        )}
      </div>
    </InventoryLayout>
  );
}
