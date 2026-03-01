/**
 * sendNotification Lambda
 *
 * Channel routing:
 *   SMS       → AWS SNS  (PublishCommand direct-to-phone)
 *   EMAIL     → AWS SES  (SendEmailCommand)
 *   WHATSAPP  → Twilio   (WhatsApp Business API)
 *
 * Environment variables:
 *   PERSON_TABLE_NAME       – DynamoDB table for notificationPerson lookups
 *   SES_FROM_EMAIL          – verified SES sender address
 *   TWILIO_ACCOUNT_SID      – Twilio account SID (WhatsApp only)
 *   TWILIO_AUTH_TOKEN       – Twilio auth token  (WhatsApp only)
 *   TWILIO_FROM_WHATSAPP    – Twilio WhatsApp-enabled number, e.g. +14155238886
 *
 * Payload shapes accepted:
 *   Direct invoke:   { channel, to, message, subject? }
 *   GraphQL mutation: { arguments: { personId, message? } }
 */

import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const dynamo = new DynamoDBClient({});
const sns    = new SNSClient({});
const ses    = new SESClient({});

// ── Types ─────────────────────────────────────────────────────────────────────

export type NotificationPayload = {
  channel:  "SMS" | "WHATSAPP" | "EMAIL";
  to:       string;   // E.164 phone or email address
  message:  string;
  subject?: string;   // EMAIL only; defaults to "Notification"
};

type MutationPayload = {
  arguments: {
    personId: string;
    message?:  string;
    subject?:  string;
  };
};

export type NotificationResult = {
  ok:     boolean;
  sid?:   string;   // Twilio SID (WhatsApp)
  msgId?: string;   // SNS/SES message ID
  error?: string;
};

// ── Person lookup (for GraphQL mutation path) ─────────────────────────────────

async function resolvePayload(
  event: NotificationPayload | MutationPayload,
): Promise<NotificationPayload | null> {
  console.log("[resolvePayload] raw event:", JSON.stringify(event));

  // Direct Lambda invoke shape: { channel, to, message }
  if ("channel" in event && "to" in event) {
    return event as NotificationPayload;
  }

  // AppSync/Amplify GraphQL mutation shape may be:
  //   { arguments: { personId } }          — standard
  //   { personId }                          — some Amplify versions flatten args
  const mut      = event as MutationPayload;
  const personId = mut.arguments?.personId ?? (event as any).personId;
  if (!personId) {
    console.error("[resolvePayload] could not find personId in event:", JSON.stringify(event));
    return null;
  }

  const tableName = process.env.PERSON_TABLE_NAME;
  if (!tableName) {
    console.error("PERSON_TABLE_NAME not set");
    return null;
  }

  const resp = await dynamo.send(
    new GetItemCommand({ TableName: tableName, Key: { id: { S: personId } } }),
  );
  if (!resp.Item) return null;

  const person = unmarshall(resp.Item) as {
    name:             string;
    phone:            string;
    email:            string;
    preferredChannel: "SMS" | "WHATSAPP" | "EMAIL";
  };

  const channel = person.preferredChannel ?? "SMS";
  const to      = channel === "EMAIL" ? person.email : person.phone;
  if (!to) return null;

  const message =
    mut.arguments.message ??
    `🔔 Test notification from gennaroanesi.com — Hi ${person.name}, your notifications are working!`;
  const subject = mut.arguments.subject ?? "Notification from gennaroanesi.com";

  return { channel, to, message, subject };
}

// ── Channel handlers ──────────────────────────────────────────────────────────

async function sendSms(
  to: string,
  message: string,
): Promise<NotificationResult> {
  const result = await sns.send(
    new PublishCommand({
      PhoneNumber: to,
      Message:     message,
      MessageAttributes: {
        "AWS.SNS.SMS.SMSType": {
          DataType:    "String",
          StringValue: "Transactional",
        },
      },
    }),
  );
  console.log(`[sendNotification] SMS sent to ${to}, MessageId: ${result.MessageId}`);
  return { ok: true, msgId: result.MessageId };
}

async function sendEmail(
  to: string,
  message: string,
  subject: string,
): Promise<NotificationResult> {
  const from = process.env.SES_FROM_EMAIL;
  if (!from) return { ok: false, error: "SES_FROM_EMAIL not set" };

  const result = await ses.send(
    new SendEmailCommand({
      Source:      from,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: message, Charset: "UTF-8" },
          Html: {
            Charset: "UTF-8",
            Data: `<div style="font-family:sans-serif;font-size:14px;line-height:1.6;color:#333">
              ${message.replace(/\n/g, "<br>")}
            </div>`,
          },
        },
      },
    }),
  );
  console.log(`[sendNotification] Email sent to ${to}, MessageId: ${result.MessageId}`);
  return { ok: true, msgId: result.MessageId };
}

async function sendWhatsApp(
  to: string,
  message: string,
): Promise<NotificationResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromWa     = process.env.TWILIO_FROM_WHATSAPP;

  if (!accountSid || !authToken) return { ok: false, error: "Missing Twilio credentials" };
  if (!fromWa)                   return { ok: false, error: "TWILIO_FROM_WHATSAPP not set" };

  const fromNumber = fromWa.startsWith("whatsapp:") ? fromWa : `whatsapp:${fromWa}`;
  const toNumber   = to.startsWith("whatsapp:")     ? to      : `whatsapp:${to}`;

  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method:  "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:  `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      },
      body: new URLSearchParams({ From: fromNumber, To: toNumber, Body: message }).toString(),
    },
  );

  const json = (await resp.json()) as { sid?: string; message?: string };
  if (!resp.ok) {
    console.error("Twilio error:", json);
    return { ok: false, error: json.message ?? "Twilio request failed" };
  }

  console.log(`[sendNotification] WhatsApp sent to ${to}, SID: ${json.sid}`);
  return { ok: true, sid: json.sid };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export const handler = async (
  event: NotificationPayload | MutationPayload,
): Promise<NotificationResult> => {
  const payload = await resolvePayload(event);
  if (!payload) return { ok: false, error: "Could not resolve notification payload" };

  const { channel, to, message, subject = "Notification from gennaroanesi.com" } = payload;

  switch (channel) {
    case "SMS":       return sendSms(to, message);
    case "EMAIL":     return sendEmail(to, message, subject);
    case "WHATSAPP":  return sendWhatsApp(to, message);
    default:          return { ok: false, error: `Unknown channel: ${channel}` };
  }
};
