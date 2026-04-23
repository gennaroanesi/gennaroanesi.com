import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { useRouter } from "next/router";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import DefaultLayout from "@/layouts/default";
import {
  client, listAll, fmtDate,
} from "@/components/finance/_shared";
import type { Schema } from "@/amplify/data/resource";

// Admin home doubles as the assistant chat. We use amber to match the admin
// design system (per CLAUDE.md section 10), not the finance emerald.
const AGENT_ACCENT = "#d4a843";

type Conversation = Schema["gennaroAgentConversation"]["type"];
type ConvMessage  = Schema["gennaroAgentConversationMessage"]["type"];

type ChatMessage = {
  id?:           string;
  role:          "user" | "assistant";
  content:       string;
  actionsTaken?: Array<{ tool: string; result: unknown }>;
  createdAt?:    string;
};

/** Small helper — reduce a long title to something sidebar-friendly. */
function deriveTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? trimmed.slice(0, 57) + "…" : trimmed;
}

/** Page context injected into the system prompt so the agent knows what the user
 *  is looking at. Currently just the path; extend as needed. */
function buildChatContext(path: string): Record<string, unknown> {
  return { currentPath: path };
}

export default function AdminHomePage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId,      setActiveId]      = useState<string | null>(null);
  const [messages,      setMessages]      = useState<ChatMessage[]>([]);
  const [loadingConvos, setLoadingConvos] = useState(true);
  const [loadingMsgs,   setLoadingMsgs]   = useState(false);
  const [input,         setInput]         = useState("");
  const [sending,       setSending]       = useState(false);
  const [sidebarOpen,   setSidebarOpen]   = useState(false); // mobile drawer

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // ── Data load ────────────────────────────────────────────────────────────

  const loadConversations = useCallback(async () => {
    setLoadingConvos(true);
    try {
      const convs = await listAll(client.models.gennaroAgentConversation);
      // pinned first, then most recently updated
      convs.sort((a, b) => {
        const pa = a.pinned ? 1 : 0;
        const pb = b.pinned ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
      });
      setConversations(convs);
    } finally {
      setLoadingConvos(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    loadConversations();
  }, [authState, loadConversations]);

  const loadMessages = useCallback(async (conversationId: string) => {
    setLoadingMsgs(true);
    try {
      // Amplify codegen quirk: the generated query method is PascalCased at
      // runtime (listGennaroAgentConversationMessageByConversationId) but the
      // TypeScript types expose it camelCased. Cast to any to use the runtime
      // name — the alternative is a full-table scan via list({ filter }).
      const model = client.models.gennaroAgentConversationMessage as any;
      const { data } = await model.listGennaroAgentConversationMessageByConversationId(
        { conversationId },
        { limit: 200 },
      );
      const rows = (data ?? []) as ConvMessage[];
      const sorted = rows.slice().sort((a, b) =>
        (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
      );
      setMessages(sorted.map((m) => ({
        id:           m.id,
        role:         (m.role as "user" | "assistant") ?? "user",
        content:      m.content ?? "",
        actionsTaken: (m.actionsTaken as any) ?? undefined,
        createdAt:    m.createdAt ?? undefined,
      })));
    } finally {
      setLoadingMsgs(false);
    }
  }, []);

  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    loadMessages(activeId);
  }, [activeId, loadMessages]);

  // Auto-scroll to latest message
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, sending]);

  // ── Actions ──────────────────────────────────────────────────────────────

  function startNewConversation() {
    setActiveId(null);
    setMessages([]);
    setSidebarOpen(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  async function togglePinned(conv: Conversation) {
    const next = !conv.pinned;
    await client.models.gennaroAgentConversation.update({ id: conv.id, pinned: next });
    setConversations((prev) => prev.map((c) => c.id === conv.id ? { ...c, pinned: next } : c));
  }

  async function deleteConversation(conv: Conversation) {
    if (!confirm(`Delete conversation "${conv.title ?? "Untitled"}"? Messages are kept as orphans but won't show in the list.`)) return;
    await client.models.gennaroAgentConversation.delete({ id: conv.id });
    setConversations((prev) => prev.filter((c) => c.id !== conv.id));
    if (activeId === conv.id) startNewConversation();
  }

  async function persistUserMessage(conversationId: string, content: string): Promise<ConvMessage | null> {
    const { data } = await client.models.gennaroAgentConversationMessage.create({
      conversationId,
      role:    "user",
      content,
    });
    return data ?? null;
  }

  async function persistAssistantMessage(
    conversationId: string,
    content: string,
    actionsTaken: ChatMessage["actionsTaken"],
  ): Promise<ConvMessage | null> {
    const { data } = await client.models.gennaroAgentConversationMessage.create({
      conversationId,
      role:         "assistant",
      content,
      actionsTaken: (actionsTaken ?? []) as any,
    });
    return data ?? null;
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");

    // 1. Ensure we have a conversation record.
    let convId = activeId;
    let convRec: Conversation | null = null;
    if (!convId) {
      const { data } = await client.models.gennaroAgentConversation.create({
        title:  deriveTitle(text),
        pinned: false,
      });
      convRec = data ?? null;
      convId  = convRec?.id ?? null;
      if (!convId) {
        setSending(false);
        alert("Failed to create conversation");
        return;
      }
      setActiveId(convId);
      setConversations((prev) => convRec ? [convRec, ...prev] : prev);
    }

    // 2. Append user message locally + persist.
    const userMsg: ChatMessage = { role: "user", content: text, createdAt: new Date().toISOString() };
    setMessages((prev) => [...prev, userMsg]);
    await persistUserMessage(convId, text);

    // 3. Invoke the agent with the prior history.
    const priorHistory = messages.map((m) => ({ role: m.role, content: m.content }));
    try {
      // AppSync's AWSJSON scalar expects a JSON *string* over the wire, not
      // a raw object — otherwise validation fails with "invalid value". The
      // Lambda handler parses both shapes defensively.
      const { data, errors } = await client.mutations.invokeGennaroAgent({
        message:     text,
        history:     JSON.stringify(priorHistory),
        chatContext: JSON.stringify(buildChatContext(router.asPath)),
      });
      if (errors?.length) throw new Error(errors[0].message);

      const reply = data?.message ?? "(empty response)";
      // AppSync returns actionsTaken as `[{ tool, result }]` where result is a JSON scalar.
      const rawActions = (data?.actionsTaken ?? []) as Array<{ tool: string | null; result: unknown }>;
      const actions = rawActions
        .filter((a): a is { tool: string; result: unknown } => !!a?.tool)
        .map((a) => ({ tool: a.tool, result: a.result }));
      const assistantMsg: ChatMessage = {
        role:         "assistant",
        content:      reply,
        actionsTaken: actions,
        createdAt:    new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      await persistAssistantMessage(convId, reply, actions);

      // Touch the conversation so it floats to the top of the list.
      await client.models.gennaroAgentConversation.update({ id: convId });
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === convId);
        if (idx < 0) return prev;
        const updated = { ...prev[idx], updatedAt: new Date().toISOString() };
        const rest = prev.filter((c) => c.id !== convId);
        return [updated, ...rest];
      });
    } catch (err: any) {
      console.error("[gennaro-agent] invoke failed:", err);
      const assistantMsg: ChatMessage = {
        role:    "assistant",
        content: `⚠️ Agent error: ${err?.message ?? String(err)}`,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      if (convId) await persistAssistantMessage(convId, assistantMsg.content, []);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const activeConv = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  if (authState !== "authenticated") return null;

  return (
    <DefaultLayout>
      <div className="flex flex-col md:flex-row flex-1 min-h-0">

        {/* ── Mobile toggle bar ─────────────────────────────────────────── */}
        <div className="md:hidden flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-darkBorder">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="text-xs font-semibold"
            style={{ color: AGENT_ACCENT }}
          >
            {sidebarOpen ? "× Close chats" : "☰ Chats"}
          </button>
          <button
            onClick={startNewConversation}
            className="text-xs font-semibold px-2 py-1 rounded border"
            style={{ borderColor: AGENT_ACCENT + "88", color: AGENT_ACCENT }}
          >
            + New
          </button>
        </div>

        {/* ── Conversation sidebar ──────────────────────────────────────── */}
        <aside
          className={[
            "flex-shrink-0 flex flex-col border-r border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface",
            "md:w-64 md:static",
            sidebarOpen ? "flex" : "hidden md:flex",
          ].join(" ")}
        >
          <div className="hidden md:flex items-center justify-between px-3 py-3 border-b border-gray-200 dark:border-darkBorder">
            <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Conversations</p>
            <button
              onClick={startNewConversation}
              className="text-[11px] font-semibold px-2 py-0.5 rounded border transition-colors"
              style={{ borderColor: AGENT_ACCENT + "88", color: AGENT_ACCENT }}
            >
              + New
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loadingConvos ? (
              <p className="text-xs text-gray-400 animate-pulse p-4">Loading…</p>
            ) : conversations.length === 0 ? (
              <p className="text-xs text-gray-400 p-4">No conversations yet. Send a message to start one.</p>
            ) : (
              <ul className="py-1">
                {conversations.map((c) => {
                  const isActive = c.id === activeId;
                  return (
                    <li key={c.id}>
                      <div
                        onClick={() => { setActiveId(c.id); setSidebarOpen(false); }}
                        className={[
                          "group flex items-start gap-2 px-3 py-2 cursor-pointer transition-colors",
                          isActive
                            ? ""
                            : "hover:bg-gray-50 dark:hover:bg-white/5",
                        ].join(" ")}
                        style={isActive ? { backgroundColor: AGENT_ACCENT + "18" } : undefined}
                      >
                        <button
                          onClick={(e) => { e.stopPropagation(); togglePinned(c); }}
                          title={c.pinned ? "Unpin" : "Pin"}
                          className="text-xs leading-none mt-0.5"
                          style={{ color: c.pinned ? "#f59e0b" : "#9ca3af" }}
                        >
                          {c.pinned ? "★" : "☆"}
                        </button>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-gray-800 dark:text-gray-100 truncate">
                            {c.title ?? "Untitled"}
                          </p>
                          {c.updatedAt && (
                            <p className="text-[10px] text-gray-400">
                              {fmtDate(c.updatedAt.slice(0, 10))}
                            </p>
                          )}
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteConversation(c); }}
                          className="text-xs text-gray-300 hover:text-red-500 transition-opacity opacity-0 group-hover:opacity-100 focus:opacity-100"
                          title="Delete"
                        >
                          ×
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* ── Chat main ─────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 bg-white dark:bg-darkBg">

          <div className="flex items-center gap-2 px-4 md:px-6 py-3 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
            <span className="text-xs uppercase tracking-widest font-medium" style={{ color: AGENT_ACCENT }}>Assistant</span>
            <span className="text-xs text-gray-400">/</span>
            <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {activeConv?.title ?? "New conversation"}
            </span>
            <span className="ml-auto text-[10px] text-gray-400">
              {messages.length} message{messages.length === 1 ? "" : "s"}
            </span>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 md:px-6 py-4">
            {loadingMsgs ? (
              <p className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</p>
            ) : messages.length === 0 ? (
              <EmptyChat accent={AGENT_ACCENT} />
            ) : (
              <div className="flex flex-col gap-4 max-w-3xl mx-auto">
                {messages.map((m, i) => (
                  <MessageBubble key={m.id ?? i} msg={m} accent={AGENT_ACCENT} />
                ))}
                {sending && (
                  <div className="flex justify-start">
                    <div className="px-3 py-2 text-xs text-gray-400 animate-pulse">Thinking…</div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Input */}
          <div className="border-t border-gray-200 dark:border-darkBorder px-4 md:px-6 py-3 flex-shrink-0">
            <div className="max-w-3xl mx-auto flex gap-2 items-end">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={sending}
                rows={1}
                placeholder="Ask about accounts, transactions, goals, holdings…"
                className="flex-1 resize-none rounded-lg border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface px-3 py-2 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 disabled:opacity-60"
                style={{ maxHeight: "180px" } as React.CSSProperties}
              />
              <button
                onClick={handleSend}
                disabled={sending || !input.trim()}
                className="px-4 py-2 rounded-lg text-sm font-semibold transition-opacity disabled:opacity-50"
                style={{ backgroundColor: AGENT_ACCENT, color: "white" }}
              >
                {sending ? "…" : "Send"}
              </button>
            </div>
            <p className="text-[10px] text-gray-400 text-center mt-1">
              Read-only for now — the agent can explore your data but can't create, update, or delete.
            </p>
          </div>
        </div>

      </div>
    </DefaultLayout>
  );
}

// ── Message bubble ──────────────────────────────────────────────────────────

function MessageBubble({ msg, accent }: { msg: ChatMessage; accent: string }) {
  const isUser = msg.role === "user";
  const [expanded, setExpanded] = useState(false);
  const actionCount = msg.actionsTaken?.length ?? 0;

  return (
    <div className={["flex", isUser ? "justify-end" : "justify-start"].join(" ")}>
      <div
        className={[
          "max-w-[85%] md:max-w-[75%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words",
          isUser
            ? "text-white"
            : "bg-gray-50 dark:bg-white/5 text-gray-800 dark:text-gray-100 border border-gray-100 dark:border-darkBorder",
        ].join(" ")}
        style={isUser ? { backgroundColor: accent } : undefined}
      >
        {msg.content}
        {!isUser && actionCount > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-200 dark:border-darkBorder/50">
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-[10px] text-gray-400 hover:text-gray-600 transition-colors"
            >
              {expanded ? "▾" : "▸"} {actionCount} tool call{actionCount === 1 ? "" : "s"}
            </button>
            {expanded && (
              <div className="mt-1 space-y-1">
                {msg.actionsTaken!.map((a, i) => (
                  <details key={i} className="text-[10px]">
                    <summary className="cursor-pointer text-gray-500 dark:text-gray-400">
                      {a.tool}
                    </summary>
                    <pre className="mt-1 p-2 bg-gray-100 dark:bg-black/30 rounded overflow-x-auto text-[9px] leading-tight text-gray-600 dark:text-gray-400">
                      {safeStringify(a.result)}
                    </pre>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function EmptyChat({ accent }: { accent: string }) {
  const examples = [
    "What's my net worth right now?",
    "How much did I spend on dining last month?",
    "Which accounts are funding my emergency-fund goal?",
    "What recurring expenses do I have every month?",
    "Show me all holdings in my brokerage.",
  ];
  return (
    <div className="max-w-lg mx-auto text-center py-12">
      <p className="text-sm font-semibold mb-1" style={{ color: accent }}>Assistant</p>
      <p className="text-xs text-gray-400 mb-6">
        Read-only agent with tools for the finance domain (accounts, transactions, recurrences, goals, holdings, loans).
        More domains coming soon.
      </p>
      <p className="text-[10px] uppercase tracking-widest text-gray-400 mb-2">Try asking</p>
      <ul className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
        {examples.map((e) => <li key={e}>· {e}</li>)}
      </ul>
    </div>
  );
}
