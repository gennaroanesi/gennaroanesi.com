import React, { useEffect, useState, useCallback, useRef, useId } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import InventoryLayout from "@/layouts/inventory";
import { useRouter } from "next/router";
import {
  ItemRecord, AmmoRecord,
  AMMO_UNITS,
  inputCls, labelCls, CaliberInput,
  fmtCurrency, fmtDate,
  BaseItemFields, SaveButton, DeleteButton, EmptyState,
  ImageUploader, ImageUploaderHandle,
  InventoryTable, ColDef, useThumbnails, useSuggestions,
  useTableControls, TableControls,
} from "@/components/inventory/_shared";

const client = generateClient<Schema>();

const AMMO_COLOR = "#B8940A";

type PanelState =
  | { kind: "new" }
  | { kind: "edit"; item: ItemRecord; ammo: AmmoRecord }
  | { kind: "loguse" }
  | null;

// One line in the Log Use session
type LogEntry = {
  id:     string;        // uuid key for React
  itemId: string;        // inventoryItem.id
  rounds: number | "";
};

type LogResult = {
  id:      string;
  name:    string;
  caliber: string;
  rounds:  number;
  ok:      boolean;
  shortfall: number;
};

// ── Direct consume helper ────────────────────────────────────────────────────
// Deducts `roundsToConsume` directly from a single specific ammo record.
async function directConsume(
  targetItemId: string,
  roundsToConsume: number,
  details: Map<string, AmmoRecord>,
): Promise<{ updatedDetails: Map<string, AmmoRecord>; consumed: number; shortfall: number }> {
  const ammo = details.get(targetItemId);
  if (!ammo) return { updatedDetails: details, consumed: 0, shortfall: roundsToConsume };

  const available = ammo.roundsAvailable ?? 0;
  const take      = Math.min(available, roundsToConsume);
  const newAvail  = available - take;
  const shortfall = roundsToConsume - take;

  await client.models.inventoryAmmo.update({ id: ammo.id, roundsAvailable: newAvail });

  const updatedDetails = new Map(details);
  updatedDetails.set(targetItemId, { ...ammo, roundsAvailable: newAvail });

  return { updatedDetails, consumed: take, shortfall };
}

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

  // Log Use state — multi-row session
  const [logEntries,  setLogEntries]  = useState<LogEntry[]>([]);
  const [logResults,  setLogResults]  = useState<LogResult[]>([]);

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

  function newLogEntry(itemId = ""): LogEntry {
    return { id: Math.random().toString(36).slice(2), itemId, rounds: "" };
  }

  function openLogUse(itemId?: string) {
    setLogEntries([newLogEntry(itemId ?? "")]);
    setLogResults([]);
    setPanel({ kind: "loguse" });
  }

  // ── Computed total rounds per caliber ─────────────────────────────────────
  // available = roundsAvailable if set, else fall back to total purchased
  function totalRoundsForRecord(ammo: AmmoRecord) {
    return (ammo.quantity ?? 0) * (ammo.roundsPerUnit ?? 1);
  }

  async function handleSave() {
    if (!itemDraft.name?.trim()) return;
    if (!ammoDraft.caliber?.trim()) return;
    setSaving(true);
    try {
      const totalRounds = (ammoDraft.quantity ?? 0) * (ammoDraft.roundsPerUnit ?? 1);

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
          itemId:          newItem.id,
          caliber:         ammoDraft.caliber!,
          quantity:        ammoDraft.quantity      ?? 0,
          unit:            (ammoDraft.unit ?? "ROUNDS") as any,
          roundsPerUnit:   ammoDraft.roundsPerUnit ?? null,
          grain:           ammoDraft.grain         ?? null,
          bulletType:      ammoDraft.bulletType    ?? null,
          velocityFps:     ammoDraft.velocityFps   ?? null,
          roundsAvailable: totalRounds,             // auto-populate on create
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
        // If quantity/roundsPerUnit changed, adjust roundsAvailable proportionally
        const prevAmmo = panel.ammo;
        const prevTotal = totalRoundsForRecord(prevAmmo);
        const prevAvail = prevAmmo.roundsAvailable ?? prevTotal;
        const consumed  = prevTotal - prevAvail;
        const newAvail  = Math.max(0, totalRounds - consumed);

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
          id:              panel.ammo.id,
          caliber:         ammoDraft.caliber!,
          quantity:        ammoDraft.quantity      ?? 0,
          unit:            (ammoDraft.unit ?? "ROUNDS") as any,
          roundsPerUnit:   ammoDraft.roundsPerUnit ?? null,
          grain:           ammoDraft.grain         ?? null,
          bulletType:      ammoDraft.bulletType    ?? null,
          velocityFps:     ammoDraft.velocityFps   ?? null,
          roundsAvailable: newAvail,
        });
        const imageKeys = await imgRef.current?.commit(panel.item.id) ?? (itemDraft.imageKeys ?? []);
        await client.models.inventoryItem.update({ id: panel.item.id, imageKeys });
        const updatedItem = { ...panel.item, ...itemDraft, imageKeys } as ItemRecord;
        const updatedAmmo = { ...panel.ammo, ...ammoDraft, roundsAvailable: newAvail } as AmmoRecord;
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

  async function handleLogUse() {
    const valid = logEntries.filter((e) => e.itemId && typeof e.rounds === "number" && e.rounds > 0);
    if (valid.length === 0) return;
    setSaving(true);
    setLogResults([]);
    let currentDetails = details;
    const results: LogResult[] = [];
    try {
      for (const entry of valid) {
        const item   = items.find((i) => i.id === entry.itemId);
        const ammo   = currentDetails.get(entry.itemId);
        const name   = [item?.name, item?.brand].filter(Boolean).join(" · ") || "Unknown";
        const caliber = ammo?.caliber ?? "?";
        const { updatedDetails, consumed, shortfall } = await directConsume(
          entry.itemId, entry.rounds as number, currentDetails,
        );
        currentDetails = updatedDetails;
        results.push({ id: entry.id, name, caliber, rounds: entry.rounds as number, consumed, shortfall, ok: shortfall === 0 } as any);
      }
      setDetails(currentDetails);
      setLogResults(results);
      setLogEntries((prev) => prev.map((e) => ({ ...e, rounds: "" })));
    } finally {
      setSaving(false);
    }
  }

  const thumbnails = useThumbnails(items);
  const suggestions = useSuggestions(items);

  // ── Ammo records sorted for Log Use picker ───────────────────────────────
  const logPickerOptions = items
    .map((it) => ({ item: it, ammo: details.get(it.id) }))
    .filter(({ ammo }) => ammo != null)
    .sort((a, b) => {
      const calA = a.ammo!.caliber ?? "";
      const calB = b.ammo!.caliber ?? "";
      if (calA !== calB) return calA.localeCompare(calB);
      return (a.item.name ?? "").localeCompare(b.item.name ?? "");
    }) as { item: ItemRecord; ammo: AmmoRecord }[];

  function openLogUseFromPill(caliber: string) {
    const matches = logPickerOptions.filter(({ ammo }) => ammo.caliber === caliber);
    setLogEntries(
      matches.length > 0
        ? matches.map(({ item }) => newLogEntry(item.id))
        : [newLogEntry()]
    );
    setLogResults([]);
    setPanel({ kind: "loguse" });
  }

  // ── Columns ───────────────────────────────────────────────────────────────
  const columns: ColDef<ItemRecord>[] = [
    {
      key: "name", label: "Name",
      render: (r) => <span className="font-medium">{r.name}</span>,
      sortValue: (r) => r.name ?? "",
    },
    {
      key: "caliber", label: "Caliber",
      render: (r) => details.get(r.id)?.caliber ?? "—",
      sortValue: (r) => details.get(r.id)?.caliber ?? "",
    },
    {
      key: "available", label: "Available",
      render: (r) => {
        const am = details.get(r.id);
        if (!am) return "—";
        const total = totalRoundsForRecord(am);
        const avail = am.roundsAvailable ?? total;
        const pct   = total > 0 ? avail / total : 1;
        const color = pct > 0.5 ? "#22c55e" : pct > 0.2 ? "#f59e0b" : "#ef4444";
        return (
          <span className="flex items-center gap-1.5">
            <span style={{ color }} className="font-semibold tabular-nums">
              {avail.toLocaleString()}
            </span>
            <span className="text-gray-400 text-xs">/ {total.toLocaleString()} rds</span>
          </span>
        );
      },
      sortValue: (r) => {
        const am = details.get(r.id);
        return am ? (am.roundsAvailable ?? totalRoundsForRecord(am)) : 0;
      },
    },
    {
      key: "brand", label: "Brand",
      render: (r) => r.brand ?? "—",
      mobileHidden: true,
      sortValue: (r) => r.brand ?? "",
    },
    {
      key: "grain", label: "Grain",
      render: (r) => { const g = details.get(r.id)?.grain; return g ? `${g} gr` : "—"; },
      mobileHidden: true,
      sortValue: (r) => details.get(r.id)?.grain ?? 0,
    },
    {
      key: "type", label: "Bullet Type",
      render: (r) => details.get(r.id)?.bulletType ?? "—",
      mobileHidden: true,
      sortValue: (r) => details.get(r.id)?.bulletType ?? "",
    },
    {
      key: "vel", label: "Vel (fps)",
      render: (r) => details.get(r.id)?.velocityFps?.toString() ?? "—",
      mobileHidden: true,
      sortValue: (r) => details.get(r.id)?.velocityFps ?? 0,
    },
    {
      key: "price", label: "Total Paid",
      render: (r) => fmtCurrency(r.pricePaid, r.currency ?? "USD"),
      mobileHidden: true,
      sortValue: (r) => r.pricePaid ?? 0,
    },
    {
      key: "date", label: "Date",
      render: (r) => fmtDate(r.datePurchased),
      mobileHidden: true,
      sortValue: (r) => r.datePurchased ?? "",
    },
  ];

  const tableControls = useTableControls(items, (item, key) => {
    const col = columns.find((c) => c.key === key);
    return col?.sortValue?.(item);
  });

  // ── Totals by caliber (available) ─────────────────────────────────────────
  const caliberTotals = Array.from(details.values()).reduce((acc, a) => {
    const key   = a.caliber ?? "Unknown";
    const total = totalRoundsForRecord(a);
    const avail = a.roundsAvailable ?? total;
    if (!acc[key]) acc[key] = { available: 0, total: 0 };
    acc[key].available += avail;
    acc[key].total     += total;
    return acc;
  }, {} as Record<string, { available: number; total: number }>);

  if (authState !== "authenticated") return null;

  return (
    <InventoryLayout>
      <div className="flex h-full">

        {/* ── Main ────────────────────────────────────────────────────── */}
        <div className="flex-1 px-3 py-4 md:px-6 md:py-6 overflow-auto">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-purple dark:text-rose">Ammunition</h1>
            <div className="flex gap-2">
              <button onClick={() => openLogUse()}
                className="px-4 py-2 rounded text-sm font-semibold border transition-colors"
                style={{ borderColor: AMMO_COLOR + "88", color: AMMO_COLOR, backgroundColor: AMMO_COLOR + "18" }}>
                Log Use
              </button>
              <button onClick={openNew}
                className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity">
                + Add Ammo
              </button>
            </div>
          </div>

          {/* Caliber summary pills */}
          {Object.keys(caliberTotals).length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {Object.entries(caliberTotals)
                .sort((a, b) => b[1].available - a[1].available)
                .map(([cal, { available, total }]) => {
                  const pct = total > 0 ? available / total : 1;
                  const pillColor = pct > 0.5 ? AMMO_COLOR : pct > 0.2 ? "#f59e0b" : "#ef4444";
                  return (
                    <button
                      key={cal}
                      onClick={() => openLogUseFromPill(cal)}
                      className="px-3 py-1 rounded-full text-xs font-semibold transition-opacity hover:opacity-80 cursor-pointer"
                      style={{ backgroundColor: pillColor + "22", color: pillColor, border: `1px solid ${pillColor}55` }}
                      title="Click to log use"
                    >
                      {cal} — {available.toLocaleString()} / {total.toLocaleString()} rds
                    </button>
                  );
                })}
            </div>
          )}

          {loading ? (
            <div className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</div>
          ) : items.length === 0 ? (
            <EmptyState label="Ammo" onAdd={openNew} />
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <InventoryTable
                items={tableControls.paged}
                columns={columns}
                thumbnails={thumbnails}
                onEdit={(item) => { const am = details.get(item.id); if (am) openEdit(item, am); }}
                onDelete={handleDeleteItem}
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

            {/* ── Log Use panel ─────────────────────────────────────── */}
            {panel.kind === "loguse" && (
              <>
                <div className="flex items-center justify-between px-6 py-4 border-b dark:border-gray-700 flex-shrink-0">
                  <h2 className="text-base font-semibold dark:text-rose text-purple">Log Ammo Use</h2>
                  <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-3">
                  <p className="text-xs text-gray-400">
                    Add one row per ammo type used. Rounds are deducted directly from the selected record.
                  </p>

                  {/* Column headers */}
                  <div className="grid grid-cols-[1fr_80px_24px] gap-2 items-center">
                    <span className="text-[10px] uppercase tracking-widest text-gray-400">Ammo (name · brand · caliber)</span>
                    <span className="text-[10px] uppercase tracking-widest text-gray-400 text-right">Rounds</span>
                    <span />
                  </div>

                  {/* Entry rows */}
                  {logEntries.map((entry, idx) => {
                    const sel = logPickerOptions.find((o) => o.item.id === entry.itemId);
                    const avail = sel ? (sel.ammo.roundsAvailable ?? totalRoundsForRecord(sel.ammo)) : null;
                    return (
                      <div key={entry.id} className="grid grid-cols-[1fr_80px_24px] gap-2 items-start">
                        {/* Ammo typeahead */}
                        <AmmoTypeahead
                          value={entry.itemId}
                          options={logPickerOptions}
                          totalRoundsForRecord={totalRoundsForRecord}
                          onChange={(itemId) => {
                            setLogResults([]);
                            setLogEntries((prev) => prev.map((r) =>
                              r.id === entry.id ? { ...r, itemId } : r
                            ));
                          }}
                        />

                        {/* Rounds input */}
                        <input
                          type="number"
                          min={1}
                          className={`${inputCls} text-right`}
                          placeholder="0"
                          value={entry.rounds}
                          onChange={(e) => {
                            setLogResults([]);
                            setLogEntries((prev) => prev.map((r) =>
                              r.id === entry.id ? { ...r, rounds: parseInt(e.target.value) || "" } : r
                            ));
                          }}
                        />

                        {/* Remove row */}
                        <button
                          onClick={() => setLogEntries((prev) => prev.filter((r) => r.id !== entry.id))}
                          disabled={logEntries.length === 1}
                          className="mt-1 text-gray-300 hover:text-red-400 disabled:opacity-0 transition-colors text-lg leading-none"
                        >×</button>
                      </div>
                    );
                  })}

                  {/* Add row */}
                  <button
                    onClick={() => setLogEntries((prev) => [...prev, newLogEntry()])}
                    className="self-start text-xs font-medium transition-colors hover:opacity-80"
                    style={{ color: AMMO_COLOR }}
                  >
                    + Add row
                  </button>

                  {/* Results table */}
                  {logResults.length > 0 && (
                    <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50 dark:bg-darkPurple border-b border-gray-200 dark:border-gray-700">
                          <tr>
                            <th className="px-3 py-1.5 text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium">Ammo</th>
                            <th className="px-3 py-1.5 text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium">Caliber</th>
                            <th className="px-3 py-1.5 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium">Used</th>
                            <th className="px-3 py-1.5 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                          {logResults.map((r) => (
                            <tr key={r.id} className={r.ok ? "" : "bg-amber-50/50 dark:bg-amber-900/10"}>
                              <td className="px-3 py-1.5 text-gray-700 dark:text-gray-300 max-w-[120px] truncate" title={r.name}>{r.name}</td>
                              <td className="px-3 py-1.5 text-gray-500 dark:text-gray-400 whitespace-nowrap">{r.caliber}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">{r.rounds.toLocaleString()} rds</td>
                              <td className="px-3 py-1.5 text-right whitespace-nowrap">
                                {r.ok
                                  ? <span className="text-green-600 dark:text-green-400">✓</span>
                                  : <span className="text-amber-600 dark:text-amber-400">⚠ {r.shortfall.toLocaleString()} short</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <button
                    onClick={handleLogUse}
                    disabled={saving || logEntries.every((e) => !e.itemId || !e.rounds)}
                    className="w-full py-2 rounded text-sm font-semibold disabled:opacity-50 transition-opacity hover:opacity-90"
                    style={{ backgroundColor: AMMO_COLOR, color: "#fff" }}
                  >
                    {saving ? "Saving…" : `Log Use${logEntries.filter((e) => e.itemId && e.rounds).length > 1 ? ` (${logEntries.filter((e) => e.itemId && e.rounds).length} types)` : ""}`}
                  </button>
                </div>
              </>
            )}

            {/* ── New / Edit panel ──────────────────────────────────── */}
            {(panel.kind === "new" || panel.kind === "edit") && (
              <>
                <div className="flex items-center justify-between px-6 py-4 border-b dark:border-gray-700 flex-shrink-0">
                  <h2 className="text-base font-semibold dark:text-rose text-purple truncate">
                    {panel.kind === "new" ? "New Ammo" : itemDraft.name}
                  </h2>
                  <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
                  <BaseItemFields item={itemDraft} onChange={(p) => setItemDraft((d) => ({ ...d, ...p }))} suggestions={suggestions} />

                  <hr className="border-gray-200 dark:border-gray-700" />
                  <p className={labelCls}>Ammo Details</p>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>Caliber *</label>
                      <CaliberInput
                        value={ammoDraft.caliber ?? ""}
                        onChange={(v) => setAmmoDraft((d) => ({ ...d, caliber: v }))}
                        required
                      />
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

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>Quantity</label>
                      <input type="number" min={0} className={inputCls} placeholder="2"
                        value={ammoDraft.quantity ?? ""}
                        onChange={(e) => setAmmoDraft((d) => ({ ...d, quantity: parseInt(e.target.value) || 0 }))} />
                    </div>
                    <div>
                      <label className={labelCls}>Rounds / Unit</label>
                      <input type="number" min={1} className={inputCls}
                        placeholder={ammoDraft.unit === "ROUNDS" ? "1" : "20"}
                        value={ammoDraft.roundsPerUnit ?? ""}
                        onChange={(e) => setAmmoDraft((d) => ({ ...d, roundsPerUnit: parseInt(e.target.value) || null }))} />
                    </div>
                  </div>

                  {/* Edit mode: show roundsAvailable override */}
                  {panel.kind === "edit" && (() => {
                    const total = (ammoDraft.quantity ?? 0) * (ammoDraft.roundsPerUnit ?? 1);
                    const avail = ammoDraft.roundsAvailable ?? total;
                    return total > 0 ? (
                      <div>
                        <label className={labelCls}>Rounds Available</label>
                        <input type="number" min={0} max={total} className={inputCls}
                          value={avail}
                          onChange={(e) => setAmmoDraft((d) => ({ ...d, roundsAvailable: parseInt(e.target.value) || 0 }))} />
                        <p className="text-[11px] text-gray-400 mt-0.5">
                          Manual override · Total purchased: {total.toLocaleString()} rds
                        </p>
                      </div>
                    ) : null;
                  })()}

                  {(() => {
                    const qty = ammoDraft.quantity ?? 0;
                    const rpu = ammoDraft.roundsPerUnit ?? 1;
                    const totalRounds = qty * rpu;
                    const totalCost = itemDraft.pricePaid ?? 0;
                    const costPerUnit = qty > 0 ? totalCost / qty : 0;
                    if (qty === 0) return null;
                    return (
                      <div className="text-xs text-gray-400 -mt-2 flex flex-col gap-0.5">
                        {panel.kind === "new" && (
                          <span>Total rounds: <strong className="text-gray-600 dark:text-gray-300">{totalRounds.toLocaleString()}</strong></span>
                        )}
                        {costPerUnit > 0 && (
                          <span>Cost / unit: <strong className="text-gray-600 dark:text-gray-300">{fmtCurrency(costPerUnit, itemDraft.currency ?? "USD")}</strong></span>
                        )}
                        {totalRounds > 0 && totalCost > 0 && (
                          <span>Cost / round: <strong className="text-gray-600 dark:text-gray-300">{fmtCurrency(totalCost / totalRounds, itemDraft.currency ?? "USD")}</strong></span>
                        )}
                      </div>
                    );
                  })()}

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
              </>
            )}
          </div>
        )}
      </div>
    </InventoryLayout>
  );
}

// ── AmmoTypeahead ─────────────────────────────────────────────────────────────
// Combobox that filters ammo records as the user types.

function AmmoTypeahead({
  value,
  options,
  totalRoundsForRecord,
  onChange,
}: {
  value: string;
  options: { item: ItemRecord; ammo: AmmoRecord }[];
  totalRoundsForRecord: (ammo: AmmoRecord) => number;
  onChange: (itemId: string) => void;
}) {
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef  = useRef<HTMLUListElement>(null);

  // Derive display text from current value
  const selected = options.find((o) => o.item.id === value);
  const selectedLabel = selected
    ? [selected.item.name, selected.item.brand, selected.ammo.caliber].filter(Boolean).join(" · ")
    : "";

  const [query,    setQuery]    = useState(selectedLabel);
  const [open,     setOpen]     = useState(false);
  const [hiIdx,    setHiIdx]    = useState(0);

  // Keep query in sync when value changes externally (e.g. pill pre-fill)
  useEffect(() => { setQuery(selectedLabel); }, [selectedLabel]);

  const filtered = query.trim() === ""
    ? options
    : options.filter(({ item, ammo }) => {
        const hay = [item.name, item.brand, ammo.caliber].filter(Boolean).join(" ").toLowerCase();
        return query.toLowerCase().split(/\s+/).every((tok) => hay.includes(tok));
      });

  function selectOption(opt: { item: ItemRecord; ammo: AmmoRecord }) {
    const label = [opt.item.name, opt.item.brand, opt.ammo.caliber].filter(Boolean).join(" · ");
    setQuery(label);
    setOpen(false);
    onChange(opt.item.id);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) { setOpen(true); return; }
    if (e.key === "ArrowDown") { setHiIdx((i) => Math.min(i + 1, filtered.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { setHiIdx((i) => Math.max(i - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter") { if (filtered[hiIdx]) selectOption(filtered[hiIdx]); e.preventDefault(); }
    else if (e.key === "Escape") { setOpen(false); setQuery(selectedLabel); }
  }

  const avail = selected
    ? (selected.ammo.roundsAvailable ?? totalRoundsForRecord(selected.ammo))
    : null;

  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={uid}
        type="text"
        autoComplete="off"
        className={inputCls}
        placeholder="Type to search…"
        value={query}
        onFocus={() => { setOpen(true); setHiIdx(0); }}
        onBlur={(e) => {
          // Delay so click on list item registers first
          setTimeout(() => {
            if (!listRef.current?.contains(document.activeElement)) {
              setOpen(false);
              // If user blurs without selecting, restore previous label
              if (!options.find((o) => o.item.id === value)) setQuery("");
              else setQuery(selectedLabel);
            }
          }, 150);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHiIdx(0);
          if (e.target.value === "") onChange("");
        }}
        onKeyDown={handleKeyDown}
      />

      {avail !== null && (
        <span className="block text-[10px] text-gray-400 pl-0.5 mt-0.5">
          {avail.toLocaleString()} rds available
        </span>
      )}

      {open && filtered.length > 0 && (
        <ul
          ref={listRef}
          className="absolute z-50 w-full mt-0.5 max-h-48 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-darkPurple shadow-lg text-sm"
        >
          {filtered.map((opt, idx) => {
            const label   = [opt.item.name, opt.item.brand].filter(Boolean).join(" · ");
            const avail   = opt.ammo.roundsAvailable ?? totalRoundsForRecord(opt.ammo);
            const isHi    = idx === hiIdx;
            return (
              <li
                key={opt.item.id}
                onMouseDown={() => selectOption(opt)}
                onMouseEnter={() => setHiIdx(idx)}
                className={[
                  "flex items-center justify-between gap-2 px-3 py-1.5 cursor-pointer transition-colors",
                  isHi ? "bg-gray-100 dark:bg-white/10" : "hover:bg-gray-50 dark:hover:bg-white/5",
                ].join(" ")}
              >
                <span className="flex flex-col min-w-0">
                  <span className="truncate text-gray-800 dark:text-gray-200 font-medium">{label}</span>
                  <span className="text-[10px] text-gray-400 truncate">{opt.ammo.caliber}</span>
                </span>
                <span className="text-[10px] tabular-nums whitespace-nowrap text-gray-400 flex-shrink-0">
                  {avail.toLocaleString()} rds
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
