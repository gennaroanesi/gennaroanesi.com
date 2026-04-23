/**
 * gennaroAgent/handler.ts
 *
 * AppSync-invoked Lambda that runs a tool-calling loop against Claude.
 * Starts with a read-only finance surface (accounts, transactions, recurrences,
 * savings goals, holdings, quotes, assets, loans) — more domains will be
 * added over time. Writes are intentionally out of scope for this iteration;
 * the frontend still handles mutations directly through the typed client.
 */

import Anthropic from "@anthropic-ai/sdk";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/gennaroAgent";
import type { Schema } from "../../data/resource";

const MODEL_ID   = "claude-sonnet-4-6";
const MAX_TURNS  = 10;    // safety cap on the tool-calling loop
const MAX_TOKENS = 1024;

// ANTHROPIC_API_KEY is injected by CDK (backend.ts) from the existing
// gennaroanesi/transcribe secret, so it's not part of the $amplify/env type
// surface. Read it from process.env to keep the rest of env typed-safe.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.warn("[gennaroAgent] ANTHROPIC_API_KEY is missing — Anthropic calls will fail.");
}
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Data client (lazy init) ──────────────────────────────────────────────────

type DataClient = ReturnType<typeof generateClient<Schema>>;
let _client: DataClient | null = null;

async function getClient(): Promise<DataClient> {
  if (_client) return _client;
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  _client = generateClient<Schema>();
  return _client;
}

// Amplify.list() caps at 100 per page. This helper follows nextToken until the
// cap is reached, keeping the agent from chewing through giant tables.
async function listAll<T>(
  model: { list: (args?: any) => Promise<{ data: T[]; nextToken?: string | null }> },
  filter?: any,
  cap = 500,
): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | null | undefined;
  do {
    const args: any = { limit: 100, nextToken };
    if (filter) args.filter = filter;
    const { data, nextToken: nt } = await model.list(args);
    out.push(...(data ?? []));
    nextToken = nt ?? null;
  } while (nextToken && out.length < cap);
  return out.slice(0, cap);
}

// ── Tool definitions ────────────────────────────────────────────────────────
// Shape matches Anthropic.Tool[]. Descriptions teach the model when each tool
// applies — keep them specific.

