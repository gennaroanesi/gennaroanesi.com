/**
 * checkAmmoThresholds Lambda
 *
 * Triggered by DynamoDB Streams on the inventoryAmmo table.
 * On each UPDATE event, recalculates per-caliber roundsAvailable totals
 * and compares against all enabled ammoThreshold records.
 * For each threshold breached, calls sendNotification via Lambda invoke.
 *
 * Also exported as `handler` so it can be invoked manually for testing.
 */

import {
  DynamoDBClient,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import {
  LambdaClient,
  InvokeCommand,
} from "@aws-sdk/client-lambda";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBStreamEvent } from "aws-lambda";

const dynamo = new DynamoDBClient({});
const lambda = new LambdaClient({});

const AMMO_TABLE      = process.env.AMMO_TABLE_NAME!;
const THRESHOLD_TABLE = process.env.THRESHOLD_TABLE_NAME!;
const PERSON_TABLE    = process.env.PERSON_TABLE_NAME!;
const NOTIFY_FN_ARN   = process.env.SEND_NOTIFICATION_ARN!;

// ── Types matching our Amplify schema ────────────────────────────────────────

type AmmoRecord = {
  itemId:          string;
  caliber:         string;
  roundsAvailable: number;
};

type ThresholdRecord = {
  id:        string;
  caliber:   string;
  minRounds: number;
  personId:  string;
  enabled:   boolean;
};

type PersonRecord = {
  id:               string;
  name:             string;
  phone:            string;
  email:            string;
  preferredChannel: "SMS" | "WHATSAPP" | "EMAIL";
  active:           boolean;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function scanAll<T>(tableName: string): Promise<T[]> {
  const results: T[] = [];
  let lastKey: Record<string, any> | undefined;
  do {
    const resp = await dynamo.send(new ScanCommand({
      TableName:         tableName,
      ExclusiveStartKey: lastKey,
    }));
    (resp.Items ?? []).forEach((item) => results.push(unmarshall(item) as T));
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);
  return results;
}

async function invokeNotification(payload: {
  channel: "SMS" | "WHATSAPP" | "EMAIL";
  to: string;
  message: string;
}) {
  await lambda.send(new InvokeCommand({
    FunctionName:   NOTIFY_FN_ARN,
    InvocationType: "Event", // async fire-and-forget
    Payload:        Buffer.from(JSON.stringify(payload)),
  }));
}

// ── Main handler ─────────────────────────────────────────────────────────────

export const handler = async (event: DynamoDBStreamEvent) => {
  // Only act on MODIFY events (roundsAvailable changes)
  const hasModify = event.Records.some((r) => r.eventName === "MODIFY");
  if (!hasModify) return;

  // 1. Load all ammo records and sum roundsAvailable per caliber
  const allAmmo = await scanAll<AmmoRecord>(AMMO_TABLE);
  const availByCAliber = allAmmo.reduce<Record<string, number>>((acc, r) => {
    const cal = r.caliber ?? "Unknown";
    acc[cal] = (acc[cal] ?? 0) + (r.roundsAvailable ?? 0);
    return acc;
  }, {});

  // 2. Load enabled thresholds
  const thresholds = (await scanAll<ThresholdRecord>(THRESHOLD_TABLE))
    .filter((t) => t.enabled !== false);

  if (thresholds.length === 0) return;

  // 3. Load persons
  const persons = await scanAll<PersonRecord>(PERSON_TABLE);
  const personMap = new Map(persons.map((p) => [p.id, p]));

  // 4. Check each threshold
  for (const threshold of thresholds) {
    const available = availByCAliber[threshold.caliber] ?? 0;
    if (available >= threshold.minRounds) continue; // above threshold, skip

    const person = personMap.get(threshold.personId);
    if (!person || person.active === false) continue;

    const channel = person.preferredChannel ?? "SMS";
    const to      = channel === "EMAIL" ? person.email : person.phone;
    if (!to) {
      console.warn(`Person ${person.name} has no ${channel} contact`);
      continue;
    }

    const message =
      `⚠️ Low ammo alert: ${threshold.caliber} is down to ${available.toLocaleString()} rounds ` +
      `(threshold: ${threshold.minRounds.toLocaleString()} rds).`;

    console.log(`[checkAmmoThresholds] Notifying ${person.name} via ${channel}: ${message}`);

    await invokeNotification({ channel, to, message });
  }
};
