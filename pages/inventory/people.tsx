import React, { useEffect, useState, useCallback } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import InventoryLayout from "@/layouts/inventory";
import { inputCls, labelCls, SaveButton, DeleteButton } from "@/components/inventory/_shared";

const client = generateClient<Schema>();

type TestStatus = { personId: string; state: "sending" | "ok" | "error"; error?: string };

type Person = Schema["notificationPerson"]["type"];
type Channel = "SMS" | "WHATSAPP" | "EMAIL";

const CHANNELS: Channel[] = ["SMS", "WHATSAPP", "EMAIL"];
const CHANNEL_LABELS: Record<Channel, string> = {
  SMS:       "SMS",
  WHATSAPP:  "WhatsApp",
  EMAIL:     "Email",
};

type Draft = {
  name:             string;
  phone:            string;
  email:            string;
  preferredChannel: Channel;
  active:           boolean;
};

const emptyDraft = (): Draft => ({
  name:             "",
  phone:            "",
  email:            "",
  preferredChannel: "WHATSAPP",
  active:           true,
});

type PanelState = { kind: "new" } | { kind: "edit"; person: Person } | null;

export default function PeoplePage() {
  const { authState } = useRequireAuth();
  const [people,     setPeople]     = useState<Person[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [panel,      setPanel]      = useState<PanelState>(null);
  const [draft,      setDraft]      = useState<Draft>(emptyDraft());
  const [testStatus, setTestStatus] = useState<TestStatus | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.models.notificationPerson.list({ limit: 500 });
      setPeople(data ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchData();
  }, [authState, fetchData]);

  function openNew() {
    setDraft(emptyDraft());
    setPanel({ kind: "new" });
  }

  function openEdit(p: Person) {
    setDraft({
      name:             p.name ?? "",
      phone:            p.phone ?? "",
      email:            p.email ?? "",
      preferredChannel: (p.preferredChannel as Channel) ?? "WHATSAPP",
      active:           p.active ?? true,
    });
    setPanel({ kind: "edit", person: p });
  }

  async function handleSave() {
    if (!draft.name.trim()) return;
    setSaving(true);
    try {
      if (panel?.kind === "new") {
        const { data: newP } = await client.models.notificationPerson.create({
          name:             draft.name,
          phone:            draft.phone || null,
          email:            draft.email || null,
          preferredChannel: draft.preferredChannel as any,
          active:           draft.active,
        });
        if (newP) setPeople((prev) => [newP, ...prev]);
      } else if (panel?.kind === "edit") {
        const { data: updated } = await client.models.notificationPerson.update({
          id:               panel.person.id,
          name:             draft.name,
          phone:            draft.phone || null,
          email:            draft.email || null,
          preferredChannel: draft.preferredChannel as any,
          active:           draft.active,
        });
        if (updated) setPeople((prev) => prev.map((p) => p.id === updated.id ? updated : p));
      }
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  async function sendTest(person: Person) {
    setTestStatus({ personId: person.id, state: "sending" });
    try {
      const { data, errors } = await (client.mutations as any).testNotification({ personId: person.id });
      if (errors?.length || !data?.ok) {
        setTestStatus({ personId: person.id, state: "error", error: data?.error ?? errors?.[0]?.message ?? "Unknown error" });
      } else {
        setTestStatus({ personId: person.id, state: "ok" });
      }
    } catch (e: any) {
      setTestStatus({ personId: person.id, state: "error", error: e?.message ?? "Request failed" });
    }
    // Auto-clear after 5s
    setTimeout(() => setTestStatus(null), 5000);
  }

  async function handleDelete(person: Person) {
    if (!confirm(`Delete ${person.name}?`)) return;
    setSaving(true);
    try {
      await client.models.notificationPerson.delete({ id: person.id });
      setPeople((prev) => prev.filter((p) => p.id !== person.id));
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  if (authState !== "authenticated") return null;

  return (
    <InventoryLayout>
      <div className="flex h-full">
        {/* ── Main ── */}
        <div className="flex-1 px-3 py-4 md:px-6 md:py-6 overflow-auto">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-purple dark:text-rose">People</h1>
              <p className="text-sm text-gray-400 mt-0.5">Contacts who receive notifications</p>
            </div>
            <button onClick={openNew}
              className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity">
              + Add Person
            </button>
          </div>

          {loading ? (
            <div className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</div>
          ) : people.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4 text-gray-400">
              <p className="text-sm">No people yet.</p>
              <button onClick={openNew}
                className="px-4 py-2 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90">
                + Add Person
              </button>
            </div>
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <th className="text-left text-xs uppercase tracking-widest text-gray-400 px-4 py-2 font-medium">Name</th>
                    <th className="text-left text-xs uppercase tracking-widest text-gray-400 px-4 py-2 font-medium hidden md:table-cell">Phone</th>
                    <th className="text-left text-xs uppercase tracking-widest text-gray-400 px-4 py-2 font-medium hidden md:table-cell">Email</th>
                    <th className="text-left text-xs uppercase tracking-widest text-gray-400 px-4 py-2 font-medium">Channel</th>
                    <th className="text-left text-xs uppercase tracking-widest text-gray-400 px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => {
                    const ts = testStatus?.personId === p.id ? testStatus : null;
                    return (
                    <tr key={p.id}
                      onClick={() => openEdit(p)}
                      className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer transition-colors">
                      <td className="px-4 py-2 font-medium text-gray-800 dark:text-gray-200">{p.name}</td>
                      <td className="px-4 py-2 text-gray-500 dark:text-gray-400 hidden md:table-cell">{p.phone ?? "—"}</td>
                      <td className="px-4 py-2 text-gray-500 dark:text-gray-400 hidden md:table-cell">{p.email ?? "—"}</td>
                      <td className="px-4 py-2">
                        <span className="px-2 py-0.5 rounded text-xs font-semibold bg-purple/10 text-purple dark:bg-rose/10 dark:text-rose">
                          {CHANNEL_LABELS[(p.preferredChannel as Channel) ?? "SMS"]}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        <span className={`text-xs font-semibold ${p.active ? "text-green-600 dark:text-green-400" : "text-gray-400"}`}>
                          {p.active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => sendTest(p)}
                          disabled={ts?.state === "sending"}
                          className="px-2 py-1 rounded text-xs font-semibold border transition-colors disabled:opacity-50 whitespace-nowrap"
                          style={ts?.state === "ok"
                            ? { borderColor: "#22c55e", color: "#22c55e", backgroundColor: "#22c55e11" }
                            : ts?.state === "error"
                            ? { borderColor: "#ef4444", color: "#ef4444", backgroundColor: "#ef444411" }
                            : { borderColor: "#64748b55", color: "#64748b" }
                          }
                          title={ts?.state === "error" ? ts.error : undefined}
                        >
                          {ts?.state === "sending" ? "Sending…" : ts?.state === "ok" ? "✓ Sent" : ts?.state === "error" ? "✗ Failed" : "Send Test"}
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
                {panel.kind === "new" ? "New Person" : draft.name}
              </h2>
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <div>
                <label className={labelCls}>Name *</label>
                <input type="text" className={inputCls} placeholder="Gennaro"
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              </div>

              <div>
                <label className={labelCls}>Phone (E.164)</label>
                <input type="tel" className={inputCls} placeholder="+15125928640"
                  value={draft.phone}
                  onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} />
                <p className="text-[11px] text-gray-400 mt-0.5">Required for SMS and WhatsApp</p>
              </div>

              <div>
                <label className={labelCls}>Email</label>
                <input type="email" className={inputCls} placeholder="you@example.com"
                  value={draft.email}
                  onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))} />
                <p className="text-[11px] text-gray-400 mt-0.5">Required for Email channel</p>
              </div>

              <div>
                <label className={labelCls}>Preferred Channel</label>
                <div className="flex gap-2">
                  {CHANNELS.map((ch) => (
                    <button
                      key={ch}
                      onClick={() => setDraft((d) => ({ ...d, preferredChannel: ch }))}
                      className={[
                        "flex-1 py-1.5 rounded text-sm font-semibold border transition-colors",
                        draft.preferredChannel === ch
                          ? "bg-purple text-rose dark:bg-rose dark:text-purple border-transparent"
                          : "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-purple dark:hover:border-rose",
                      ].join(" ")}
                    >
                      {CHANNEL_LABELS[ch]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => setDraft((d) => ({ ...d, active: !d.active }))}
                  className={[
                    "relative inline-flex h-5 w-9 rounded-full transition-colors",
                    draft.active ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600",
                  ].join(" ")}
                >
                  <span className={[
                    "inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5",
                    draft.active ? "translate-x-4" : "translate-x-0.5",
                  ].join(" ")} />
                </button>
                <span className="text-sm text-gray-600 dark:text-gray-300">
                  {draft.active ? "Active — will receive notifications" : "Inactive — no notifications"}
                </span>
              </div>

              {panel.kind === "edit" && (() => {
                const ts = testStatus?.personId === panel.person.id ? testStatus : null;
                return (
                  <button
                    onClick={() => sendTest(panel.person)}
                    disabled={ts?.state === "sending"}
                    className="w-full py-2 rounded text-sm font-semibold border transition-colors disabled:opacity-50"
                    style={ts?.state === "ok"
                      ? { borderColor: "#22c55e", color: "#22c55e", backgroundColor: "#22c55e11" }
                      : ts?.state === "error"
                      ? { borderColor: "#ef4444", color: "#ef4444", backgroundColor: "#ef444411" }
                      : { borderColor: "#64748b55", color: "#64748b" }
                    }
                    title={ts?.state === "error" ? ts.error : undefined}
                  >
                    {ts?.state === "sending" ? "Sending…" : ts?.state === "ok" ? "✓ Test sent!" : ts?.state === "error" ? `✗ Failed: ${ts.error}` : "🔔 Send Test Notification"}
                  </button>
                );
              })()}

              <SaveButton saving={saving} onSave={handleSave}
                label={panel.kind === "new" ? "Create Person" : "Save"} />
              {panel.kind === "edit" && (
                <DeleteButton saving={saving} onDelete={() => handleDelete(panel.person)} />
              )}
            </div>
          </div>
        )}
      </div>
    </InventoryLayout>
  );
}
