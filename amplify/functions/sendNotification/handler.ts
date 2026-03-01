/**
 * sendNotification Lambda
 *
 * Generic notification dispatcher. Supports SMS, WhatsApp, and Email (future).
 * Twilio credentials are injected via environment variables set in backend.ts
 * from AWS Secrets Manager.
 *
 * Payload shape:
 * {
 *   channel: "SMS" | "WHATSAPP" | "EMAIL",
 *   to: string,         // E.164 phone or email address
 *   message: string,    // plain text body
 *   subject?: string,   // email only (ignored for SMS/WA)
 * }
 */

import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const dynamo = new DynamoDBClient({});

export type NotificationPayload = {
  channel: "SMS" | "WHATSAPP" | "EMAIL";
  to: string;
  message: string;
  subject?: string;
};

// Shape received when called as a GraphQL custom mutation (testNotification)
type MutationPayload = {
  arguments: {
    personId: string;
    message?: string;
  };
};

export type NotificationResult = {
  ok: boolean;
  sid?: string;
  error?: string;
};

async function resolvePayload(
  event: NotificationPayload | MutationPayload,
): Promise<NotificationPayload | null> {
  // Called as a direct Lambda invoke with full payload
  if ("channel" in event && "to" in event) {
    return event as NotificationPayload;
  }

  // Called as a GraphQL mutation — look up the person
  const mut = event as MutationPayload;
  const personId = mut.arguments?.personId;
  if (!personId) return null;

  const tableName = process.env.PERSON_TABLE_NAME;
  if (!tableName) {
    console.error("PERSON_TABLE_NAME not set");
    return null;
  }

  const resp = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { id: { S: personId } },
    }),
  );

  if (!resp.Item) return null;
  const person = unmarshall(resp.Item) as {
    name: string;
    phone: string;
    email: string;
    preferredChannel: "SMS" | "WHATSAPP" | "EMAIL";
  };

  const channel = person.preferredChannel ?? "SMS";
  const to = channel === "EMAIL" ? person.email : person.phone;
  if (!to) return null;

  const message =
    mut.arguments.message ??
    `🔔 Test notification from gennaroanesi.com — Hi ${person.name}, your notifications are working!`;

  return { channel, to, message };
}

export const handler = async (
  event: NotificationPayload | MutationPayload,
): Promise<NotificationResult> => {
  const payload = await resolvePayload(event);
  if (!payload)
    return { ok: false, error: "Could not resolve notification payload" };

  const { channel, to, message } = payload;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromSms = process.env.TWILIO_FROM_SMS; // e.g. +1XXXXXXXXXX
  const fromWa = process.env.TWILIO_FROM_WHATSAPP; // e.g. whatsapp:+151212345678

  if (!accountSid || !authToken) {
    console.error("Missing Twilio credentials in environment");
    return { ok: false, error: "Missing Twilio credentials" };
  }

  if (channel === "SMS" || channel === "WHATSAPP") {
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

    let fromNumber: string;
    let toNumber: string;

    if (channel === "WHATSAPP") {
      if (!fromWa) return { ok: false, error: "TWILIO_FROM_WHATSAPP not set" };
      fromNumber = fromWa.startsWith("whatsapp:")
        ? fromWa
        : `whatsapp:${fromWa}`;
      toNumber = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
    } else {
      if (!fromSms) return { ok: false, error: "TWILIO_FROM_SMS not set" };
      fromNumber = fromSms;
      toNumber = to;
    }

    const body = new URLSearchParams({
      From: fromNumber,
      To: toNumber,
      Body: message,
    });

    const resp = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      },
      body: body.toString(),
    });

    const json = (await resp.json()) as { sid?: string; message?: string };
    if (!resp.ok) {
      console.error("Twilio error:", json);
      return { ok: false, error: json.message ?? "Twilio request failed" };
    }

    console.log(
      `[sendNotification] ${channel} sent to ${to}, SID: ${json.sid}`,
    );
    return { ok: true, sid: json.sid };
  }

  // EMAIL — placeholder for future SES integration
  if (channel === "EMAIL") {
    console.warn("[sendNotification] EMAIL channel not yet implemented");
    return { ok: false, error: "Email channel not yet implemented" };
  }

  return { ok: false, error: `Unknown channel: ${channel}` };
};
