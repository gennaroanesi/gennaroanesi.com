/**
 * importLogbook/handler.ts
 *
 * Triggered by S3 PutObject when SES drops a raw inbound email into
 * s3://gennaroanesi.com/private/email-import/
 *
 * Pipeline:
 *   1. Fetch raw email from S3
 *   2. Parse MIME — find the ForeFlight CSV attachment
 *   3. Parse CSV (same logic as import_flights.mjs)
 *   4. Fetch existing flight keys from DynamoDB for dedup
 *   5. Create new flights via AppSync mutation
 *   6. Reply to sender with an import summary via SES
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import {
  DynamoDBClient,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { S3Event } from "aws-lambda";

const s3     = new S3Client({ region: "us-east-1" });
const ses    = new SESClient({ region: "us-east-1" });
const dynamo = new DynamoDBClient({ region: "us-east-1" });

const APPSYNC_URL  = process.env.APPSYNC_URL!;
const APPSYNC_KEY  = process.env.APPSYNC_API_KEY!;
const FLIGHT_TABLE = process.env.FLIGHT_TABLE_NAME!;
const FROM_EMAIL   = "noreply@gennaroanesi.com";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FlightInput {
  date: string;
  from: string;
  to: string;
  route: string | null;
  aircraftId: string | null;
  aircraftType: string | null;
  totalTime: number | null;
  pic: number | null;
  sic: number | null;
  solo: number | null;
  night: number | null;
  actualIMC: number | null;
  simulatedIMC: number | null;
  crossCountry: number | null;
  dualReceived: number | null;
  dualGiven: number | null;
  dayLandings: number | null;
  nightLandings: number | null;
  approaches: number | null;
  approachTypes: string | null;
  flightType: string;
  conditions: string;
  kmlS3Key: null;
  title: null;
  milestone: string | null;
  notes: string | null;
  published: boolean;
}

// ── MIME parser ───────────────────────────────────────────────────────────────
// Minimal RFC 2822 / MIME parser — extracts CSV attachments from ForeFlight emails.

function decodeMimePart(content: string, encoding: string): string {
  if (encoding.toLowerCase() === "base64") {
    return Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
  }
  if (encoding.toLowerCase() === "quoted-printable") {
    return content
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      );
  }
  return content; // 7bit / 8bit
}

function extractCsvFromEmail(rawEmail: string): { csv: string; senderEmail: string } | null {
  const lines = rawEmail.split(/\r?\n/);

  // Extract sender for reply
  let senderEmail = "";
  for (const line of lines) {
    const m = line.match(/^From:\s*.*?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i);
    if (m) { senderEmail = m[1]; break; }
  }

  // Find boundary
  let boundary = "";
  for (const line of lines) {
    const m = line.match(/boundary="?([^";\r\n]+)"?/i);
    if (m) { boundary = m[1].trim(); break; }
  }

  if (!boundary) {
    // Single-part email — check if body itself is CSV
    const body = rawEmail.split(/\r?\n\r?\n/).slice(1).join("\n\n");
    if (body.includes("Date,AircraftID") || body.includes("Flights Table")) {
      return { csv: body, senderEmail };
    }
    return null;
  }

  // Split on MIME boundaries
  const parts = rawEmail.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?`));

  for (const part of parts) {
    if (!part.trim() || part.trim() === "--") continue;

    const [headerBlock, ...bodyParts] = part.split(/\r?\n\r?\n/);
    const headers = headerBlock.toLowerCase();
    const body    = bodyParts.join("\n\n");

    // Look for CSV attachment
    const isCSV = headers.includes("text/csv") ||
      headers.includes("application/csv") ||
      headers.includes("application/octet-stream") ||
      headers.match(/filename="?[^"]*\.csv"?/i);

    if (!isCSV) continue;

    // Determine content-transfer-encoding
    const encMatch = headerBlock.match(/content-transfer-encoding:\s*(\S+)/i);
    const encoding = encMatch ? encMatch[1] : "7bit";

    const decoded = decodeMimePart(body.trim(), encoding);
    if (decoded.includes("Flights Table") || decoded.includes("Date,AircraftID")) {
      return { csv: decoded, senderEmail };
    }
  }

  return null;
}

// ── CSV parser (ported from import_flights.mjs) ───────────────────────────────

function splitRow(row: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuote && row[i + 1] === '"') { current += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseApproaches(f: Record<string, string>) {
  const cols = ["Approach1","Approach2","Approach3","Approach4","Approach5","Approach6"];
  const results: string[] = [];
  for (const col of cols) {
    const val = f[col];
    if (!val) continue;
    const parts = val.split(";");
    const count = parseInt(parts[0]) || 0;
    const type  = parts[1]?.trim() || "";
    const arpt  = parts[3]?.trim() || "";
    if (count > 0 && type) results.push(`${type}@${arpt}`);
  }
  return {
    approaches:    results.length || null,
    approachTypes: results.length > 0 ? results.join(", ") : null,
  };
}

function inferFlightType(f: Record<string, string>): string {
  const comments = ((f.InstructorComments || "") + " " + (f.PilotComments || "")).toLowerCase();
  if (f["Checkride (FAA)"] === "1" || comments.includes("checkride")) return "CHECKRIDE";
  if (parseFloat(f.Solo || "0") > 0) return "SOLO";
  if (parseFloat(f.CrossCountry || "0") > 0) return "CROSS_COUNTRY";
  if (comments.includes("discovery") || comments.includes("intro")) return "INTRO";
  if (parseFloat(f.DualReceived || "0") > 0) return "TRAINING";
  return "OTHER";
}

function inferConditions(f: Record<string, string>): string {
  if (parseFloat(f.ActualInstrument || "0") > 0) return "IMC";
  if (parseFloat(f.IFR || "0") > 0) return "IFR";
  return "VFR";
}

function inferMilestone(f: Record<string, string>): string | null {
  const comments = ((f.InstructorComments || "") + " " + (f.PilotComments || "")).toLowerCase();
  if (f["Checkride (FAA)"] === "1") return "Checkride";
  if (f["IPC (FAA)"] === "1") return "IPC";
  if (f["Flight Review (FAA)"] === "1") return "Flight Review";
  if (comments.includes("first solo")) return "First Solo";
  return null;
}

const f2 = (v: string): number | null => { const n = parseFloat(v); return isNaN(n) ? null : n; };
const i2 = (v: string): number | null => { const n = parseInt(v);   return isNaN(n) ? null : n; };
const str = (v: string): string | null => (v && v.trim() !== "" ? v.trim() : null);

function rowToFlight(
  headers: string[],
  values: string[],
  aircraftMap: Record<string, string>,
): FlightInput | null {
  const f: Record<string, string> = {};
  headers.forEach((h, i) => { f[h] = values[i] ?? ""; });

  if (!str(f.From) && !str(f.To) && f2(f.TotalTime) === 0) return null;
  if (!str(f.Date)) return null;

  const { approaches, approachTypes } = parseApproaches(f);
  const dayLandings   = (i2(f["Landing Full-Stop Day"])   ?? 0) + (i2(f["Landing Touch-and-Go Day"])   ?? 0);
  const nightLandings = (i2(f["Landing Full-Stop Night"]) ?? 0) + (i2(f["Landing Touch-and-Go Night"]) ?? 0);
  const notes = str(f.InstructorComments) ?? str(f.PilotComments) ?? null;

  return {
    date:         f.Date,
    from:         str(f.From)      ?? "",
    to:           str(f.To)        ?? "",
    route:        str(f.Route),
    aircraftId:   str(f.AircraftID),
    aircraftType: aircraftMap[f.AircraftID] ?? null,
    totalTime:    f2(f.TotalTime),
    pic:          f2(f.PIC),
    sic:          f2(f.SIC),
    solo:         f2(f.Solo),
    night:        f2(f.Night),
    actualIMC:    f2(f.ActualInstrument),
    simulatedIMC: f2(f.SimulatedInstrument),
    crossCountry: f2(f.CrossCountry),
    dualReceived: f2(f.DualReceived),
    dualGiven:    f2(f.DualGiven),
    dayLandings:  dayLandings  || null,
    nightLandings: nightLandings || null,
    approaches,
    approachTypes,
    flightType:   inferFlightType(f),
    conditions:   inferConditions(f),
    kmlS3Key:     null,
    title:        null,
    milestone:    inferMilestone(f),
    notes,
    published:    false,
  };
}

function parseForeFlight(csvText: string): { flights: FlightInput[] } {
  const lines = csvText.split(/\r?\n/);

  const flightsStart  = lines.findIndex((l) => l.startsWith("Flights Table"));
  const aircraftStart = lines.findIndex((l) => l.startsWith("Aircraft Table"));

  // Build aircraft type map
  const aircraftMap: Record<string, string> = {};
  if (aircraftStart >= 0) {
    const aHeaders = splitRow(lines[aircraftStart + 1] || "");
    for (let i = aircraftStart + 2; i < lines.length; i++) {
      const row = lines[i].trim();
      if (!row || row.startsWith("Flights Table")) break;
      const vals = splitRow(row);
      const rec: Record<string, string> = {};
      aHeaders.forEach((h, idx) => { rec[h] = vals[idx] ?? ""; });
      if (rec.AircraftID) aircraftMap[rec.AircraftID] = rec.TypeCode || rec.Model || "";
    }
  }

  if (flightsStart < 0) return { flights: [] };

  const headers = splitRow(lines[flightsStart + 1] || "");
  const flights: FlightInput[] = [];

  for (let i = flightsStart + 2; i < lines.length; i++) {
    const row = lines[i].trim();
    if (!row) continue;
    const flight = rowToFlight(headers, splitRow(row), aircraftMap);
    if (flight) flights.push(flight);
  }

  return { flights };
}

// ── DynamoDB dedup ────────────────────────────────────────────────────────────

async function fetchExistingKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  let lastKey: Record<string, any> | undefined;

  do {
    const result = await dynamo.send(new ScanCommand({
      TableName:            FLIGHT_TABLE,
      ProjectionExpression: "#d, #f, #t, aircraftId",
      ExpressionAttributeNames: { "#d": "date", "#f": "from", "#t": "to" },
      ExclusiveStartKey:    lastKey,
    }));
    for (const item of result.Items ?? []) {
      const r = unmarshall(item);
      keys.add(`${r.date}|${r.from}|${r.to}|${r.aircraftId}`);
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return keys;
}

// ── AppSync mutation ──────────────────────────────────────────────────────────

const CREATE_FLIGHT = /* graphql */ `
  mutation CreateFlight($input: CreateFlightInput!) {
    createFlight(input: $input) { id date from to aircraftId }
  }
`;

