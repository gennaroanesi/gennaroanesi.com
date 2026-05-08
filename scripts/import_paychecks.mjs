/**
 * import_paychecks.mjs
 *
 * Backfill a year of paychecks into financePaycheck from a single PDF.
 *
 * Use case: Workday year-end summary, exported paystub bundle, or any
 * other PDF that contains every 2025 stub. Sends the whole PDF to Claude
 * which returns an ARRAY of paycheck objects matching the financePaycheck
 * schema. Script then prints a summary and (unless --dry-run) creates
 * each row via the createFinancePaycheck mutation.
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY environment variable
 *   - Cognito admin user (financePaycheck is admin-only)
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *   node scripts/import_paychecks.mjs \
 *     --pdf=./paychecks_2025.pdf \
 *     --user=you@example.com --pass=yourpassword \
 *     [--env=sandbox|prod] [--dry-run] [--default-person=ME|SPOUSE]
 *
 * Flags:
 *   --pdf            Path to the PDF on disk. Required.
 *   --user, --pass   Cognito admin credentials. Required for write.
 *   --env            sandbox | prod. Default prod.
 *   --dry-run        Extract + print but don't create any rows.
 *   --default-person Fallback person (ME or SPOUSE) for stubs the parser
 *                    can't classify by name. Without it, unclassified
 *                    rows are skipped with a warning.
 */

import { readFileSync } from "fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";

// ── Args ──────────────────────────────────────────────────────────────────────

const pdfArg     = process.argv.find((a) => a.startsWith("--pdf="))?.split("=")[1];
const userArg    = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const passArg    = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];
const dryRun     = process.argv.includes("--dry-run");
const defPerson  = process.argv.find((a) => a.startsWith("--default-person="))?.split("=")[1];

if (!pdfArg) {
  console.error("Missing --pdf=<path>. See header for usage.");
  process.exit(1);
}
if (!dryRun && (!userArg || !passArg)) {
  console.error("Missing --user / --pass (required unless --dry-run). See header for usage.");
  process.exit(1);
}
if (defPerson && defPerson !== "ME" && defPerson !== "SPOUSE") {
  console.error(`--default-person must be ME or SPOUSE; got "${defPerson}"`);
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY env var.");
  process.exit(1);
}

const { region: REGION, clientId: CLIENT_ID, appsyncUrl: APPSYNC_URL } = getConfig();

// ── Anthropic ────────────────────────────────────────────────────────────────

