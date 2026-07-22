/**
 * weeklyCashflow Lambda
 *
 * Monday-morning cashflow briefing. Loads finance accounts + recurring rules,
 * runs the pure engine (engine.ts), formats an email, and sends it via SES.
 *
 * Trigger: EventBridge cron (Mondays ~7 AM Central) — see amplify/backend.ts.
 * Ad-hoc: invoke with { dryRun: true } to get the rendered email back without
 * sending, or { to: "addr" } to send to a one-off recipient.
 *
 * Env:
 *   SES_FROM_EMAIL    verified SES sender (shared with sendNotification)
 *   WEEKLY_TO_EMAIL   default recipient
 *   BUFFER            optional min-safe checking buffer (default 750)
 */
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { env } from "$amplify/env/weeklyCashflow";
import type { Schema } from "../../data/resource";
import { analyzeCashflow, type Account, type Recurring } from "./engine";
import { buildEmail } from "./render";

const SITE = "https://gennaroanesi.com";
const ses = new SESClient({});
let _client: ReturnType<typeof generateClient<Schema>> | null = null;

async function getClient() {
  if (_client) return _client;
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
  Amplify.configure(resourceConfig, libraryOptions);
  _client = generateClient<Schema>();
  return _client;
}

async function listAll<T>(model: { list: (a?: any) => Promise<{ data: T[]; nextToken?: string | null }> }, filter?: any): Promise<T[]> {
  const out: T[] = [];
  let nextToken: string | null | undefined;
  do {
    const args: any = { limit: 100, nextToken };
    if (filter) args.filter = filter;
    const { data, nextToken: nt } = await model.list(args);
    out.push(...(data ?? []));
    nextToken = nt ?? null;
  } while (nextToken && out.length < 10_000);
  return out;
}

/** Civil date in America/Chicago (the repo's canonical tz). en-CA → YYYY-MM-DD. */
function chicagoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
}

// ── Handler ─────────────────────────────────────────────────────────────────────

export const handler = async (event: any = {}) => {
  const client = await getClient();
  const [accountsRaw, recurringsRaw] = await Promise.all([
    listAll<any>(client.models.financeAccount),
    listAll<any>(client.models.financeRecurring),
  ]);
  const accounts: Account[] = accountsRaw
    .filter((a) => a.active !== false)
    .map((a) => ({
      id: a.id, name: a.name, type: a.type, currentBalance: a.currentBalance ?? 0,
      creditLimit: a.creditLimit, apr: a.apr,
      statementClosingDay: a.statementClosingDay, statementDueDay: a.statementDueDay,
    }));
  const recurrings: Recurring[] = recurringsRaw.map((r) => ({
    id: r.id, description: r.description, amount: r.amount, type: r.type, category: r.category,
    cadence: r.cadence, nextDate: r.nextDate, startDate: r.startDate, endDate: r.endDate,
    active: r.active, accountId: r.accountId, toAccountId: r.toAccountId,
  }));

  const buffer = env.BUFFER ? parseFloat(env.BUFFER) : 750;
  const res = analyzeCashflow(accounts, recurrings, { todayIso: chicagoToday(), buffer, siteBase: SITE });
  const { subject, text, html } = buildEmail(res, accounts);

  if (event?.dryRun) {
    console.log(text);
    return { ok: true, dryRun: true, subject, text, result: res };
  }

  const from = env.SES_FROM_EMAIL;
  const to = event?.to || env.WEEKLY_TO_EMAIL;
  if (!from || !to) return { ok: false, error: `Missing SES_FROM_EMAIL (${!!from}) or recipient (${!!to})` };

  const out = await ses.send(new SendEmailCommand({
    Source: from,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } },
    },
  }));
  console.log(`[weeklyCashflow] sent to ${to}, MessageId ${out.MessageId}`);
  return { ok: true, msgId: out.MessageId, subject };
};