const tools: Anthropic.Tool[] = [
  {
    name: "list_accounts",
    description:
      "List finance accounts (checking, savings, brokerage, retirement, credit, loan, cash, other). Includes balances, credit limits, APR/APY, and favorite status.",
    input_schema: {
      type: "object" as const,
      properties: {
        includeInactive: { type: "boolean", description: "Include accounts marked active=false. Default false." },
        type: { type: "string", description: "Filter to one type: CHECKING, SAVINGS, BROKERAGE, RETIREMENT, CREDIT, LOAN, CASH, OTHER." },
      },
    },
  },
  {
    name: "get_account",
    description: "Fetch a single account by id.",
    input_schema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_transactions",
    description:
      "List transactions with optional filters. Transactions have type INCOME/EXPENSE/TRANSFER, a status (POSTED or PENDING), optional category and goalId, and a date (YYYY-MM-DD).",
    input_schema: {
      type: "object" as const,
      properties: {
        accountId: { type: "string", description: "Filter to one account." },
        goalId:    { type: "string", description: "Filter to one savings goal." },
        category:  { type: "string", description: "Exact match on category string." },
        from:      { type: "string", description: "Inclusive start date, YYYY-MM-DD." },
        to:        { type: "string", description: "Inclusive end date, YYYY-MM-DD." },
        status:    { type: "string", description: "POSTED or PENDING." },
        limit:     { type: "integer", description: "Max rows to return after filtering. Default 200." },
      },
    },
  },
  {
    name: "get_transaction",
    description: "Fetch a single transaction by id.",
    input_schema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_recurrences",
    description:
      "List recurring transactions. Each has a cadence (WEEKLY/BIWEEKLY/MONTHLY/QUARTERLY/SEMIANNUALLY/ANNUALLY), start/end dates, a next occurrence date, and may be active or paused.",
    input_schema: {
      type: "object" as const,
      properties: {
        accountId:  { type: "string" },
        activeOnly: { type: "boolean", description: "Only include active=true. Default true." },
      },
    },
  },
  {
    name: "get_recurrence",
    description: "Fetch a single recurring rule by id.",
    input_schema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_savings_goals",
    description:
      "List savings goals. Each has a target amount, current amount, optional target date, and priority.",
    input_schema: {
      type: "object" as const,
      properties: {
        activeOnly: { type: "boolean", description: "Only include active=true. Default true." },
      },
    },
  },
  {
    name: "get_savings_goal",
    description: "Fetch a single savings goal by id.",
    input_schema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_goal_funding_sources",
    description:
      "List mappings that declare which accounts fund which goals. Can be filtered by goalId or accountId.",
    input_schema: {
      type: "object" as const,
      properties: {
        goalId:    { type: "string" },
        accountId: { type: "string" },
      },
    },
  },
  {
    name: "list_goal_milestones",
    description: "List milestones associated with savings goals.",
    input_schema: {
      type: "object" as const,
      properties: {
        goalId: { type: "string" },
      },
    },
  },
  {
    name: "list_loans",
    description: "List loans. Each loan has a principal, interest rate (APR as decimal), term, monthly payment, and links to a LOAN-type account.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_loan",
    description: "Fetch a single loan by id.",
    input_schema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_loan_payments",
    description: "List loan payments. Can be filtered by loanId.",
    input_schema: {
      type: "object" as const,
      properties: {
        loanId: { type: "string" },
      },
    },
  },
  {
    name: "list_assets",
    description:
      "List physical assets (vehicles, real estate, collectibles, etc). Each has a type, purchase value, current value, and active flag.",
    input_schema: {
      type: "object" as const,
      properties: {
        activeOnly: { type: "boolean", description: "Only include active=true. Default true." },
        assetType:  { type: "string", description: "Optional type filter." },
      },
    },
  },
  {
    name: "get_asset",
    description: "Fetch a single asset by id.",
    input_schema: {
      type: "object" as const,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_holding_lots",
    description:
      "List purchase lots in brokerage/retirement accounts. Each lot records a ticker, quantity, cost basis, and purchase date. Aggregate by ticker for total positions.",
    input_schema: {
      type: "object" as const,
      properties: {
        accountId: { type: "string" },
        ticker:    { type: "string" },
      },
    },
  },
  {
    name: "list_ticker_quotes",
    description:
      "List the latest known market prices for tickers. Each row is keyed by ticker symbol; source is 'yahoo' for auto-refreshed quotes or 'manual' for user overrides.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_ticker_quote",
    description: "Fetch the current quote for a specific ticker symbol.",
    input_schema: {
      type: "object" as const,
      properties: { ticker: { type: "string" } },
      required: ["ticker"],
    },
  },
];

// ── Tool dispatcher ─────────────────────────────────────────────────────────

type ToolResult = { ok: true; data: any } | { ok: false; error: string };

function stringify(result: ToolResult): string {
  return JSON.stringify(result);
}

async function executeTool(name: string, input: Record<string, any>): Promise<string> {
  try {
    const c = await getClient();
    switch (name) {
      case "list_accounts": {
        const filter: any = {};
        if (!input.includeInactive) filter.active = { ne: false };
        if (input.type) filter.type = { eq: input.type };
        const accounts = await listAll(c.models.financeAccount, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { accounts } });
      }
      case "get_account": {
        const { data, errors } = await c.models.financeAccount.get({ id: input.id });
        if (errors?.length) return stringify({ ok: false, error: errors[0].message });
        return stringify({ ok: true, data: { account: data } });
      }
      case "list_transactions": {
        const filter: any = {};
        if (input.accountId) filter.accountId = { eq: input.accountId };
        if (input.goalId)    filter.goalId    = { eq: input.goalId };
        if (input.category)  filter.category  = { eq: input.category };
        if (input.status)    filter.status    = { eq: input.status };
        if (input.from && input.to) filter.date = { between: [input.from, input.to] };
        else if (input.from) filter.date = { ge: input.from };
        else if (input.to)   filter.date = { le: input.to };
        const cap = Math.min(input.limit ?? 200, 1000);
        const txs = await listAll(c.models.financeTransaction, Object.keys(filter).length ? filter : undefined, cap);
        return stringify({ ok: true, data: { transactions: txs, count: txs.length } });
      }
      case "get_transaction": {
        const { data, errors } = await c.models.financeTransaction.get({ id: input.id });
        if (errors?.length) return stringify({ ok: false, error: errors[0].message });
        return stringify({ ok: true, data: { transaction: data } });
      }
      case "list_recurrences": {
        const filter: any = {};
        if (input.accountId) filter.accountId = { eq: input.accountId };
        if (input.activeOnly !== false) filter.active = { ne: false };
        const recs = await listAll(c.models.financeRecurring, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { recurrences: recs } });
      }
      case "get_recurrence": {
        const { data, errors } = await c.models.financeRecurring.get({ id: input.id });
        if (errors?.length) return stringify({ ok: false, error: errors[0].message });
        return stringify({ ok: true, data: { recurrence: data } });
      }
      case "list_savings_goals": {
        const filter: any = {};
        if (input.activeOnly !== false) filter.active = { ne: false };
        const goals = await listAll(c.models.financeSavingsGoal, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { goals } });
      }
      case "get_savings_goal": {
        const { data, errors } = await c.models.financeSavingsGoal.get({ id: input.id });
        if (errors?.length) return stringify({ ok: false, error: errors[0].message });
        return stringify({ ok: true, data: { goal: data } });
      }
      case "list_goal_funding_sources": {
        const filter: any = {};
        if (input.goalId)    filter.goalId    = { eq: input.goalId };
        if (input.accountId) filter.accountId = { eq: input.accountId };
        const mappings = await listAll(c.models.financeGoalFundingSource, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { fundingSources: mappings } });
      }
      case "list_goal_milestones": {
        const filter: any = {};
        if (input.goalId) filter.goalId = { eq: input.goalId };
        const milestones = await listAll(c.models.financeGoalMilestone, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { milestones } });
      }
      case "list_loans": {
        const loans = await listAll(c.models.financeLoan);
        return stringify({ ok: true, data: { loans } });
      }
      case "get_loan": {
        const { data, errors } = await c.models.financeLoan.get({ id: input.id });
        if (errors?.length) return stringify({ ok: false, error: errors[0].message });
        return stringify({ ok: true, data: { loan: data } });
      }
      case "list_loan_payments": {
        const filter: any = {};
        if (input.loanId) filter.loanId = { eq: input.loanId };
        const payments = await listAll(c.models.financeLoanPayment, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { payments } });
      }
      case "list_assets": {
        const filter: any = {};
        if (input.activeOnly !== false) filter.active = { ne: false };
        if (input.assetType) filter.assetType = { eq: input.assetType };
        const assets = await listAll(c.models.financeAsset, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { assets } });
      }
      case "get_asset": {
        const { data, errors } = await c.models.financeAsset.get({ id: input.id });
        if (errors?.length) return stringify({ ok: false, error: errors[0].message });
        return stringify({ ok: true, data: { asset: data } });
      }
      case "list_holding_lots": {
        const filter: any = {};
        if (input.accountId) filter.accountId = { eq: input.accountId };
        if (input.ticker)    filter.ticker    = { eq: input.ticker.toUpperCase() };
        const lots = await listAll(c.models.financeHoldingLot, Object.keys(filter).length ? filter : undefined);
        return stringify({ ok: true, data: { lots } });
      }
      case "list_ticker_quotes": {
        const quotes = await listAll(c.models.financeTickerQuote);
        return stringify({ ok: true, data: { quotes } });
      }
      case "get_ticker_quote": {
        const { data, errors } = await c.models.financeTickerQuote.get({ ticker: input.ticker.toUpperCase() });
        if (errors?.length) return stringify({ ok: false, error: errors[0].message });
        return stringify({ ok: true, data: { quote: data } });
      }
      default:
        return stringify({ ok: false, error: `Unknown tool: ${name}` });
    }
  } catch (err: any) {
    console.error(`[gennaroAgent] tool ${name} failed:`, err);
    return stringify({ ok: false, error: err?.message ?? String(err) });
  }
}

