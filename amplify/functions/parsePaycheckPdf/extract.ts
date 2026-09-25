/**
 * parsePaycheckPdf/extract.ts
 *
 * Shared paystub → JSON extraction. Used by the parsePaycheckPdf mutation
 * (manual upload in the UI) and by paycheckProcessor (paychecks@ inbound
 * email), so both paths read stubs with the identical prompt.
 */

import Anthropic from "@anthropic-ai/sdk";

const MODEL_ID   = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (_anthropic) return _anthropic;
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[paycheck-extract] ANTHROPIC_API_KEY missing — calls will fail.");
  }
  _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// ── Prompt ──────────────────────────────────────────────────────────────────
// Schema kept as a JSON object (not a TS type) so the model echoes the same
// keys back. Numeric fields are dollars, no currency symbols. Missing values
// → null, never a guess. lineItems captures the long tail (HSA, parking,
// ESPP, group-term life buyback, RSU vest, prior-period adjustments, …).

const EXTRACTION_PROMPT = `You are extracting structured data from a US pay stub PDF. Read the document carefully and return ONLY a JSON object — no commentary, no markdown fences, no explanation.

Schema (all monetary fields are USD dollars, no symbols, no commas; null when not present on the stub):

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
  "ytdGross":             number | null,
  "ytdTaxableWage":       number | null,
  "ytdFedWh":             number | null,
  "ytdOasdi":             number | null,
  "ytdMedicare":          number | null,
  "ytd401k":              number | null,
  "ytdAfterTax401k":      number | null,
  "ytdNet":               number | null,
  "bonusGross":           number | null,
  "rsuGross":             number | null,
  "ytdBonusGross":        number | null,
  "ytdRsuGross":          number | null,
  "w4FilingStatus":       "SINGLE" | "MFJ" | "MFS" | "HOH" | null,
  "w4ExtraWithholding":   number | null,
  "w4Dependents":         number | null,
  "lineItems": [
    {
      "name":   string,
      "amount": number,
      "ytd":    number | null,
      "type":   "PRETAX" | "POSTTAX" | "IMPUTED" | "EMPLOYER_PAID" | "EARNING" | "OTHER"
    }
  ]
}

Field guidance:
- "person" identifies the employee on the stub. Look at the Payslip Information section's "Name" field (or wherever the employee name appears). Map first names case-insensitively: "Gennaro" → "ME", "Cristine" → "SPOUSE". Any other name (or missing name) → null. If the stub clearly belongs to one but the spelling is slightly off (Cristina vs Cristine, etc.), still match on the first name initial pattern. Don't guess — null when unsure.
- "gross" is the CASH gross pay this period — the headline "Gross Pay" value at the top of the stub. Do NOT include imputed income (Imp GTL, GTL Coverage, imputed taxable benefits) even when it appears as an earnings line. Imputed income is reported separately under "imputedGtl" + as a lineItem of type IMPUTED. Sanity check: gross should equal (Pre Tax Deductions + Employee Taxes + Post Tax Deductions + Net Pay) for this period — if it doesn't, you've probably included imputed income; subtract it. Same rule for "ytdGross".
- "taxableWage" is the federal taxable wage for this period. On Workday-style stubs, look for the line literally labeled "Federal Withholding - Taxable Wages" (NOT "OASDI - Taxable Wages" or "Medicare - Taxable Wages" — those are different bases). On other stubs the equivalent labels include "Federal Taxable Wages" or "Taxable Federal Wages". Same rule for "ytdTaxableWage".
- "net" is the take-home / direct-deposit total for this period (the "Net Pay" header value).
- "fedWh" is federal income tax withheld (NOT FICA).
- "oasdi" is Social Security tax (sometimes labeled "OASDI", "Social Security", or "FICA-SS").
- "medicare" includes both regular Medicare (1.45%) and any Additional Medicare (0.9%) withheld.
- "imputedGtl" is imputed group-term life income (taxed but not paid in cash). Capture it here AND as a lineItem of type IMPUTED. Do NOT add it to "gross".
- "contrib401k" is the EMPLOYEE pre-tax 401k contribution this period. Do NOT include employer match.
- "contribAfterTax401k" is the employee after-tax / mega-backdoor 401k contribution.
- "rsuGross" is the sum of the Earnings table rows for THIS pay period whose label is "Restricted Stock Units", "RSU Vest", "Stock Vest", or any explicit equity-vest line. Do NOT include the RSU Tax Offset (that's a post-tax accounting entry, not earnings). Same row count for "ytdRsuGross" using the YTD Amount column. RSU vest paystubs typically have headline Gross Pay = $0 (no cash) — those are exactly the cases where rsuGross is non-null. RSU income IS taxable; it WILL appear in taxableWage / ytdTaxableWage and in the Federal/OASDI/Medicare withholding lines for that period. Don't worry about double-counting — gross stays cash-only.
- "bonusGross" is the sum of explicit bonus rows in the Earnings table this period: "Bonus", "Annual Bonus", "Performance Bonus", "Sign-on Bonus". Do NOT include base salary. Same row sum for "ytdBonusGross" using YTD column.
- "w4FilingStatus" / "w4ExtraWithholding" / "w4Dependents" come from the W-4 elections box — on Workday stubs it's the small table with "Federal" and "State" columns and rows "Marital Status", "Allowances", "Total Dependent Amount", "Additional Withholding". Use the Federal column only. Map Marital Status: "Single" (or "Single or Married filing separately") → "SINGLE", "Married filing jointly" (incl. "or Qualifying widow(er)") → "MFJ", "Married filing separately" → "MFS", "Head of household" → "HOH". "w4ExtraWithholding" is the "Additional Withholding" value (a per-period dollar election, e.g. 500); "w4Dependents" is "Total Dependent Amount". Report 0 when the stub literally shows 0; null only when the box is absent. These are elections, NOT deductions — do not add them to lineItems and do not subtract them from anything.
- For YTD values, use the YTD column on the stub. If the stub only shows current-period values, leave YTD nulls.
- lineItems should capture every deduction or earning row that doesn't map to one of the explicit fields above. Examples: parking, ESPP contribution, RSU vest gross-up, supplemental life insurance, dependent care FSA, commuter benefits, prior-period adjustments. Set "type" based on tax treatment:
    PRETAX        — reduces taxable wages (e.g. HSA, traditional 401k via employer plan, certain transit)
    POSTTAX       — taken from net (e.g. ESPP, post-tax life insurance, garnishments)
    IMPUTED       — non-cash benefit added to taxable wages (e.g. GTL > $50k coverage)
    EMPLOYER_PAID — reported but not deducted (e.g. employer-paid medical)
    EARNING       — non-base earnings (e.g. overtime, bonus paid this period, RSU vest amount)
    OTHER         — anything that doesn't fit cleanly

If you can't read the document or it isn't a paystub, return {"error": "<short reason>"} and nothing else.

Return ONLY the JSON object.`;