async function createFlight(flight: FlightInput): Promise<string | null> {
  const res = await fetch(APPSYNC_URL, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key":    APPSYNC_KEY,
    },
    body: JSON.stringify({ query: CREATE_FLIGHT, variables: { input: flight } }),
  });
  const data: any = await res.json();
  if (data.errors) {
    console.error("[importLogbook] mutation error:", JSON.stringify(data.errors));
    return null;
  }
  return data.data?.createFlight?.id ?? null;
}

// ── SES reply ─────────────────────────────────────────────────────────────────

async function sendSummaryEmail(
  to: string,
  created: number,
  skipped: number,
  errored: number,
  total: number,
) {
  if (!to) return;
  await ses.send(new SendEmailCommand({
    Source:      FROM_EMAIL,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: `Logbook import complete — ${created} flights added` },
      Body: {
        Text: {
          Data: [
            `Your ForeFlight logbook import finished.`,
            ``,
            `  Flights in CSV : ${total}`,
            `  Created        : ${created}`,
            `  Skipped (dups) : ${skipped}`,
            `  Errors         : ${errored}`,
            ``,
            `New flights are unpublished. Review and publish them at:`,
            `https://gennaroanesi.com/admin`,
          ].join("\n"),
        },
      },
    },
  }));
}

// ── Lambda handler ────────────────────────────────────────────────────────────