// ── System prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(chatContext: unknown): string {
  const now = new Date();
  const TZ = "America/Chicago";
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  // chatContext arrives as a JSON string (AppSync a.json() wire format) from
  // the web UI, but future callers may pass an object. Accept both.
  let parsedCtx: unknown = chatContext;
  if (typeof chatContext === "string") {
    try { parsedCtx = JSON.parse(chatContext); } catch { parsedCtx = null; }
  }

  let ctxBlock = "";
  if (parsedCtx && typeof parsedCtx === "object") {
    try {
      const json = JSON.stringify(parsedCtx, null, 2);
      if (json && json !== "{}") {
        ctxBlock = `\n\nCurrent UI context (what the user is looking at):\n${json}`;
      }
    } catch { /* ignore */ }
  }

  return `You are the finance assistant for Gennaro's personal dashboard. You help summarize and explore the user's accounts, transactions, recurring items, goals, holdings, and loans.

Today is ${dateFmt.format(now)} (${TZ}).

Available capabilities are strictly READ-ONLY — you can list, filter, and summarize, but you cannot create, update, or delete anything. If the user asks for a change, explain that writes aren't wired up yet and point them to the relevant page.

Guidelines:
- Prefer concrete numbers over vague phrases. Format currency with a $ and thousands separators (e.g. $1,234.56).
- When a user asks about "this month" or "last month", translate to explicit from/to dates before calling tools.
- Tickers are uppercase. Normalize before calling get_ticker_quote.
- Manual ticker quotes (source="manual") are user-managed and may be stale even if fresh looking.
- Balances in BROKERAGE/RETIREMENT accounts are cash only — add Σ(lot.quantity × quote.price) for market value.
- Credit account balances are negative when money is owed. creditLimit and APR are informational.
- Keep responses terse and direct. Don't narrate tool calls; just use the results.${ctxBlock}`;
}

