import React, { useEffect, useState, useCallback } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import InventoryLayout from "@/layouts/inventory";
import { inputCls, labelCls, SaveButton, DeleteButton, CaliberInput } from "@/components/inventory/_shared";

const client = generateClient<Schema>();

const THRESHOLD_COLOR = "#B8940A";

type Threshold = Schema["ammoThreshold"]["type"];
type Person    = Schema["notificationPerson"]["type"];

type Draft = {
  caliber:   string;
  minRounds: number | "";
  personId:  string;
  enabled:   boolean;
};

const emptyDraft = (): Draft => ({
  caliber:   "",
  minRounds: "",
  personId:  "",
  enabled:   true,
});

type PanelState = { kind: "new" } | { kind: "edit"; threshold: Threshold } | null;

export default function ThresholdsPage() {
  const { authState } = useRequireAuth();
  const [thresholds, setThresholds] = useState<Threshold[]>([]);
  const [people,     setPeople]     = useState<Person[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [panel,      setPanel]      = useState<PanelState>(null);
  const [draft,      setDraft]      = useState<Draft>(emptyDraft());

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: tData }, { data: pData }] = await Promise.all([
        client.models.ammoThreshold.list({ limit: 500 }),
        client.models.notificationPerson.list({ limit: 500 }),
      ]);
      setThresholds(tData ?? []);
      setPeople((pData ?? []).filter((p) => p.active !== false));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchData();
  }, [authState, fetchData]);

  const personMap = new Map(people.map((p) => [p.id, p]));

  function openNew() {
    setDraft({ ...emptyDraft(), personId: people[0]?.id ?? "" });
    setPanel({ kind: "new" });
  }

  function openEdit(t: Threshold) {
    setDraft({
      caliber:   t.caliber ?? "",
      minRounds: t.minRounds ?? "",
      personId:  t.personId ?? "",
      enabled:   t.enabled ?? true,
    });
    setPanel({ kind: "edit", threshold: t });
  }

  async function handleSave() {
    if (!draft.caliber.trim() || !draft.minRounds || !draft.personId) return;
    setSaving(true);
    try {
      if (panel?.kind === "new") {
        const { data: newT } = await client.models.ammoThreshold.create({
          caliber:   draft.caliber,
          minRounds: draft.minRounds as number,
          personId:  draft.personId,
          enabled:   draft.enabled,
        });
        if (newT) setThresholds((prev) => [newT, ...prev]);
      } else if (panel?.kind === "edit") {
        const { data: updated } = await client.models.ammoThreshold.update({
          id:        panel.threshold.id,
          caliber:   draft.caliber,
          minRounds: draft.minRounds as number,
          personId:  draft.personId,
          enabled:   draft.enabled,
        });
        if (updated) setThresholds((prev) => prev.map((t) => t.id === updated.id ? updated : t));
      }
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(t: Threshold) {
    if (!confirm(`Delete threshold for ${t.caliber}?`)) return;
    setSaving(true);
    try {
      await client.models.ammoThreshold.delete({ id: t.id });
      setThresholds((prev) => prev.filter((x) => x.id !== t.id));
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(t: Threshold) {
    const { data: updated } = await client.models.ammoThreshold.update({
      id:      t.id,
      enabled: !t.enabled,
    });
    if (updated) setThresholds((prev) => prev.map((x) => x.id === updated.id ? updated : x));
  }

  if (authState !== "authenticated") return null;

  return (
    <InventoryLayout>
      <div className="flex h-full">
        {/* ── Main ── */}
        <div className="flex-1 px-3 py-4 md:px-6 md:py-6 overflow-auto">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-purple dark:text-rose">Ammo Thresholds</h1>
              <p className="text-sm text-gray-400 mt-0.5">Get notified when a caliber runs low</p>
            </div>
            <button onClick={openNew}
              className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity">
              + Add Threshold
            </button>
          </div>

          {people.length === 0 && !loading && (
            <div className="mb-4 px-4 py-3 rounded-lg border text-sm"
              style={{ borderColor: THRESHOLD_COLOR + "55", backgroundColor: THRESHOLD_COLOR + "11", color: THRESHOLD_COLOR }}>
              ⚠ No active people found. <a href="/inventory/people" className="underline font-medium">Add a person</a> before creating thresholds.
            </div>
          )}

          {loading ? (
            <div className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</div>
          ) : thresholds.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4 text-gray-400">
              <p className="text-sm">No thresholds yet.</p>
              <button onClick={openNew}
                className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90">
                + Add Threshold
              </button>
            </div>
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <th className="text-left text-xs uppercase tracking-widest text-gray-400 px-4 py-2 font-medium">Caliber</th>
                    <th className="text-left text-xs uppercase tracking-widest text-gray-400 px-4 py-2 font-medium">Min Rounds</th>
                    <th className="text-left text-xs uppercase tracking-widest text-gray-400 px-4 py-2 font-medium hidden md:table-cell">Notify</th>
                    <th className="text-left text-xs uppercase tracking-widest text-gray-400 px-4 py-2 font-medium">Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {thresholds
                    .sort((a, b) => (a.caliber ?? "").localeCompare(b.caliber ?? ""))
                    .map((t) => {
                      const person = personMap.get(t.personId ?? "");
                      return (
                        <tr key={t.id}
                          onClick={() => openEdit(t)}
                          className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer transition-colors">
                          <td className="px-4 py-2 font-medium text-gray-800 dark:text-gray-200">{t.caliber}</td>
                          <td className="px-4 py-2 tabular-nums text-gray-700 dark:text-gray-300">
                            {(t.minRounds ?? 0).toLocaleString()} rds
                          </td>
                          <td className="px-4 py-2 text-gray-500 dark:text-gray-400 hidden md:table-cell">
                            {person ? (
                              <span className="flex items-center gap-1.5">
                                {person.name}
                                <span className="text-[10px] text-gray-400">
                                  via {person.preferredChannel}
                                </span>
                              </span>
                            ) : (
                              <span className="text-gray-400 italic text-xs">Unknown person</span>
                            )}
                          </td>
                          <td className="px-4 py-2" onClick={(e) => { e.stopPropagation(); toggleEnabled(t); }}>
                            <button
                              className={[
                                "relative inline-flex h-5 w-9 rounded-full transition-colors",
                                t.enabled ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600",
                              ].join(" ")}
                            >
                              <span className={[
                                "inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5",
                                t.enabled ? "translate-x-4" : "translate-x-0.5",
                              ].join(" ")} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Panel ── */}
        {panel && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-96 border-l border-gray-200 dark:border-gray-700 flex flex-col bg-white dark:bg-darkPurple overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b dark:border-gray-700 flex-shrink-0">
              <h2 className="text-base font-semibold dark:text-rose text-purple">
                {panel.kind === "new" ? "New Threshold" : `Edit — ${draft.caliber}`}
              </h2>
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <div>
                <label className={labelCls}>Caliber *</label>
                <CaliberInput
                  value={draft.caliber}
                  onChange={(v) => setDraft((d) => ({ ...d, caliber: v }))}
                  required
                />
              </div>

              <div>
                <label className={labelCls}>Alert below (rounds) *</label>
                <input
                  type="number"
                  min={1}
                  className={inputCls}
                  placeholder="200"
                  value={draft.minRounds}
                  onChange={(e) => setDraft((d) => ({ ...d, minRounds: parseInt(e.target.value) || "" }))}
                />
                <p className="text-[11px] text-gray-400 mt-0.5">
                  Notification fires when total {draft.caliber || "caliber"} rounds drop below this number
                </p>
              </div>

              <div>
                <label className={labelCls}>Notify *</label>
                {people.length === 0 ? (
                  <p className="text-sm text-gray-400">
                    No people found. <a href="/inventory/people" className="underline" style={{ color: THRESHOLD_COLOR }}>Add one first.</a>
                  </p>
                ) : (
                  <select
                    className={inputCls}
                    value={draft.personId}
                    onChange={(e) => setDraft((d) => ({ ...d, personId: e.target.value }))}
                  >
                    <option value="">Select person…</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} (via {p.preferredChannel})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => setDraft((d) => ({ ...d, enabled: !d.enabled }))}
                  className={[
                    "relative inline-flex h-5 w-9 rounded-full transition-colors",
                    draft.enabled ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600",
                  ].join(" ")}
                >
                  <span className={[
                    "inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5",
                    draft.enabled ? "translate-x-4" : "translate-x-0.5",
                  ].join(" ")} />
                </button>
                <span className="text-sm text-gray-600 dark:text-gray-300">
                  {draft.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>

              <SaveButton saving={saving} onSave={handleSave}
                label={panel.kind === "new" ? "Create Threshold" : "Save"} />
              {panel.kind === "edit" && (
                <DeleteButton saving={saving} onDelete={() => handleDelete(panel.threshold)} />
              )}
            </div>
          </div>
        )}
      </div>
    </InventoryLayout>
  );
}