export const handler = async (event: S3Event) => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key    = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    console.log(`[importLogbook] processing s3://${bucket}/${key}`);

    // 1. Fetch raw email from S3
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const rawEmail = await obj.Body!.transformToString("utf8");

    // 2. Extract CSV attachment + sender
    const extracted = extractCsvFromEmail(rawEmail);
    if (!extracted) {
      console.warn("[importLogbook] no ForeFlight CSV found in email — skipping");
      continue;
    }
    const { csv, senderEmail } = extracted;
    console.log(`[importLogbook] CSV extracted (${csv.length} chars), sender: ${senderEmail}`);

    // 3. Parse CSV
    const { flights } = parseForeFlight(csv);
    console.log(`[importLogbook] parsed ${flights.length} flight rows`);

    // 4. Dedup against existing DB
    const existingKeys = await fetchExistingKeys();
    console.log(`[importLogbook] ${existingKeys.size} existing flights in DB`);

    // 5. Import
    let created = 0, skipped = 0, errored = 0;

    for (const flight of flights) {
      const key = `${flight.date}|${flight.from}|${flight.to}|${flight.aircraftId}`;
      if (existingKeys.has(key)) {
        skipped++;
        continue;
      }
      const id = await createFlight(flight);
      if (id) {
        console.log(`[importLogbook] created ${flight.date} ${flight.from}→${flight.to} id=${id}`);
        created++;
      } else {
        errored++;
      }
    }

    console.log(`[importLogbook] done — created=${created} skipped=${skipped} errored=${errored}`);

    // 6. Send summary email to sender
    await sendSummaryEmail(senderEmail, created, skipped, errored, flights.length);
  }
};
