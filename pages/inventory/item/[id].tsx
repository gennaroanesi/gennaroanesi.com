import React, { useEffect, useState, useCallback } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import InventoryLayout from "@/layouts/inventory";
import { useRouter } from "next/router";
import NextLink from "next/link";
import {
  ItemRecord, FirearmRecord, AmmoRecord, FilamentRecord, InstrumentRecord,
  CATEGORY_CONFIG, Category,
  fmtCurrency, fmtDate,
  labelCls, tdCls,
  CategoryBadge,
  resolveAllUrls,
} from "../_shared";

const client = generateClient<Schema>();

type Detail =
  | { kind: "FIREARM";    data: FirearmRecord }
  | { kind: "AMMO";       data: AmmoRecord }
  | { kind: "FILAMENT";   data: FilamentRecord }
  | { kind: "INSTRUMENT"; data: InstrumentRecord }
  | { kind: "OTHER" }
  | null;

export default function ItemDetailPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();
  const id = router.query.id as string | undefined;

  const [item,    setItem]    = useState<ItemRecord | null>(null);
  const [detail,  setDetail]  = useState<Detail>(null);
  const [photos,  setPhotos]  = useState<string[]>([]);
  const [photoIdx, setPhotoIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const fetchData = useCallback(async (itemId: string) => {
    setLoading(true);
    try {
      const { data: it } = await client.models.inventoryItem.get({ id: itemId });
      if (!it) { setNotFound(true); return; }
      setItem(it);

      // Resolve photos
      if (it.imageKeys && it.imageKeys.length > 0) {
        const urls = await resolveAllUrls(it.imageKeys.filter(Boolean) as string[]);
        setPhotos(urls.filter(Boolean));
      }

      // Fetch category-specific detail
      const cat = it.category as Category;
      if (cat === "FIREARM") {
        const { data } = await client.models.inventoryFirearm.list({
          filter: { itemId: { eq: itemId } }, limit: 1,
        });
        setDetail(data?.[0] ? { kind: "FIREARM", data: data[0] } : { kind: "OTHER" });
      } else if (cat === "AMMO") {
        const { data } = await client.models.inventoryAmmo.list({
          filter: { itemId: { eq: itemId } }, limit: 1,
        });
        setDetail(data?.[0] ? { kind: "AMMO", data: data[0] } : { kind: "OTHER" });
      } else if (cat === "FILAMENT") {
        const { data } = await client.models.inventoryFilament.list({
          filter: { itemId: { eq: itemId } }, limit: 1,
        });
        setDetail(data?.[0] ? { kind: "FILAMENT", data: data[0] } : { kind: "OTHER" });
      } else if (cat === "INSTRUMENT") {
        const { data } = await client.models.inventoryInstrument.list({
          filter: { itemId: { eq: itemId } }, limit: 1,
        });
        setDetail(data?.[0] ? { kind: "INSTRUMENT", data: data[0] } : { kind: "OTHER" });
      } else {
        setDetail({ kind: "OTHER" });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated" || !id) return;
    fetchData(id);
  }, [authState, id, fetchData]);

  if (authState !== "authenticated") return null;

  const cfg = item ? (CATEGORY_CONFIG[item.category as Category] ?? CATEGORY_CONFIG.OTHER) : null;

  return (
    <InventoryLayout>
      <div className="px-6 py-6 overflow-auto h-full max-w-3xl">

        {/* Back link */}
        <div className="mb-4">
          <NextLink
            href={cfg ? cfg.href : "/inventory"}
            className="text-xs uppercase tracking-widest text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
          >
            ← Back
          </NextLink>
        </div>

        {loading ? (
          <div className="text-sm text-gray-400 animate-pulse py-24 text-center">Loading…</div>
        ) : notFound ? (
          <div className="py-24 text-center text-gray-400">
            <p className="text-sm">Item not found.</p>
            <NextLink href="/inventory" className="text-xs underline mt-2 inline-block">← Inventory</NextLink>
          </div>
        ) : item ? (
          <div className="flex flex-col gap-6">

            {/* ── Header ─────────────────────────────────────────────── */}
            <div className="flex items-start gap-4">
              {photos.length > 0 ? (
                <div className="flex-shrink-0 w-24 h-24 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                  <img src={photos[photoIdx]} alt={item.name} className="w-full h-full object-cover" />
                </div>
              ) : (
                <div className="flex-shrink-0 w-24 h-24 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center border border-gray-200 dark:border-gray-700">
                  <span className="text-3xl">📷</span>
                </div>
              )}
              <div className="flex flex-col gap-1 min-w-0">
                <CategoryBadge category={item.category ?? "OTHER"} />
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100 leading-tight">{item.name}</h1>
                {item.brand && <p className="text-sm text-gray-500 dark:text-gray-400">{item.brand}</p>}
              </div>
            </div>

            {/* ── Photo gallery ───────────────────────────────────────── */}
            {photos.length > 1 && (
              <div className="flex gap-2 flex-wrap">
                {photos.map((url, i) => (
                  <button key={i} onClick={() => setPhotoIdx(i)}
                    className={[
                      "w-16 h-16 rounded-md overflow-hidden border-2 transition-all",
                      i === photoIdx
                        ? "border-purple dark:border-rose"
                        : "border-transparent opacity-60 hover:opacity-100",
                    ].join(" ")}>
                    <img src={url} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}

            {/* ── Base fields ─────────────────────────────────────────── */}
            <Section title="Purchase Info">
              <Row label="Total Paid"    value={fmtCurrency(item.pricePaid, item.currency ?? "USD")} />
              <Row label="Date Purchased" value={fmtDate(item.datePurchased)} />
              <Row label="Vendor"        value={item.vendor} />
              {item.url && (
                <tr>
                  <td className={`${tdCls} text-gray-400 text-xs uppercase tracking-widest w-36`}>Link</td>
                  <td className={tdCls}>
                    <a href={item.url} target="_blank" rel="noopener noreferrer"
                      className="text-sm underline text-purple dark:text-rose truncate block max-w-xs">
                      {item.url}
                    </a>
                  </td>
                </tr>
              )}
            </Section>

            {item.description && (
              <Section title="Description">
                <tr><td colSpan={2} className={tdCls}>{item.description}</td></tr>
              </Section>
            )}

            {/* ── Category detail ─────────────────────────────────────── */}
            {detail?.kind === "FIREARM" && <FirearmDetail data={detail.data} />}
            {detail?.kind === "AMMO"    && <AmmoDetail    data={detail.data} totalPaid={item.pricePaid} currency={item.currency ?? "USD"} />}
            {detail?.kind === "FILAMENT"   && <FilamentDetail   data={detail.data} />}
            {detail?.kind === "INSTRUMENT" && <InstrumentDetail data={detail.data} />}

            {item.notes && (
              <Section title="Notes">
                <tr><td colSpan={2} className={`${tdCls} whitespace-pre-wrap`}>{item.notes}</td></tr>
              </Section>
            )}

            {/* ── Edit link ───────────────────────────────────────────── */}
            <div>
              <NextLink
                href={`${cfg?.href ?? "/inventory"}?id=${item.id}`}
                className="inline-block px-4 py-2 rounded text-sm font-semibold border transition-colors"
                style={{ borderColor: cfg?.color + "88", color: cfg?.color, backgroundColor: cfg?.color + "18" }}
              >
                Edit this item →
              </NextLink>
            </div>

          </div>
        ) : null}
      </div>
    </InventoryLayout>
  );
}

// ── Layout helpers ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className={`${labelCls} mb-2`}>{title}</p>
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <table className="w-full">
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {children}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <tr>
      <td className={`${tdCls} text-gray-400 text-xs uppercase tracking-widest w-36`}>{label}</td>
      <td className={`${tdCls} font-medium`}>{value ?? "—"}</td>
    </tr>
  );
}

// ── Category detail sections ──────────────────────────────────────────────────

function FirearmDetail({ data }: { data: FirearmRecord }) {
  const parts = (data.parts ?? []) as { name: string; brand?: string | null; installedDate?: string | null; notes?: string | null }[];
  return (
    <>
      <Section title="Firearm Details">
        <Row label="Type"          value={data.type} />
        <Row label="Caliber"       value={data.caliber} />
        <Row label="Serial #"      value={data.serialNumber} />
        <Row label="Action"        value={data.action} />
        <Row label="Barrel Length" value={data.barrelLength} />
        <Row label="Finish"        value={data.finish} />
      </Section>
      {parts.length > 0 && (
        <Section title="Parts / Accessories">
          {parts.map((p, i) => (
            <tr key={i}>
              <td className={`${tdCls} text-gray-400 text-xs uppercase tracking-widest w-36`}>{p.name}</td>
              <td className={tdCls}>
                <span className="font-medium">{p.brand ?? ""}</span>
                {p.installedDate && <span className="text-gray-400 ml-2 text-xs">installed {fmtDate(p.installedDate)}</span>}
                {p.notes && <span className="text-gray-400 ml-2 text-xs">· {p.notes}</span>}
              </td>
            </tr>
          ))}
        </Section>
      )}
    </>
  );
}

function AmmoDetail({ data, totalPaid, currency }: { data: AmmoRecord; totalPaid?: number | null; currency: string }) {
  const totalRounds = (data.quantity ?? 0) * (data.roundsPerUnit ?? 1);
  const costPerRound = totalRounds > 0 && totalPaid ? totalPaid / totalRounds : null;
  const costPerUnit  = (data.quantity ?? 0) > 0 && totalPaid ? totalPaid / (data.quantity ?? 1) : null;
  return (
    <Section title="Ammo Details">
      <Row label="Caliber"        value={data.caliber} />
      <Row label="Quantity"       value={data.quantity?.toLocaleString()} />
      <Row label="Unit"           value={data.unit} />
      <Row label="Rounds / Unit"  value={data.roundsPerUnit?.toLocaleString() ?? "—"} />
      <Row label="Total Rounds"   value={totalRounds > 0 ? `${totalRounds.toLocaleString()} rds` : "—"} />
      {costPerUnit  != null && <Row label="Cost / Unit"  value={fmtCurrency(costPerUnit,  currency)} />}
      {costPerRound != null && <Row label="Cost / Round" value={fmtCurrency(costPerRound, currency)} />}
      <Row label="Grain"          value={data.grain ? `${data.grain} gr` : undefined} />
      <Row label="Bullet Type"    value={data.bulletType} />
      <Row label="Velocity"       value={data.velocityFps ? `${data.velocityFps} fps` : undefined} />
    </Section>
  );
}

function FilamentDetail({ data }: { data: FilamentRecord }) {
  return (
    <Section title="Filament Details">
      <Row label="Material" value={data.material} />
      <Row label="Color"    value={data.color} />
      <Row label="Weight"   value={data.weightG ? `${data.weightG} g` : undefined} />
      <Row label="Diameter" value={data.diameter ? `${data.diameter} mm` : undefined} />
    </Section>
  );
}

function InstrumentDetail({ data }: { data: InstrumentRecord }) {
  return (
    <Section title="Instrument Details">
      <Row label="Type"          value={data.type} />
      <Row label="Color"         value={data.color} />
      <Row label="Strings"       value={data.strings?.toString()} />
      <Row label="Tuning"        value={data.tuning} />
      <Row label="Body Material" value={data.bodyMaterial} />
      <Row label="Finish"        value={data.finish} />
    </Section>
  );
}
