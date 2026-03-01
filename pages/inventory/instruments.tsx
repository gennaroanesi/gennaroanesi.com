import React, { useEffect, useState, useCallback, useRef } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import InventoryLayout from "@/layouts/inventory";
import { useRouter } from "next/router";
import {
  ItemRecord, InstrumentRecord,
  INSTRUMENT_TYPES,
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
  | { kind: "edit"; item: ItemRecord; instrument: InstrumentRecord }
  | null;

const INSTRUMENT_ICONS: Record<string, string> = {
  GUITAR: "🎸", BASS: "🎸", AMPLIFIER: "🔊",
  PEDAL: "🎛️", KEYBOARD: "🎹", OTHER: "🎵",
};

export default function InstrumentsPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [items,           setItems]           = useState<ItemRecord[]>([]);
  const [details,         setDetails]         = useState<Map<string, InstrumentRecord>>(new Map());
  const [loading,         setLoading]         = useState(true);
  const [saving,          setSaving]          = useState(false);
  const [panel,           setPanel]           = useState<PanelState>(null);
  const [itemDraft,       setItemDraft]       = useState<Partial<ItemRecord>>({});
  const [instrumentDraft, setInstrumentDraft] = useState<Partial<InstrumentRecord>>({});
  const imgRef = useRef<ImageUploaderHandle>(null);
  const suggestions = useSuggestions(items);
  const thumbnails  = useThumbnails(items);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: itemData }, { data: detailData }] = await Promise.all([
        client.models.inventoryItem.list({ filter: { category: { eq: "INSTRUMENT" } }, limit: 500 }),
        client.models.inventoryInstrument.list({ limit: 500 }),
      ]);
      setItems(itemData ?? []);
      const map = new Map<string, InstrumentRecord>();
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
    router.replace("/inventory/instruments", undefined, { shallow: true });
  }, [router.isReady, router.query.new]);

  useEffect(() => {
    if (!router.isReady || !router.query.id || items.length === 0) return;
    const item = items.find((i) => i.id === router.query.id);
    const instrument = item ? details.get(item.id) : undefined;
    if (item && instrument) openEdit(item, instrument);
  }, [router.isReady, router.query.id, items, details]);

  function openNew() {
    setItemDraft({ category: "INSTRUMENT", currency: "USD" });
    setInstrumentDraft({ type: "GUITAR" });
    setPanel({ kind: "new" });
  }

  function openEdit(item: ItemRecord, instrument: InstrumentRecord) {
    setItemDraft({ ...item });
    setInstrumentDraft({ ...instrument });
    setPanel({ kind: "edit", item, instrument });
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
          category:      "INSTRUMENT",
          datePurchased: itemDraft.datePurchased ?? null,
          vendor:        itemDraft.vendor        ?? null,
          url:           itemDraft.url           ?? null,
          pricePaid:     itemDraft.pricePaid     ?? null,
          currency:      itemDraft.currency      ?? "USD",
          notes:         itemDraft.notes         ?? null,
        });
        if (errors || !newItem) return;
        const { data: newInstrument } = await client.models.inventoryInstrument.create({
          itemId:       newItem.id,
          type:         (instrumentDraft.type ?? "OTHER") as any,
          color:        instrumentDraft.color        ?? null,
          strings:      instrumentDraft.strings      ?? null,
          tuning:       instrumentDraft.tuning        ?? null,
          bodyMaterial: instrumentDraft.bodyMaterial  ?? null,
          finish:       instrumentDraft.finish        ?? null,
        });
        const imageKeys = await imgRef.current?.commit(newItem.id) ?? [];
        if (imageKeys.length > 0) {
          await client.models.inventoryItem.update({ id: newItem.id, imageKeys });
        }
        if (newInstrument) {
          setItems((prev) => [{ ...newItem, imageKeys }, ...prev]);
          setDetails((prev) => new Map(prev).set(newItem.id, newInstrument));
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
        await client.models.inventoryInstrument.update({
          id:           panel.instrument.id,
          type:         (instrumentDraft.type ?? "OTHER") as any,
          color:        instrumentDraft.color        ?? null,
          strings:      instrumentDraft.strings      ?? null,
          tuning:       instrumentDraft.tuning        ?? null,
          bodyMaterial: instrumentDraft.bodyMaterial  ?? null,
          finish:       instrumentDraft.finish        ?? null,
        });
        const imageKeys = await imgRef.current?.commit(panel.item.id) ?? (itemDraft.imageKeys ?? []);
        await client.models.inventoryItem.update({ id: panel.item.id, imageKeys });
        const updatedItem       = { ...panel.item,       ...itemDraft, imageKeys }       as ItemRecord;
        const updatedInstrument = { ...panel.instrument, ...instrumentDraft } as InstrumentRecord;
        setItems((prev)   => prev.map((i) => i.id === updatedItem.id ? updatedItem : i));
        setDetails((prev) => new Map(prev).set(updatedItem.id, updatedInstrument));
      }
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (panel?.kind !== "edit") return;
    if (!confirm("Delete this instrument record?")) return;
    setSaving(true);
    try {
      await client.models.inventoryInstrument.delete({ id: panel.instrument.id });
      await client.models.inventoryItem.delete({ id: panel.item.id });
      setItems((prev)   => prev.filter((i) => i.id !== panel.item.id));
      setDetails((prev) => { const m = new Map(prev); m.delete(panel.item.id); return m; });
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  const columns: ColDef<ItemRecord>[] = [
    { key: "name",    label: "Name",    render: (r) => <span className="font-medium">{r.name}</span>,                                                        sortValue: (r) => r.name ?? "" },
    { key: "type",    label: "Type",    render: (r) => { const t = details.get(r.id)?.type; return t ? <span>{INSTRUMENT_ICONS[t]} {t}</span> : <span>—</span>; }, sortValue: (r) => details.get(r.id)?.type ?? "" },
    { key: "color",   label: "Color",   render: (r) => details.get(r.id)?.color ?? "—",                                                                      sortValue: (r) => details.get(r.id)?.color ?? "" },
    { key: "strings", label: "Strings", render: (r) => details.get(r.id)?.strings?.toString() ?? "—",                          mobileHidden: true,           sortValue: (r) => details.get(r.id)?.strings ?? 0 },
    { key: "tuning",  label: "Tuning",  render: (r) => details.get(r.id)?.tuning ?? "—",                                       mobileHidden: true,           sortValue: (r) => details.get(r.id)?.tuning ?? "" },
    { key: "brand",   label: "Brand",   render: (r) => r.brand ?? "—",                                                         mobileHidden: true,           sortValue: (r) => r.brand ?? "" },
    { key: "body",    label: "Body",    render: (r) => details.get(r.id)?.bodyMaterial ?? "—",                                  mobileHidden: true,           sortValue: (r) => details.get(r.id)?.bodyMaterial ?? "" },
    { key: "price",   label: "Price",   render: (r) => fmtCurrency(r.pricePaid, r.currency ?? "USD"),                           mobileHidden: true,           sortValue: (r) => r.pricePaid ?? 0 },
    { key: "date",    label: "Date",    render: (r) => fmtDate(r.datePurchased),                                                mobileHidden: true,           sortValue: (r) => r.datePurchased ?? "" },
  ];

  const tableControls = useTableControls(items, (item, key) => {
    const col = columns.find((c) => c.key === key);
    return col?.sortValue?.(item);
  });

  // ── Count by type ─────────────────────────────────────────────────────────
  const typeCounts = Array.from(details.values()).reduce((acc, inst) => {
    const key = inst.type ?? "OTHER";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const showStrings = ["GUITAR", "BASS"].includes(instrumentDraft.type ?? "");

  if (authState !== "authenticated") return null;

  return (
    <InventoryLayout>
      <div className="flex h-full">

        {/* ── Main ────────────────────────────────────────────────────── */}
        <div className="flex-1 px-3 py-4 md:px-6 md:py-6 overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-purple dark:text-rose">Instruments</h1>
            <button onClick={openNew}
              className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity">
              + Add Instrument
            </button>
          </div>

          {/* Type summary pills */}
          {Object.keys(typeCounts).length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {Object.entries(typeCounts).map(([type, count]) => (
                <span key={type}
                  className="px-3 py-1 rounded-full text-xs font-semibold"
                  style={{ backgroundColor: "#EC489922", color: "#EC4899", border: "1px solid #EC489955" }}>
                  {INSTRUMENT_ICONS[type]} {type} — {count}
                </span>
              ))}
            </div>
          )}

          {loading ? (
            <div className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</div>
          ) : items.length === 0 ? (
            <EmptyState label="Instrument" onAdd={openNew} />
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <InventoryTable
                items={tableControls.paged}
                columns={columns}
                thumbnails={thumbnails}
                onEdit={(item) => { const inst = details.get(item.id); if (inst) openEdit(item, inst); }}
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
                {panel.kind === "new" ? "New Instrument" : itemDraft.name}
              </h2>
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <BaseItemFields item={itemDraft} onChange={(p) => setItemDraft((d) => ({ ...d, ...p }))} suggestions={suggestions} />

              <hr className="border-gray-200 dark:border-gray-700" />
              <p className={labelCls}>Instrument Details</p>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Type</label>
                  <select className={inputCls}
                    value={instrumentDraft.type ?? "GUITAR"}
                    onChange={(e) => setInstrumentDraft((d) => ({ ...d, type: e.target.value as any }))}>
                    {INSTRUMENT_TYPES.map((t) => (
                      <option key={t} value={t}>{INSTRUMENT_ICONS[t]} {t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Color</label>
                  <input type="text" className={inputCls} placeholder="Sunburst"
                    value={instrumentDraft.color ?? ""}
                    onChange={(e) => setInstrumentDraft((d) => ({ ...d, color: e.target.value }))} />
                </div>
              </div>

              {showStrings && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelCls}>Strings</label>
                    <input type="number" min={1} max={12} className={inputCls} placeholder="6"
                      value={instrumentDraft.strings ?? ""}
                      onChange={(e) => setInstrumentDraft((d) => ({ ...d, strings: parseInt(e.target.value) || null }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Tuning</label>
                    <input type="text" className={inputCls} placeholder="Standard"
                      value={instrumentDraft.tuning ?? ""}
                      onChange={(e) => setInstrumentDraft((d) => ({ ...d, tuning: e.target.value }))} />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Body Material</label>
                  <input type="text" className={inputCls} placeholder="Alder"
                    value={instrumentDraft.bodyMaterial ?? ""}
                    onChange={(e) => setInstrumentDraft((d) => ({ ...d, bodyMaterial: e.target.value }))} />
                </div>
                <div>
                  <label className={labelCls}>Finish</label>
                  <input type="text" className={inputCls} placeholder="Gloss"
                    value={instrumentDraft.finish ?? ""}
                    onChange={(e) => setInstrumentDraft((d) => ({ ...d, finish: e.target.value }))} />
                </div>
              </div>

              <hr className="border-gray-200 dark:border-gray-700" />
              <ImageUploader
                ref={imgRef}
                itemId={panel.kind === "edit" ? panel.item.id : undefined}
                existingKeys={(panel.kind === "edit" ? panel.item.imageKeys : []) ?? []}
              />

              <SaveButton saving={saving} onSave={handleSave}
                label={panel.kind === "new" ? "Create Instrument" : "Save"} />
              {panel.kind === "edit" && <DeleteButton saving={saving} onDelete={handleDelete} />}
            </div>
          </div>
        )}
      </div>
    </InventoryLayout>
  );
}