// Pull the JSON object out of Claude's response. The prompt asks for raw JSON
// only, but models occasionally still wrap in ```json fences — strip those
// defensively so a small formatting slip doesn't fail the whole flow.
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenceMatch ? fenceMatch[1].trim() : trimmed;
  return JSON.parse(body);
}

/**
 * Send a paystub PDF to Claude and return the parsed draft object, or an
 * error string. Never throws.
 */
export async function extractPaycheckFields(
  pdf: Buffer,
): Promise<{ draft: Record<string, unknown> | null; error: string | null }> {
  let resp;
  try {
    resp = await getAnthropic().messages.create({
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
              data:       pdf.toString("base64"),
            },
          },
          { type: "text", text: EXTRACTION_PROMPT },
        ],
      }],
    });
  } catch (err) {
    return { draft: null, error: `Claude call failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Grab the first text block — for this prompt, Claude returns a single
  // text content part.
  const textBlock = resp.content.find((b: any) => b.type === "text") as any;
  if (!textBlock) return { draft: null, error: "No text in Claude response" };

  let parsed: unknown;
  try {
    parsed = extractJson(textBlock.text);
  } catch (err) {
    return { draft: null, error: `Could not parse Claude JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { draft: null, error: "Claude returned a non-object" };
  }

  // Honor the model's own error-channel: {error: "..."}.
  if ("error" in (parsed as any)) {
    return { draft: null, error: String((parsed as any).error) };
  }
  return { draft: parsed as Record<string, unknown>, error: null };
}