// ── Handler ─────────────────────────────────────────────────────────────────

type HistoryMessage = { role: "user" | "assistant"; content: string };

type AgentArgs = {
  message:      string;
  history?:     HistoryMessage[] | null;
  chatContext?: unknown;
};

type AgentResponse = {
  message: string;
  actionsTaken: Array<{ tool: string; result: unknown }>;
};

export const handler = async (event: { arguments: AgentArgs }): Promise<AgentResponse> => {
  const {
    message: userMessage,
    history: rawHistory,
    chatContext,
  } = event.arguments;

  // Normalize history. History can arrive as an object (AppSync) or a JSON
  // string (if the caller serialized it); tolerate both.
  let historyArr: HistoryMessage[] = [];
  if (Array.isArray(rawHistory)) historyArr = rawHistory;
  else if (typeof rawHistory === "string") {
    try { historyArr = JSON.parse(rawHistory) ?? []; } catch { historyArr = []; }
  }

  const systemPrompt = buildSystemPrompt(chatContext);
  const messages: Anthropic.MessageParam[] = [
    ...historyArr
      .filter((m) => m && typeof m.content === "string" && m.content.length > 0)
      .map((m) => ({ role: m.role, content: m.content } as Anthropic.MessageParam)),
    { role: "user", content: userMessage },
  ];

  const actionsTaken: Array<{ tool: string; result: unknown }> = [];

  let response = await anthropic.messages.create({
    model:      MODEL_ID,
    max_tokens: MAX_TOKENS,
    system:     systemPrompt,
    messages,
    tools,
  });

  let turns = 0;
  while (response.stop_reason === "tool_use" && turns < MAX_TURNS) {
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const resultJson = await executeTool(block.name, block.input as Record<string, any>);
      let parsed: unknown;
      try { parsed = JSON.parse(resultJson); } catch { parsed = resultJson; }
      actionsTaken.push({ tool: block.name, result: parsed });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: resultJson,
      });
    }

    messages.push({ role: "user", content: toolResults });
    response = await anthropic.messages.create({
      model:      MODEL_ID,
      max_tokens: MAX_TOKENS,
      system:     systemPrompt,
      messages,
      tools,
    });
    turns++;
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    message: text || "(no response)",
    actionsTaken,
  };
};