const MODEL_ID  = "claude-sonnet-4-6";
const MAX_TOKENS = 16000; // generous — a year of biweekly stubs ≈ 26 rows × ~250 tokens

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACTION_PROMPT = `You are extracting an ARRAY of US pay stubs from a PDF. The PDF may contain:
- a tabular year-end summary listing one row per paycheck
- multiple individual paystubs concatenated
- a mixed format (summary + detail pages)

Return ONLY a JSON array of objects — no commentary, no markdown fences, no explanation. Each object follows this schema (all monetary fields are USD dollars, no symbols, no commas; null when not visible):

{
  "person":               "ME" | "SPOUSE" | null,
  "payDate":              "YYYY-MM-DD",
  "periodStart":          "YYYY-MM-DD" | null,
  "periodEnd":            "YYYY-MM-DD" | null,
  "gross":                number,
  "taxableWage":          number | null,
  "net":                  number,
  "imputedGtl":           number | null,
  "fedWh":                number | null,
  "oasdi":                number | null,
  "medicare":             number | null,
  "contrib401k":          number | null,
  "contribAfterTax401k":  number | null,
  "hsa":                  number | null,
  "fsa":                  number | null,
  "medical":              number | null,
  "dental":               number | null,
  "vision":               number | null,
  "bonusGross":           number | null,
  "rsuGross":             number | null,
  "ytdGross":             number | null,
  "ytdTaxableWage":       number | null,
  "ytdFedWh":             number | null,
  "ytdOasdi":             number | null,
  "ytdMedicare":          number | null,
  "ytd401k":              number | null,
  "ytdAfterTax401k":      number | null,
  "ytdNet":               number | null,
  "ytdBonusGross":        number | null,
  "ytdRsuGross":          number | null
}

Field guidance (same rules as the single-stub extractor — apply per row):
- "person": map first name to ME/SPOUSE — "Gennaro" → "ME", "Cristine" → "SPOUSE", else null. If the document is clearly one person's paystubs throughout, set person on every row consistently.
- "gross": CASH gross pay this period — the headline "Gross Pay" value. Do NOT include imputed income, RSU vest amounts, or bonuses double-counted there. Sanity check: gross ≈ pretax + taxes + posttax + net for the period. RSU-only stubs have gross = 0 (no cash); bonus stubs have gross = bonus amount.
- "taxableWage": Federal Withholding - Taxable Wages. NOT OASDI/Medicare taxable wages.
- "imputedGtl": imputed group-term life > $50k. Captured separately, do NOT add to gross.
- "rsuGross": Restricted Stock Units / RSU Vest / Stock Vest earnings rows. Excluded from gross.
- "bonusGross": explicit Bonus / Annual Bonus / Sign-on Bonus rows. Excluded from gross.
- "contrib401k": EMPLOYEE pre-tax 401k. Do NOT include employer match.
- "contribAfterTax401k": employee after-tax / mega-backdoor 401k.
- For YTD values, use the YTD column on the row when present.

If the document contains multiple persons, each row gets the right person tag — don't aggregate across people.

Return ONLY the JSON array. If you cannot read the document or it isn't paystub data, return {"error": "<short reason>"}.`;

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getJwt() {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const res = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
    }),
  );
  if (!res.AuthenticationResult?.IdToken) {
    throw new Error("Auth failed — check user/pass. Challenge: " + res.ChallengeName);
  }
  return res.AuthenticationResult.IdToken;
}

let JWT;

