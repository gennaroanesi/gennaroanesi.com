/**
 * /tasks
 *
 * Household task manager. Reads/writes the `task` DynamoDB model.
 * Assignee dropdown reads from notificationPerson.
 */

import React, { useEffect, useState } from "react";
import DefaultLayout from "@/layouts/default";
import { generateClient } from "aws-amplify/api";
import type { Schema } from "@/amplify/data/resource";

const client = generateClient<Schema>();

// ── Design tokens ──────────────────────────────────────────────────────────
const TASKS_COLOR = "#7c6f9f";

const PRIORITY_CONFIG = {
  LOW:    { label: "Low",    color: "#94a3b8" },
  MEDIUM: { label: "Medium", color: "#f59e0b" },
  HIGH:   { label: "High",   color: "#f97316" },
  URGENT: { label: "Urgent", color: "#ef4444" },
} as const;

type Priority = keyof typeof PRIORITY_CONFIG;

// ── Types ──────────────────────────────────────────────────────────────────
type Task = Schema["task"]["type"];
type Person = Schema["notificationPerson"]["type"];
type Draft = Partial<Task>;

// ── Utils ──────────────────────────────────────────────────────────────────
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isOverdue(task: Task) {
  if (task.done || !task.dueDate) return false;
  return task.dueDate < todayIso();
}

function isDueToday(task: Task) {
  if (task.done || !task.dueDate) return false;
  return task.dueDate === todayIso();
}

const labelCls = "block text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-1";
const inputCls =
  "w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1";

