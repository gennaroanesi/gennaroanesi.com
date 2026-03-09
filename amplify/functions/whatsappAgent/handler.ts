/**
 * whatsappAgent/handler.ts
 *
 * Lambda B — the household AI agent.
 *
 * Flow:
 *   1. Identify sender (by phone number → notificationPerson)
 *   2. Load shared conversation history (last 30 agentMessages)
 *   3. Load agent-config.md from S3 (auto-commit rules)
 *   4. Call Claude with tools + history
 *   5. Claude may call tools (read/write DynamoDB, S3, Twilio)
 *   6. If action requires confirmation → store pending intent, ask user
 *   7. If user confirms → execute and reply
 *   8. Persist all messages to agentMessage table
 *   9. Send final reply via Twilio WhatsApp
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";

// ── Clients ───────────────────────────────────────────────────────────────────
const ddb    = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3     = new S3Client({ region: "us-east-1" });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const BUCKET             = "gennaroanesi.com";
const HISTORY_LIMIT      = 30;
const MODEL              = "claude-sonnet-4-20250514";
const AGENT_CONFIG_KEY   = "PARA/Resources/agent-config.md";
const PENDING_PREFIX     = "private/agent-pending/"; // S3 key for pending confirmations

// ── Table names (injected by backend.ts) ──────────────────────────────────────
const TABLE = {
  agentMessage:  process.env.AGENT_MESSAGE_TABLE!,
  task:          process.env.TASK_TABLE!,
  person:        process.env.PERSON_TABLE!,
  ammo:          process.env.AMMO_TABLE!,
  ammoItem:      process.env.AMMO_ITEM_TABLE!,
  finAccount:    process.env.FIN_ACCOUNT_TABLE!,
  finTx:         process.env.FIN_TX_TABLE!,
};

// ── Twilio send ───────────────────────────────────────────────────────────────
async function sendWhatsApp(to: string, body: string): Promise<void> {
  const sid   = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  const from  = process.env.TWILIO_FROM_WHATSAPP!;

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Twilio send failed: ${err}`);
  }
}

// ── S3 helpers ────────────────────────────────────────────────────────────────
async function s3Get(key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return res.Body!.transformToString();
}

async function s3Put(key: string, content: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        content,
    ContentType: "text/markdown",
  }));
}

async function s3List(prefix: string): Promise<string[]> {
  const res = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
  return (res.Contents ?? []).map((o) => o.Key!).filter((k) => k.endsWith(".md"));
}

// ── Conversation history ──────────────────────────────────────────────────────
async function loadHistory(): Promise<Anthropic.MessageParam[]> {
  const res = await ddb.send(new ScanCommand({
    TableName: TABLE.agentMessage,
    Limit:     HISTORY_LIMIT * 2, // over-fetch, then trim
  }));

  const items = (res.Items ?? [])
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt))
    .slice(-HISTORY_LIMIT);

  return items.map((item) => ({
    role:    item.role === "USER" ? "user" : "assistant",
    content: item.content as string,
  }));
}

async function saveMessage(params: {
  role: "USER" | "ASSISTANT";
  content: string;
  fromPhone?: string;
  fromName?: string;
  toolCalls?: string;
  toolResults?: string;
}): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE.agentMessage,
    Item: {
      id:          randomUUID(),
      ...params,
      sentAt:      new Date().toISOString(),
      createdAt:   new Date().toISOString(),
      updatedAt:   new Date().toISOString(),
    },
  }));
}

// ── Person lookup ─────────────────────────────────────────────────────────────
async function findPerson(phone: string): Promise<{ id: string; name: string } | null> {
  // phone from Twilio is "whatsapp:+15551234567" — strip prefix
  const normalized = phone.replace(/^whatsapp:/i, "");
  const res = await ddb.send(new ScanCommand({ TableName: TABLE.person }));
  const match = (res.Items ?? []).find((p) => p.phone === normalized);
  return match ? { id: match.id, name: match.name } : null;
}

// ── Pending confirmation (stored in S3 as JSON) ───────────────────────────────
async function savePending(from: string, intent: object): Promise<void> {
  const key = PENDING_PREFIX + encodeURIComponent(from) + ".json";
  await s3Put(key, JSON.stringify(intent));
}

async function loadPending(from: string): Promise<object | null> {
  const key = PENDING_PREFIX + encodeURIComponent(from) + ".json";
  try {
    const raw = await s3Get(key);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function clearPending(from: string): Promise<void> {
  const key = PENDING_PREFIX + encodeURIComponent(from) + ".json";
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: "" }));
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS: Anthropic.Tool[] = [
  // ── Notes / PARA ──────────────────────────────────────────────────────────
  {
    name:        "list_notes",
    description: "List markdown notes in the PARA system. Optionally filter by section.",
    input_schema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["Projects", "Areas", "Resources", "Archives"],
          description: "PARA section to list. Omit for all sections.",
        },
      },
    },
  },
  {
    name:        "read_note",
    description: "Read the full content of a PARA markdown note by its S3 key.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "S3 key, e.g. PARA/Projects/ir-checkride.md" },
      },
      required: ["key"],
    },
  },
  {
    name:        "write_note",
    description: "Create or overwrite a PARA note. Requires confirmation unless auto-commit allows it.",
    input_schema: {
      type: "object",
      properties: {
        key:     { type: "string", description: "S3 key, e.g. PARA/Projects/ir-checkride.md" },
        content: { type: "string", description: "Full markdown content" },
        append:  { type: "boolean", description: "If true, append content instead of overwriting" },
      },
      required: ["key", "content"],
    },
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────
  {
    name:        "list_tasks",
    description: "List tasks. Optionally filter by status or assignee.",
    input_schema: {
      type: "object",
      properties: {
        filter:     { type: "string", enum: ["open", "done", "overdue", "today", "all"] },
        assignedTo: { type: "string", description: "Person ID or name" },
      },
    },
  },
  {
    name:        "create_task",
    description: "Create a new task. Requires confirmation unless auto-commit allows it.",
    input_schema: {
      type: "object",
      properties: {
        title:      { type: "string" },
        dueDate:    { type: "string", description: "YYYY-MM-DD" },
        priority:   { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "URGENT"] },
        assignedTo: { type: "string", description: "Person name or ID" },
        tags:       { type: "array", items: { type: "string" } },
        notes:      { type: "string" },
        projectRef: { type: "string", description: "S3 key of related PARA note" },
      },
      required: ["title"],
    },
  },
  {
    name:        "complete_task",
    description: "Mark a task as done by ID or title.",
    input_schema: {
      type: "object",
      properties: {
        id:    { type: "string", description: "Task ID" },
        title: { type: "string", description: "Fuzzy match on task title if ID unknown" },
      },
    },
  },
  {
    name:        "snooze_task",
    description: "Snooze a task until a given date.",
    input_schema: {
      type: "object",
      properties: {
        id:    { type: "string" },
        title: { type: "string" },
        until: { type: "string", description: "ISO datetime or YYYY-MM-DD" },
      },
      required: ["until"],
    },
  },

  // ── Inventory ─────────────────────────────────────────────────────────────
  {
    name:        "query_ammo",
    description: "Check ammo inventory. Returns rounds available per caliber.",
    input_schema: {
      type: "object",
      properties: {
        caliber: { type: "string", description: "Filter by caliber, e.g. '9mm'. Omit for all." },
      },
    },
  },
  {
    name:        "log_ammo_use",
    description: "Decrement ammo rounds available. Always requires confirmation.",
    input_schema: {
      type: "object",
      properties: {
        caliber: { type: "string" },
        rounds:  { type: "number" },
      },
      required: ["caliber", "rounds"],
    },
  },

  // ── Finance ───────────────────────────────────────────────────────────────
  {
    name:        "get_balances",
    description: "Get current balances for all financial accounts.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name:        "recent_transactions",
    description: "Get recent posted transactions, optionally filtered by account.",
    input_schema: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        limit:     { type: "number", description: "Default 10, max 50" },
      },
    },
  },
  {
    name:        "add_transaction",
    description: "Log a financial transaction. Always requires confirmation.",
    input_schema: {
      type: "object",
      properties: {
        accountId:   { type: "string" },
        amount:      { type: "number", description: "Positive = credit, negative = debit" },
        type:        { type: "string", enum: ["INCOME", "EXPENSE", "TRANSFER"] },
        description: { type: "string" },
        date:        { type: "string", description: "YYYY-MM-DD, defaults to today" },
        status:      { type: "string", enum: ["POSTED", "PENDING"], description: "Default POSTED" },
      },
      required: ["accountId", "amount", "type", "description"],
    },
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  {
    name:        "notify_person",
    description: "Send a WhatsApp message to the other person. Requires confirmation.",
    input_schema: {
      type: "object",
      properties: {
        personName: { type: "string", description: "Name of the person to notify" },
        message:    { type: "string" },
      },
      required: ["personName", "message"],
    },
  },
];

// ── Tools that ALWAYS require confirmation (regardless of agent-config.md) ────
const ALWAYS_CONFIRM = new Set([
  "log_ammo_use",
  "add_transaction",
  "notify_person",
]);

// ── Parse auto-commit rules from agent-config.md ──────────────────────────────
function parseAutoCommit(configMd: string): string[] {
  // Extract bullet points under "## Auto-Commit Rules" section
  const section = configMd.match(/## Auto-Commit Rules([\s\S]*?)(?=##|$)/)?.[1] ?? "";
  return section
    .split("\n")
    .filter((l) => l.trim().startsWith("- "))
    .map((l) => l.replace(/^[\s-]+/, "").toLowerCase().trim());
}

function isAutoCommit(toolName: string, autoCommitRules: string[]): boolean {
  if (ALWAYS_CONFIRM.has(toolName)) return false;
  const readOnlyTools = ["list_notes", "read_note", "list_tasks", "query_ammo", "get_balances", "recent_transactions"];
  if (readOnlyTools.includes(toolName)) return true;
  // Check config rules (simple substring match on tool name keywords)
  return autoCommitRules.some((rule) => rule.includes(toolName.replace(/_/g, " ")));
}

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(
  name: string,
  input: Record<string, any>,
  people: { id: string; name: string }[],
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);

  switch (name) {
    // ── Notes ────────────────────────────────────────────────────────────────
    case "list_notes": {
      const prefix = input.section ? `PARA/${input.section}/` : "PARA/";
      const keys = await s3List(prefix);
      if (!keys.length) return "No notes found.";
      return keys.map((k) => `- ${k}`).join("\n");
    }
    case "read_note": {
      const content = await s3Get(input.key);
      return content.slice(0, 4000); // cap at 4k chars to stay within context
    }
    case "write_note": {
      if (input.append) {
        let existing = "";
        try { existing = await s3Get(input.key); } catch {}
        await s3Put(input.key, existing + "\n" + input.content);
        return `Appended to ${input.key}`;
      }
      await s3Put(input.key, input.content);
      return `Written to ${input.key}`;
    }

    // ── Tasks ────────────────────────────────────────────────────────────────
    case "list_tasks": {
      const res = await ddb.send(new ScanCommand({ TableName: TABLE.task }));
      let tasks = res.Items ?? [];

      if (input.filter === "open")    tasks = tasks.filter((t) => !t.done);
      if (input.filter === "done")    tasks = tasks.filter((t) => t.done);
      if (input.filter === "overdue") tasks = tasks.filter((t) => !t.done && t.dueDate && t.dueDate < today);
      if (input.filter === "today")   tasks = tasks.filter((t) => !t.done && t.dueDate === today);
      if (input.assignedTo) {
        const person = people.find((p) => p.name.toLowerCase().includes(input.assignedTo.toLowerCase()));
        if (person) tasks = tasks.filter((t) => t.assignedTo === person.id);
      }

      if (!tasks.length) return "No tasks found.";
      return tasks.map((t) =>
        `[${t.done ? "✓" : " "}] ${t.title}${t.dueDate ? ` (due ${t.dueDate})` : ""}${t.priority && t.priority !== "MEDIUM" ? ` [${t.priority}]` : ""}`
      ).join("\n");
    }
    case "create_task": {
      const assignedTo = input.assignedTo
        ? people.find((p) => p.name.toLowerCase().includes(input.assignedTo.toLowerCase()))?.id
        : null;
      const item = {
        id:          randomUUID(),
        title:       input.title,
        notes:       input.notes ?? null,
        dueDate:     input.dueDate ?? null,
        done:        false,
        priority:    input.priority ?? "MEDIUM",
        assignedTo:  assignedTo ?? null,
        projectRef:  input.projectRef ?? null,
        tags:        input.tags ?? [],
        source:      "AGENT",
        createdAt:   new Date().toISOString(),
        updatedAt:   new Date().toISOString(),
      };
      await ddb.send(new PutCommand({ TableName: TABLE.task, Item: item }));
      return `Task created: "${input.title}"`;
    }
    case "complete_task": {
      let taskId = input.id;
      if (!taskId && input.title) {
        const res = await ddb.send(new ScanCommand({ TableName: TABLE.task }));
        const match = (res.Items ?? []).find((t) =>
          t.title.toLowerCase().includes(input.title.toLowerCase()) && !t.done
        );
        if (!match) return `No open task found matching "${input.title}"`;
        taskId = match.id;
      }
      await ddb.send(new UpdateCommand({
        TableName:  TABLE.task,
        Key:        { id: taskId },
        UpdateExpression: "SET done = :t, doneAt = :at, updatedAt = :at",
        ExpressionAttributeValues: { ":t": true, ":at": new Date().toISOString() },
      }));
      return `Task marked done.`;
    }
    case "snooze_task": {
      let taskId = input.id;
      if (!taskId && input.title) {
        const res = await ddb.send(new ScanCommand({ TableName: TABLE.task }));
        const match = (res.Items ?? []).find((t) =>
          t.title.toLowerCase().includes(input.title.toLowerCase())
        );
        if (!match) return `No task found matching "${input.title}"`;
        taskId = match.id;
      }
      await ddb.send(new UpdateCommand({
        TableName:  TABLE.task,
        Key:        { id: taskId },
        UpdateExpression: "SET snoozedUntil = :u, updatedAt = :at",
        ExpressionAttributeValues: { ":u": input.until, ":at": new Date().toISOString() },
      }));
      return `Task snoozed until ${input.until}.`;
    }

    // ── Inventory ────────────────────────────────────────────────────────────
    case "query_ammo": {
      const res = await ddb.send(new ScanCommand({ TableName: TABLE.ammo }));
      let items = res.Items ?? [];
      if (input.caliber) {
        items = items.filter((i) => i.caliber?.toLowerCase().includes(input.caliber.toLowerCase()));
      }
      if (!items.length) return "No ammo records found.";
      return items.map((i) => `${i.caliber}: ${i.roundsAvailable ?? "?"} rounds`).join("\n");
    }
    case "log_ammo_use": {
      const res = await ddb.send(new ScanCommand({ TableName: TABLE.ammo }));
      const match = (res.Items ?? []).find((i) =>
        i.caliber?.toLowerCase().includes(input.caliber.toLowerCase())
      );
      if (!match) return `No ammo found for caliber "${input.caliber}"`;
      const newCount = Math.max(0, (match.roundsAvailable ?? 0) - input.rounds);
      await ddb.send(new UpdateCommand({
        TableName: TABLE.ammo,
        Key:       { id: match.id },
        UpdateExpression: "SET roundsAvailable = :n, updatedAt = :at",
        ExpressionAttributeValues: { ":n": newCount, ":at": new Date().toISOString() },
      }));
      return `${input.caliber}: decremented by ${input.rounds}. Now ${newCount} rounds.`;
    }

    // ── Finance ───────────────────────────────────────────────────────────────
    case "get_balances": {
      const res = await ddb.send(new ScanCommand({ TableName: TABLE.finAccount }));
      const accounts = (res.Items ?? []).filter((a) => a.active !== false);
      if (!accounts.length) return "No accounts found.";
      return accounts.map((a) =>
        `${a.name} (${a.type}): $${(a.currentBalance ?? 0).toFixed(2)}`
      ).join("\n");
    }
    case "recent_transactions": {
      const res = await ddb.send(new ScanCommand({ TableName: TABLE.finTx }));
      let txs = (res.Items ?? []).filter((t) => t.status === "POSTED");
      if (input.accountId) txs = txs.filter((t) => t.accountId === input.accountId);
      txs = txs.sort((a, b) => b.date?.localeCompare(a.date ?? "") ?? 0).slice(0, input.limit ?? 10);
      if (!txs.length) return "No transactions found.";
      return txs.map((t) =>
        `${t.date} ${t.description}: $${t.amount?.toFixed(2)} (${t.type})`
      ).join("\n");
    }
    case "add_transaction": {
      const item = {
        id:          randomUUID(),
        accountId:   input.accountId,
        amount:      input.amount,
        type:        input.type,
        description: input.description,
        date:        input.date ?? today,
        status:      input.status ?? "POSTED",
        createdAt:   new Date().toISOString(),
        updatedAt:   new Date().toISOString(),
      };
      await ddb.send(new PutCommand({ TableName: TABLE.finTx, Item: item }));
      return `Transaction logged: ${input.description} $${input.amount}`;
    }

    // ── Notifications ──────────────────────────────────────────────────────────
    case "notify_person": {
      const person = people.find((p) =>
        p.name.toLowerCase().includes(input.personName.toLowerCase())
      );
      if (!person) return `Person "${input.personName}" not found.`;
      // Look up phone
      const res = await ddb.send(new ScanCommand({ TableName: TABLE.person }));
      const full = (res.Items ?? []).find((p) => p.id === person.id);
      if (!full?.phone) return `No phone number for ${person.name}.`;
      await sendWhatsApp(`whatsapp:${full.phone}`, input.message);
      return `Message sent to ${person.name}.`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
export const handler = async (event: {
  from: string;
  body: string;
  params: Record<string, string>;
}) => {
  const { from, body: userMessage } = event;

  try {
    // 1. Identify sender
    const peopleRes = await ddb.send(new ScanCommand({ TableName: TABLE.person }));
    const people    = (peopleRes.Items ?? []).map((p) => ({ id: p.id, name: p.name, phone: p.phone }));
    const sender    = people.find((p) => {
      const normalized = from.replace(/^whatsapp:/i, "");
      return p.phone === normalized;
    });
    const senderName = sender?.name ?? "Unknown";

    // 2. Check for pending confirmation
    const pending = await loadPending(from);
    const isConfirm = /^(yes|confirm|ok|sure|yep|yeah)$/i.test(userMessage.trim());
    const isCancel  = /^(no|cancel|nevermind|nope|stop)$/i.test(userMessage.trim());

    if (pending && isCancel) {
      await clearPending(from);
      await saveMessage({ role: "ASSISTANT", content: "Cancelled." });
      await sendWhatsApp(from, "Cancelled.");
      return;
    }

    if (pending && isConfirm) {
      await clearPending(from);
      const result = await executeTool(
        (pending as any).toolName,
        (pending as any).toolInput,
        people,
      );
      await saveMessage({ role: "ASSISTANT", content: result });
      await sendWhatsApp(from, result);
      return;
    }

    // 3. Load config + history
    let agentConfig = "";
    try { agentConfig = await s3Get(AGENT_CONFIG_KEY); } catch {}
    const autoCommitRules = parseAutoCommit(agentConfig);

    const history = await loadHistory();

    // 4. Save inbound message
    await saveMessage({
      role:      "USER",
      content:   userMessage,
      fromPhone: from,
      fromName:  senderName,
    });

    // 5. Call Claude (agentic loop — up to 5 tool rounds)
    const messages: Anthropic.MessageParam[] = [
      ...history,
      { role: "user", content: userMessage },
    ];

    const systemPrompt = `You are a helpful household assistant for Gennaro and his wife.
You have access to their task list, PARA notes, ammo inventory, and finances.
Today is ${new Date().toISOString().slice(0, 10)}.
The person messaging you right now is: ${senderName}.

Agent configuration (auto-commit rules and preferences):
${agentConfig || "No config loaded."}

Guidelines:
- Be concise — this is WhatsApp, keep replies short
- For read-only queries, answer directly
- For write actions that require confirmation, describe what you're about to do and ask for confirmation
- For write actions that are auto-commit, execute immediately and confirm what you did
- Never ask for confirmation on read-only operations
- If unsure who to assign a task to, ask
- Format dates as YYYY-MM-DD
- Format currency as $X,XXX.XX`;

    let finalReply = "";
    let toolCallsMade: any[] = [];

    for (let round = 0; round < 5; round++) {
      const response = await claude.messages.create({
        model:      MODEL,
        max_tokens: 1024,
        system:     systemPrompt,
        tools:      TOOLS,
        messages,
      });

      // Collect text
      const textBlocks = response.content.filter((b) => b.type === "text");
      if (textBlocks.length) {
        finalReply = textBlocks.map((b: any) => b.text).join("\n");
      }

      if (response.stop_reason === "end_turn") break;
      if (response.stop_reason !== "tool_use") break;

      // Process tool calls
      const toolUses = response.content.filter((b) => b.type === "tool_use") as Anthropic.ToolUseBlock[];
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUses) {
        const { name, input, id } = toolUse;
        toolCallsMade.push({ name, input });

        let result: string;
        if (!isAutoCommit(name, autoCommitRules)) {
          // Need confirmation — store pending and stop
          await savePending(from, { toolName: name, toolInput: input });
          const confirmMsg = `I'll ${describeAction(name, input as any)}. Reply "yes" to confirm or "no" to cancel.`;
          await saveMessage({ role: "ASSISTANT", content: confirmMsg });
          await sendWhatsApp(from, confirmMsg);
          return;
        }

        result = await executeTool(name, input as any, people);
        toolResults.push({ type: "tool_result", tool_use_id: id, content: result });
      }

      // Add assistant turn + tool results to messages for next round
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user",      content: toolResults });
    }

    // 6. Save and send final reply
    if (finalReply) {
      await saveMessage({
        role:      "ASSISTANT",
        content:   finalReply,
        toolCalls: toolCallsMade.length ? JSON.stringify(toolCallsMade) : undefined,
      });
      await sendWhatsApp(from, finalReply);
    }
  } catch (err: any) {
    console.error("Agent error:", err);
    await sendWhatsApp(from, "Sorry, something went wrong. Try again in a moment.");
  }
};

// ── Human-readable action descriptions for confirmation prompts ───────────────
function describeAction(toolName: string, input: Record<string, any>): string {
  switch (toolName) {
    case "add_transaction":
      return `log a ${input.type?.toLowerCase()} of $${Math.abs(input.amount)} for "${input.description}"`;
    case "log_ammo_use":
      return `decrement ${input.caliber} ammo by ${input.rounds} rounds`;
    case "notify_person":
      return `send "${input.message}" to ${input.personName}`;
    case "write_note":
      return input.append
        ? `append to note ${input.key}`
        : `overwrite note ${input.key}`;
    case "create_task":
      return `create task "${input.title}"${input.dueDate ? ` due ${input.dueDate}` : ""}${input.assignedTo ? ` assigned to ${input.assignedTo}` : ""}`;
    default:
      return `execute ${toolName.replace(/_/g, " ")}`;
  }
}