async function gql(query, variables = {}) {
  const res = await fetch(APPSYNC_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: JWT },
    body:    JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

const CREATE_PAYCHECK = `
  mutation CreatePaycheck($input: CreateFinancePaycheckInput!) {
    createFinancePaycheck(input: $input) {
      id
      person
      payDate
    }
  }`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractJson(text) {
  const trimmed  = text.trim();
  const fenceRe  = /```(?:json)?\s*([\s\S]*?)```/;
  const match    = trimmed.match(fenceRe);
  return JSON.parse(match ? match[1].trim() : trimmed);
}

function pickNumber(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickString(v) {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Coerce a parsed paycheck object into the exact financePaycheck schema
// shape, dropping unknown keys and normalizing types. Returns null if
// required fields are missing.
function coerceRow(raw) {
  const personRaw = pickString(raw.person);
  const person = personRaw === "ME" || personRaw === "SPOUSE" ? personRaw : null;
  const payDate = pickString(raw.payDate);
  const gross   = pickNumber(raw.gross);
  const net     = pickNumber(raw.net);
  if (!payDate || gross == null || net == null) return null;

  const out = {
    person:              person ?? defPerson ?? null,
    payDate,
    periodStart:         pickString(raw.periodStart),
    periodEnd:           pickString(raw.periodEnd),
    gross,
    taxableWage:         pickNumber(raw.taxableWage),
    net,
    imputedGtl:          pickNumber(raw.imputedGtl),
    fedWh:               pickNumber(raw.fedWh),
    oasdi:               pickNumber(raw.oasdi),
    medicare:            pickNumber(raw.medicare),
    contrib401k:         pickNumber(raw.contrib401k),
    contribAfterTax401k: pickNumber(raw.contribAfterTax401k),
    hsa:                 pickNumber(raw.hsa),
    fsa:                 pickNumber(raw.fsa),
    medical:             pickNumber(raw.medical),
    dental:              pickNumber(raw.dental),
    vision:              pickNumber(raw.vision),
    bonusGross:          pickNumber(raw.bonusGross),
    rsuGross:            pickNumber(raw.rsuGross),
    ytdGross:            pickNumber(raw.ytdGross),
    ytdTaxableWage:      pickNumber(raw.ytdTaxableWage),
    ytdFedWh:            pickNumber(raw.ytdFedWh),
    ytdOasdi:            pickNumber(raw.ytdOasdi),
    ytdMedicare:         pickNumber(raw.ytdMedicare),
    ytd401k:             pickNumber(raw.ytd401k),
    ytdAfterTax401k:     pickNumber(raw.ytdAfterTax401k),
    ytdNet:              pickNumber(raw.ytdNet),
    ytdBonusGross:       pickNumber(raw.ytdBonusGross),
    ytdRsuGross:         pickNumber(raw.ytdRsuGross),
  };
  // Strip nulls for fields not in the schema's required set (cleaner mutation
  // payload — Amplify will accept nulls but they bloat the request).
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  // person is required by the schema enum, but null is the parser's "I
  // couldn't tell" signal. Caller filters those out before mutation.
  if (person == null && !defPerson) out.person = null;
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Read PDF
  const pdfBytes = readFileSync(pdfArg);
  console.log(`PDF: ${pdfArg} (${(pdfBytes.length / 1024).toFixed(1)} KB)`);

  // 2. Extract via Claude
  console.log(`Extracting via ${MODEL_ID}…`);
  const resp = await anthropic.messages.create({
    model:      MODEL_ID,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: "user",
      content: [
        {
          type: "document",
          source: {
            type:       "base64",
            media_type: "application/pdf",
            data:       pdfBytes.toString("base64"),
          },
        },
        { type: "text", text: EXTRACTION_PROMPT },
      ],
    }],
  });

  const textBlock = resp.content.find((b) => b.type === "text");
  if (!textBlock) {
    console.error("No text in Claude response.");
    process.exit(1);
  }

  let parsed;
  try {
    parsed = extractJson(textBlock.text);
  } catch (e) {
    console.error("Could not parse Claude output as JSON:", e.message);
    console.error("Raw response:", textBlock.text.slice(0, 500));
    process.exit(1);
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) {
    console.error("Parser self-reported error:", parsed.error);
    process.exit(1);
  }
  if (!Array.isArray(parsed)) {
    console.error("Expected JSON array, got:", typeof parsed);
    process.exit(1);
  }

  // 3. Coerce + filter
  const coerced = parsed.map(coerceRow).filter(Boolean);
  const ready   = coerced.filter((r) => r.person);
  const skipped = coerced.filter((r) => !r.person);

  console.log(`\nExtracted ${parsed.length} row(s); ${ready.length} ready to create, ${skipped.length} skipped (no person).`);
  if (skipped.length > 0) {
    console.log(`  ↳ skipped rows had no detectable name. Pass --default-person=ME|SPOUSE to assign them all.\n`);
  }

  // 4. Print summary table
  const sorted = [...ready].sort((a, b) => a.payDate.localeCompare(b.payDate));
  for (const r of sorted) {
    const sup = [r.bonusGross && `bonus $${r.bonusGross}`, r.rsuGross && `RSU $${r.rsuGross}`].filter(Boolean).join(", ");
    console.log(
      `  ${r.payDate}  ${r.person.padEnd(6)}  gross $${(r.gross ?? 0).toFixed(2).padStart(10)}  net $${(r.net ?? 0).toFixed(2).padStart(10)}` +
      (sup ? `  · ${sup}` : ""),
    );
  }

  if (dryRun) {
    console.log(`\n[dry-run] Would create ${ready.length} paycheck row(s). Re-run without --dry-run to commit.`);
    return;
  }

  // 5. Create rows
  console.log(`\nAuthenticating…`);
  JWT = await getJwt();

  let ok = 0, fail = 0;
  for (const row of sorted) {
    try {
      const data = await gql(CREATE_PAYCHECK, { input: row });
      const created = data.createFinancePaycheck;
      console.log(`  ✓  ${created.payDate} ${created.person}  → ${created.id}`);
      ok++;
    } catch (e) {
      console.error(`  ✗  ${row.payDate} ${row.person}: ${e.message}`);
      fail++;
    }
  }

  console.log(`\nDone. ${ok} created, ${fail} failed.`);
  if (skipped.length > 0) {
    console.log(`(${skipped.length} row(s) were skipped due to missing person — re-run with --default-person to include them.)`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
