/**
 * whatsappAck/handler.ts
 *
 * Lambda A — Twilio webhook receiver.
 *
 * 1. Validates Twilio signature (rejects spoofed requests)
 * 2. Parses the inbound WhatsApp message
 * 3. Fires whatsappAgent Lambda asynchronously (Event invocation type)
 * 4. Returns empty 200 TwiML immediately so Twilio doesn't retry
 *
 * API Gateway trigger: POST /whatsapp/webhook
 * Must be a public endpoint (no Cognito auth) — Twilio calls it.
 */

import type { APIGatewayProxyHandler } from "aws-lambda";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import * as crypto from "crypto";

const lambda = new LambdaClient({});

// ── Twilio signature validation ───────────────────────────────────────────────
// https://www.twilio.com/docs/usage/webhooks/webhooks-security
function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  // Sort POST params alphabetically and append key+value to URL
  const sorted = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const expected = crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(sorted))
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature),
  );
}

// ── Parse URL-encoded Twilio body ─────────────────────────────────────────────
function parseBody(body: string): Record<string, string> {
  return Object.fromEntries(
    body.split("&").map((pair) => {
      const [k, v] = pair.split("=").map(decodeURIComponent);
      return [k, v ?? ""];
    }),
  );
}

// ── Handler ───────────────────────────────────────────────────────────────────
export const handler: APIGatewayProxyHandler = async (event) => {
  const authToken  = process.env.TWILIO_AUTH_TOKEN!;
  const agentArn   = process.env.AGENT_LAMBDA_ARN!;
  const webhookUrl = process.env.WEBHOOK_URL!; // e.g. https://xxx.execute-api.us-east-1.amazonaws.com/whatsapp/webhook

  // 1. Validate signature
  const signature = event.headers["X-Twilio-Signature"] ?? event.headers["x-twilio-signature"] ?? "";
  const params    = parseBody(event.body ?? "");

  if (authToken && signature) {
    const valid = validateTwilioSignature(authToken, signature, webhookUrl, params);
    if (!valid) {
      console.warn("Invalid Twilio signature — rejecting request");
      return { statusCode: 403, body: "Forbidden" };
    }
  }

  // 2. Only handle inbound messages (not status callbacks)
  const messageBody = params["Body"];
  const from        = params["From"]; // e.g. "whatsapp:+15551234567"
  if (!messageBody || !from) {
    // Status callback or unrecognised — ack silently
    return { statusCode: 200, body: "<Response/>" };
  }

  console.log(`Inbound from ${from}: ${messageBody.slice(0, 100)}`);

  // 3. Fire agent async — don't await
  await lambda.send(new InvokeCommand({
    FunctionName:   agentArn,
    InvocationType: "Event", // async — Lambda returns immediately
    Payload:        Buffer.from(JSON.stringify({ from, body: messageBody, params })),
  }));

  // 4. Empty TwiML response — Twilio won't send any reply message from this
  return {
    statusCode: 200,
    headers:    { "Content-Type": "text/xml" },
    body:       "<Response/>",
  };
};