// ── Component ──────────────────────────────────────────────────────────────
export default function TasksPage() {
  const [tasks, setTasks]       = useState<Task[]>([]);
  const [people, setPeople]     = useState<Person[]>([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [filter, setFilter]     = useState<"all" | "open" | "done">("open");
  const [draft, setDraft]       = useState<Draft | null>(null);
  const [isNew, setIsNew]       = useState(false);

  // ── Data loading ─────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      client.models.task.list({ limit: 500 }),
      client.models.notificationPerson.list(),
    ]).then(([t, p]) => {
      setTasks((t.data ?? []) as Task[]);
      setPeople((p.data ?? []) as Person[]);
    }).finally(() => setLoading(false));
  }, []);

  // ── Filtered / sorted view ────────────────────────────────────────────────
  const visible = tasks
    .filter((t) => {
      if (filter === "open") return !t.done;
      if (filter === "done") return !!t.done;
      return true;
    })
    .sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      const aOver = isOverdue(a), bOver = isOverdue(b);
      if (aOver !== bOver) return aOver ? -1 : 1;
      const aToday = isDueToday(a), bToday = isDueToday(b);
      if (aToday !== bToday) return aToday ? -1 : 1;
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return 0;
    });

  // ── Handlers ─────────────────────────────────────────────────────────────
  function openNew() {
    setDraft({ priority: "MEDIUM", done: false, source: "MANUAL" });
    setIsNew(true);
  }

  function openEdit(task: Task) {
    setDraft({ ...task });
    setIsNew(false);
  }

  async function handleSave() {
    if (!draft?.title?.trim()) return;
    setSaving(true);
    try {
      if (isNew) {
        const { data } = await client.models.task.create({
          title:      draft.title!,
          notes:      draft.notes ?? null,
          dueDate:    draft.dueDate ?? null,
          done:       false,
          priority:   (draft.priority ?? "MEDIUM") as any,
          assignedTo: draft.assignedTo ?? null,
          projectRef: draft.projectRef ?? null,
          tags:       draft.tags ?? [],
          source:     "MANUAL",
        } as any);
        if (data) setTasks((prev) => [...prev, data as Task]);
      } else {
        const { data } = await client.models.task.update({
          id:         (draft as Task).id,
          title:      draft.title!,
          notes:      draft.notes ?? null,
          dueDate:    draft.dueDate ?? null,
          priority:   (draft.priority ?? "MEDIUM") as any,
          assignedTo: draft.assignedTo ?? null,
          projectRef: draft.projectRef ?? null,
          tags:       draft.tags ?? [],
        } as any);
        if (data) setTasks((prev) => prev.map((t) => (t.id === data.id ? data as Task : t)));
      }
      setDraft(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleDone(task: Task) {
    const done = !task.done;
    const { data } = await client.models.task.update({
      id:     task.id,
      done,
      doneAt: done ? new Date().toISOString() : null,
    } as any);
    if (data) setTasks((prev) => prev.map((t) => (t.id === data.id ? data as Task : t)));
  }

  async function handleDelete() {
    if (!draft || isNew) return;
    if (!confirm("Delete this task?")) return;
    await client.models.task.delete({ id: (draft as Task).id });
    setTasks((prev) => prev.filter((t) => t.id !== (draft as Task).id));
    setDraft(null);
  }

  const personName = (id?: string | null) =>
    people.find((p) => p.id === id)?.name ?? "Unassigned";

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <DefaultLayout>
      <div className="flex flex-row w-full min-h-screen">
        {/* Main list */}
        <main className={`flex-1 min-w-0 p-6 transition-all ${draft ? "md:mr-80" : ""}`}>
          <div className="max-w-3xl mx-auto flex flex-col gap-6">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">Tasks</h1>
                <p className="text-xs text-gray-400 mt-0.5">
                  {tasks.filter((t) => !t.done).length} open ·{" "}
                  {tasks.filter((t) => t.done).length} done
                </p>
              </div>
              <button
                onClick={openNew}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-80"
                style={{ backgroundColor: TASKS_COLOR }}
              >
                + New Task
              </button>
            </div>

            {/* Filter tabs */}
            <div className="flex gap-1 border-b border-gray-100 dark:border-gray-800">
              {(["open", "all", "done"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className="px-4 py-2 text-xs font-semibold capitalize transition-colors"
                  style={
                    filter === f
                      ? { color: TASKS_COLOR, borderBottom: `2px solid ${TASKS_COLOR}` }
                      : { color: "#9ca3af" }
                  }
                >
                  {f}
                </button>
              ))}
            </div>

            {/* Task list */}
            {loading ? (
              <p className="text-sm text-gray-400 animate-pulse">Loading…</p>
            ) : visible.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <p className="text-4xl mb-3">✓</p>
                <p className="text-sm">No tasks here.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {visible.map((task) => {
                  const prio =
                    PRIORITY_CONFIG[task.priority as Priority] ?? PRIORITY_CONFIG.MEDIUM;
                  const over  = isOverdue(task);
                  const today = isDueToday(task);
                  return (
                    <div
                      key={task.id}
                      className="flex items-start gap-3 px-4 py-3 rounded-xl border border-transparent hover:border-gray-200 dark:hover:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors cursor-pointer"
                      onClick={() => openEdit(task)}
                    >
                      {/* Checkbox */}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggleDone(task); }}
                        className="mt-0.5 shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors"
                        style={{
                          borderColor:     task.done ? TASKS_COLOR : prio.color,
                          backgroundColor: task.done ? TASKS_COLOR : "transparent",
                        }}
                      >
                        {task.done && <span className="text-white text-[10px]">✓</span>}
                      </button>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <p
                          className={`text-sm font-medium ${
                            task.done
                              ? "line-through text-gray-400"
                              : "text-gray-800 dark:text-gray-100"
                          }`}
                        >
                          {task.title}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          {task.dueDate && (
                            <span
                              className="text-[11px] font-semibold"
                              style={{
                                color: over ? "#ef4444" : today ? "#f59e0b" : "#94a3b8",
                              }}
                            >
                              {over ? "Overdue · " : today ? "Today · " : ""}
                              {task.dueDate}
                            </span>
                          )}
                          {task.assignedTo && (
                            <span className="text-[11px] text-gray-400">
                              → {personName(task.assignedTo)}
                            </span>
                          )}
                          {(task.tags ?? []).map((tag) => (
                            <span
                              key={tag}
                              className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                        {task.notes && (
                          <p className="text-[11px] text-gray-400 mt-0.5 truncate">{task.notes}</p>
                        )}
                      </div>

                      {/* Priority dot */}
                      <span
                        className="shrink-0 w-2 h-2 rounded-full mt-1.5"
                        style={{ backgroundColor: prio.color }}
                        title={prio.label}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>

        {/* Edit / New panel */}
        {draft && (
          <aside className="fixed right-0 top-0 h-full w-80 border-l border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-950 shadow-xl flex flex-col pt-16 px-5 gap-5 overflow-y-auto z-40">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-gray-700 dark:text-gray-200">
                {isNew ? "New Task" : "Edit Task"}
              </h2>
              <button
                onClick={() => setDraft(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
              >
                ×
              </button>
            </div>

            {/* Title */}
            <div>
              <label className={labelCls}>Title *</label>
              <input
                type="text"
                className={inputCls}
                placeholder="What needs to be done?"
                value={draft.title ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              />
            </div>

            {/* Due date */}
            <div>
              <label className={labelCls}>Due Date</label>
              <input
                type="date"
                className={inputCls}
                value={draft.dueDate ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, dueDate: e.target.value || null }))
                }
              />
            </div>

            {/* Priority */}
            <div>
              <label className={labelCls}>Priority</label>
              <select
                className={inputCls}
                value={draft.priority ?? "MEDIUM"}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, priority: e.target.value as Priority }))
                }
              >
                {Object.entries(PRIORITY_CONFIG).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>

            {/* Assigned to */}
            <div>
              <label className={labelCls}>Assigned To</label>
              <select
                className={inputCls}
                value={draft.assignedTo ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, assignedTo: e.target.value || null }))
                }
              >
                <option value="">Unassigned</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            {/* Tags */}
            <div>
              <label className={labelCls}>Tags (comma-separated)</label>
              <input
                type="text"
                className={inputCls}
                placeholder="home, flying, finance"
                value={(draft.tags ?? []).join(", ")}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    tags: e.target.value
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean),
                  }))
                }
              />
            </div>

            {/* Notes */}
            <div>
              <label className={labelCls}>Notes</label>
              <textarea
                className={`${inputCls} resize-y min-h-[80px]`}
                placeholder="Additional context…"
                value={draft.notes ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, notes: e.target.value || null }))
                }
              />
            </div>

            {/* PARA link */}
            <div>
              <label className={labelCls}>Project Note (S3 key)</label>
              <input
                type="text"
                className={inputCls}
                placeholder="PARA/Projects/ir-checkride.md"
                value={draft.projectRef ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, projectRef: e.target.value || null }))
                }
              />
              <p className="text-[10px] text-gray-400 mt-1">
                Links to a PARA note. Agent reads it for context.
              </p>
            </div>

            {/* Actions */}
            <div className="flex gap-2 mt-auto pb-6">
              <button
                onClick={handleSave}
                disabled={saving || !draft.title?.trim()}
                className="flex-1 py-2 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-80 disabled:opacity-50"
                style={{ backgroundColor: TASKS_COLOR }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
              {!isNew && (
                <button
                  onClick={handleDelete}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-red-500 bg-red-50 dark:bg-red-900/20 hover:opacity-80"
                >
                  Delete
                </button>
              )}
            </div>
          </aside>
        )}
      </div>
    </DefaultLayout>
  );
}
