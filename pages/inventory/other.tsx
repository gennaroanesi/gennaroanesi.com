import React, { useEffect, useState, useCallback, useRef } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import InventoryLayout from "@/layouts/inventory";
import { useRouter } from "next/router";
import {
  ItemRecord,
  inputCls, labelCls,
  fmtCurrency, fmtDate,
  BaseItemFields, SaveButton, DeleteButton, EmptyState,
  ImageUploader, ImageUploaderHandle, useSuggestions,
  InventoryTable, ColDef, useThumbnails,
  useTableControls, TableControls,
} from "@/components/inventory/_shared";

const client = generateClient<Schema>();

type PanelState = { kind: "new" } | { kind: "edit"; item: ItemRecord } | null;

const COLOR = "#BCABAE";

export default function OtherPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [items,     setItems]     = useState<ItemRecord[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState(false);
  const [panel,     setPanel]     = useState<PanelState>(null);
  const [itemDraft, setItemDraft] = useState<Partial<ItemRecord>>({});
  const imgRef    = useRef<ImageUploaderHandle>(null);
  const suggestions = useSuggestions(items);
  const thumbnails  = useThumbnails(items);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.models.inventoryItem.list({
        filter: { category: { eq: "OTHER" } },
        limit: 500,
      });
      setItems(data ?? []);
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
    router.replace("/inventory/other", undefined, { shallow: true });
  }, [router.isReady, router.query.new]);

  useEffect(() => {
    if (!router.isReady || !router.query.id || items.length === 0) return;
    const item = items.find((i) => i.id === router.query.id);
    if (item) openEdit(item);
  }, [router.isReady, router.query.id, items]);

  function openNew() {
    setItemDraft({ category: "OTHER", currency: "USD" });
    setPanel({ kind: "new" });
  }

  function openEdit(item: ItemRecord) {
    setItemDraft({ ...item });
    setPanel({ kind: "edit", item });
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
          category:      "OTHER",
          datePurchased: itemDraft.datePurchased ?? null,
          vendor:        itemDraft.vendor        ?? null,
          url:           itemDraft.url           ?? null,
          pricePaid:     itemDraft.pricePaid     ?? null,
          currency:      itemDraft.currency      ?? "USD",
          notes:         itemDraft.notes         ?? null,
        });
        if (errors || !newItem) return;
        const imageKeys = await imgRef.current?.commit(newItem.id) ?? [];
        if (imageKeys.length > 0) {
          await client.models.inventoryItem.update({ id: newItem.id, imageKeys });
        }
        setItems((prev) => [{ ...newItem, imageKeys }, ...prev]);
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
        const imageKeys = await imgRef.current?.commit(panel.item.id) ?? (itemDraft.imageKeys ?? []);
        await client.models.inventoryItem.update({ id: panel.item.id, imageKeys });
        setItems((prev) => prev.map((i) =>
          i.id === panel.item.id ? { ...panel.item, ...itemDraft, imageKeys } as ItemRecord : i
        ));
      }
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (panel?.kind !== "edit") return;
    if (!confirm("Delete this item?")) return;
    setSaving(true);
    try {
      await client.models.inventoryItem.delete({ id: panel.item.id });
      setItems((prev) => prev.filter((i) => i.id !== panel.item.id));
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  const columns: ColDef<ItemRecord>[] = [
    { key: "name",  label: "Name",       render: (r) => <span className="font-medium">{r.name}</span>, sortValue: (r) => r.name ?? "" },
    { key: "brand", label: "Brand",      render: (r) => r.brand ?? "—",                                sortValue: (r) => r.brand ?? "",        mobileHidden: true },
    { key: "price", label: "Total Paid", render: (r) => fmtCurrency(r.pricePaid, r.currency ?? "USD"), sortValue: (r) => r.pricePaid ?? 0,     mobileHidden: true },
    { key: "date",  label: "Date",       render: (r) => fmtDate(r.datePurchased),                      sortValue: (r) => r.datePurchased ?? "", mobileHidden: true },
    { key: "vendor",label: "Vendor",     render: (r) => r.vendor ?? "—",                               sortValue: (r) => r.vendor ?? "",        mobileHidden: true },
  ];

  const tableControls = useTableControls(items, (item, key) => {
    const col = columns.find((c) => c.key === key);
    return col?.sortValue?.(item);
  });

  if (authState !== "authenticated") return null;

  return (
    <InventoryLayout>
      <div className="flex h-full">

        {/* ── Main ────────────────────────────────────────────────────── */}
        <div className="flex-1 px-3 py-4 md:px-6 md:py-6 overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-purple dark:text-rose">Other</h1>
            <button onClick={openNew}
              className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity">
              + Add Item
            </button>
          </div>

          {loading ? (
            <div className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</div>
          ) : items.length === 0 ? (
            <EmptyState label="Other" onAdd={openNew} />
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <InventoryTable
                items={tableControls.paged}
                columns={columns}
                thumbnails={thumbnails}
                onEdit={openEdit}
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
                {panel.kind === "new" ? "New Item" : itemDraft.name}
              </h2>
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <BaseItemFields
                item={itemDraft}
                onChange={(p) => setItemDraft((d) => ({ ...d, ...p }))}
                suggestions={suggestions}
              />

              <hr className="border-gray-200 dark:border-gray-700" />
              <ImageUploader
                ref={imgRef}
                itemId={panel.kind === "edit" ? panel.item.id : undefined}
                existingKeys={(panel.kind === "edit" ? panel.item.imageKeys : []) ?? []}
              />

              <SaveButton saving={saving} onSave={handleSave}
                label={panel.kind === "new" ? "Create Item" : "Save"} />
              {panel.kind === "edit" && <DeleteButton saving={saving} onDelete={handleDelete} />}
            </div>
          </div>
        )}
      </div>
    </InventoryLayout>
  );
}
