import React, { useEffect, useState, useCallback } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useRouter } from "next/router";
import NextLink from "next/link";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  AssetRecord, LoanRecord,
  PHYSICAL_ASSET_TYPES, PHYSICAL_ASSET_TYPE_LABELS, FINANCE_COLOR,
  fmtCurrency, fmtDate, amountColor,
  totalAssetValue, assetGainLoss, assetGainLossPct,
  inputCls, labelCls,
  SaveButton, DeleteButton, EmptyState,
  listAll,
} from "@/components/finance/_shared";

type PanelState =
  | { kind: "new" }
  | { kind: "edit"; asset: AssetRecord }
  | null;

export default function AssetsPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [assets,  setAssets]  = useState<AssetRecord[]>([]);
  const [loans,   setLoans]   = useState<LoanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [panel,   setPanel]   = useState<PanelState>(null);
  const [draft,   setDraft]   = useState<Partial<AssetRecord>>({});

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [ass, lns] = await Promise.all([
        listAll(client.models.financeAsset),
        listAll(client.models.financeLoan),
      ]);
      setAssets(ass);
      setLoans(lns);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchData();
  }, [authState, fetchData]);

  useEffect(() => {
    if (!router.isReady) return;
    if (router.query.new === "1") {
      openNew();
      router.replace("/finance/assets", undefined, { shallow: true });
    }
  }, [router.isReady, router.query.new]);

  function openNew() {
    setDraft({ type: "REAL_ESTATE" as any, active: true, currentValue: 0 });
    setPanel({ kind: "new" });
  }

  function openEdit(asset: AssetRecord) {
    setDraft({ ...asset });
    setPanel({ kind: "edit", asset });
  }

  async function handleSave() {
    if (!draft.name?.trim() || draft.currentValue == null) return;
    setSaving(true);
    try {
      if (panel?.kind === "new") {
        const { data: newAsset } = await client.models.financeAsset.create({
          name:          draft.name!,
          type:          (draft.type ?? "OTHER") as any,
          purchaseValue: draft.purchaseValue ?? null,
          currentValue:  draft.currentValue!,
          purchaseDate:  draft.purchaseDate ?? null,
          notes:         draft.notes ?? null,
          active:        draft.active ?? true,
        });
        if (newAsset) setAssets((p) => [...p, newAsset]);
      } else if (panel?.kind === "edit") {
        await client.models.financeAsset.update({
          id:            panel.asset.id,
          name:          draft.name!,
          type:          (draft.type ?? "OTHER") as any,
          purchaseValue: draft.purchaseValue ?? null,
          currentValue:  draft.currentValue!,
          purchaseDate:  draft.purchaseDate ?? null,
          notes:         draft.notes ?? null,
          active:        draft.active ?? true,
        });
        setAssets((p) => p.map((a) => a.id === panel.asset.id ? { ...a, ...draft } as AssetRecord : a));
      }
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(asset: AssetRecord) {
    if (!confirm(`Delete asset "${asset.name}"?\n\nTip: you can also mark it inactive (below) to keep it in history.`)) return;
    setSaving(true);
    try {
      await client.models.financeAsset.delete({ id: asset.id });
      setAssets((p) => p.filter((a) => a.id !== asset.id));
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  if (authState !== "authenticated") return null;

  const activeAssets   = assets.filter((a) => a.active !== false);
  const inactiveAssets = assets.filter((a) => a.active === false);
  const total          = totalAssetValue(assets);

  // Group by type for display, inside active set
  const grouped: Record<string, AssetRecord[]> = {};
  for (const a of activeAssets) {
    const t = (a.type ?? "OTHER") as string;
    (grouped[t] ??= []).push(a);
  }
  const groupOrder = PHYSICAL_ASSET_TYPES.filter((t) => grouped[t]?.length > 0);

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

          {/* ── Header ────────────────────────────────────────────── */}
          <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
            <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
          </div>

          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <div className="flex items-baseline gap-3">
              <h1 className="text-2xl font-bold text-purple dark:text-rose">Assets</h1>
              {activeAssets.length > 0 && (
                <span
                  className="text-xl font-bold tabular-nums"
                  style={{ color: total >= 0 ? FINANCE_COLOR : "#ef4444" }}
                >
                  {fmtCurrency(total)}
                </span>
              )}
            </div>
            <button
              onClick={openNew}
              className="px-4 py-1.5 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity"
            >
              + New Asset
            </button>
          </div>

          {loading ? (
            <p className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</p>
          ) : activeAssets.length === 0 && inactiveAssets.length === 0 ? (
            <EmptyState label="assets" onAdd={openNew} />
          ) : (
            <div className="flex flex-col gap-6">
              {groupOrder.map((groupType) => (
                <section key={groupType}>
                  <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium mb-3">
                    {PHYSICAL_ASSET_TYPE_LABELS[groupType]} · {grouped[groupType].length}
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {grouped[groupType].map((asset) => {
                      const gain    = assetGainLoss(asset);
                      const gainPct = assetGainLossPct(asset);
                      const linkedLoan = loans.find((l) => l.assetId === asset.id);
                      const loanBalance = linkedLoan?.currentBalance ?? 0;
                      const equity = linkedLoan ? (asset.currentValue ?? 0) - loanBalance : null;
                      return (
                        <div
                          key={asset.id}
                          onClick={() => openEdit(asset)}
                          className="rounded-xl border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface px-5 py-4 flex flex-col gap-2 cursor-pointer hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">{asset.name}</h3>
                            <span
                              className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide flex-shrink-0"
                              style={{ backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR }}
                            >
                              {PHYSICAL_ASSET_TYPE_LABELS[(asset.type ?? "OTHER") as keyof typeof PHYSICAL_ASSET_TYPE_LABELS]}
                            </span>
                          </div>

                          <span
                            className="text-xl font-bold tabular-nums"
                            style={{ color: (asset.currentValue ?? 0) >= 0 ? FINANCE_COLOR : "#ef4444" }}
                          >
                            {fmtCurrency(asset.currentValue)}
                          </span>

                          {/* Equity (when linked to a loan) */}
                          {linkedLoan && (
                            <div className="flex items-center justify-between text-[11px] tabular-nums border-t border-gray-100 dark:border-gray-700 pt-1.5">
                              <span className="text-gray-400">
                                Owed {fmtCurrency(loanBalance)}
                              </span>
                              <span className="font-semibold" style={{ color: amountColor(equity ?? 0) }}>
                                Equity {fmtCurrency(equity)}
                              </span>
                            </div>
                          )}

                          {/* Purchase value + gain/loss */}
                          {asset.purchaseValue != null && (
                            <div className="flex items-center justify-between text-[11px] tabular-nums">
                              <span className="text-gray-400">
                                Paid {fmtCurrency(asset.purchaseValue)}
                                {asset.purchaseDate && <span> · {fmtDate(asset.purchaseDate)}</span>}
                              </span>
                              {gain != null && (
                                <span className="font-semibold" style={{ color: amountColor(gain) }}>
                                  {fmtCurrency(gain, "USD", true)}
                                  {gainPct != null && (
                                    <span className="ml-1">({(gainPct * 100).toFixed(1)}%)</span>
                                  )}
                                </span>
                              )}
                            </div>
                          )}

                          {asset.notes && (
                            <p className="text-[11px] text-gray-400 border-t border-gray-100 dark:border-gray-700 pt-2 truncate">{asset.notes}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}

              {/* Inactive (sold/disposed) */}
              {inactiveAssets.length > 0 && (
                <section>
                  <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium mb-3">
                    Inactive · {inactiveAssets.length}
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {inactiveAssets.map((asset) => (
                      <div
                        key={asset.id}
                        onClick={() => openEdit(asset)}
                        className="rounded-xl border border-gray-200 dark:border-darkBorder bg-gray-50 dark:bg-darkElevated px-5 py-4 flex flex-col gap-1 cursor-pointer hover:border-gray-300 dark:hover:border-gray-600 transition-colors opacity-60"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 truncate">{asset.name}</h3>
                          <span className="text-[10px] text-gray-400">
                            {PHYSICAL_ASSET_TYPE_LABELS[(asset.type ?? "OTHER") as keyof typeof PHYSICAL_ASSET_TYPE_LABELS]}
                          </span>
                        </div>
                        <span className="text-xs text-gray-400 tabular-nums">
                          Last value: {fmtCurrency(asset.currentValue)}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>

        {/* ── Side panel ─────────────────────────────────────────────── */}
        {panel && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-96 border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
              <h2 className="text-base font-semibold dark:text-rose text-purple">
                {panel.kind === "new" ? "New Asset" : draft.name}
              </h2>
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <div>
                <label className={labelCls}>Name *</label>
                <input type="text" className={inputCls} placeholder="Primary home, 2019 Honda Civic…"
                  value={draft.name ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              </div>

              <div>
                <label className={labelCls}>Type</label>
                <select className={inputCls} value={draft.type ?? "OTHER"}
                  onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value as any }))}>
                  {PHYSICAL_ASSET_TYPES.map((t) => (
                    <option key={t} value={t}>{PHYSICAL_ASSET_TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Current Value *</label>
                  <input type="number" step="0.01" className={inputCls} placeholder="0.00"
                    value={draft.currentValue ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, currentValue: parseFloat(e.target.value) || 0 }))} />
                  <p className="text-[10px] text-gray-400 mt-0.5">Current estimated value</p>
                </div>
                <div>
                  <label className={labelCls}>Purchase Value</label>
                  <input type="number" step="0.01" className={inputCls} placeholder="optional"
                    value={draft.purchaseValue ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, purchaseValue: e.target.value === "" ? null : parseFloat(e.target.value) }))} />
                  <p className="text-[10px] text-gray-400 mt-0.5">What you paid originally</p>
                </div>
              </div>

              <div>
                <label className={labelCls}>Purchase Date</label>
                <input type="date" className={inputCls}
                  value={draft.purchaseDate ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, purchaseDate: e.target.value || (null as any) }))} />
              </div>

              {/* Live gain/loss preview */}
              {draft.purchaseValue != null && draft.currentValue != null && (() => {
                const gain = (draft.currentValue ?? 0) - (draft.purchaseValue ?? 0);
                const pct  = (draft.purchaseValue ?? 0) !== 0 ? gain / (draft.purchaseValue ?? 1) : null;
                return (
                  <div className="rounded-lg bg-gray-50 dark:bg-darkElevated px-3 py-2 flex items-center justify-between text-xs">
                    <span className="text-gray-400">Gain / Loss</span>
                    <span className="font-semibold tabular-nums" style={{ color: amountColor(gain) }}>
                      {fmtCurrency(gain, "USD", true)}
                      {pct != null && <span className="ml-1 text-[10px]">({(pct * 100).toFixed(1)}%)</span>}
                    </span>
                  </div>
                );
              })()}

              <div>
                <label className={labelCls}>Notes</label>
                <textarea className={inputCls} rows={3} placeholder="VIN, address, appraisal date…"
                  value={draft.notes ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
              </div>

              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                <input type="checkbox" checked={draft.active ?? true}
                  onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))} />
                Active
                <span className="text-[10px] text-gray-400">(uncheck when sold/disposed)</span>
              </label>

              <SaveButton saving={saving} onSave={handleSave}
                label={panel.kind === "new" ? "Create Asset" : "Save"} />
              {panel.kind === "edit" && (
                <DeleteButton saving={saving} onDelete={() => handleDelete(panel.asset)} />
              )}
            </div>
          </div>
        )}
      </div>
    </FinanceLayout>
  );
}
