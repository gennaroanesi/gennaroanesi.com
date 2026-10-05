import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TX_SELECTION_SET, INVOICE_LINK_SELECTION_SET } from "@/components/finance/data";

/**
 * Raw-GraphQL selection sets are hand-maintained strings, and a field on the
 * model but missing from its selection set is NOT an error — it reads back
 * `undefined` and silently takes whatever default the consumer applies. That
 * exact failure shipped once: `kind` was missing from BUDGET_FIELDS, so every
 * income budget came back as a spending bucket and inflated the allocation
 * total by $16,660 with no error anywhere.
 *
 * budget.test.ts guards BUDGET_SELECTION_SET against the fields the engine
 * reads. This file guards the transaction selection sets against the schema
 * itself, which is stricter: adding a field to amplify/data/resource.ts and
 * forgetting the selection set fails here, without anyone having to remember to
 * extend a hand-written list of "fields we read". It found `sfTransactionId`
 * already missing when it was written.
 */

const SCHEMA_PATH = fileURLToPath(
  new URL("../../../amplify/data/resource.ts", import.meta.url),
);

/** Amplify field kinds that are relationships, not selectable scalars. */
const RELATIONSHIP_KINDS = new Set(["hasMany", "hasOne", "belongsTo", "manyToMany"]);

/**
 * Scalar field names declared on one model in amplify/data/resource.ts.
 *
 * Parsed from source rather than introspected off the schema object: the Gen2
 * builder's field metadata lives behind undocumented internals that change
 * between releases, and a brittle test that silently stops asserting is worse
 * than no test. The declarations are a stable, boring shape — `name: a.kind()`
 * at six-space indent inside `.model({ … })`.
 */
function declaredScalarFields(modelName: string): string[] {
  const src = readFileSync(SCHEMA_PATH, "utf8");
  const start = src.indexOf(`  ${modelName}: a`);
  if (start < 0) throw new Error(`model ${modelName} not found in ${SCHEMA_PATH}`);

  const open = src.indexOf(".model({", start);
  if (open < 0) throw new Error(`model ${modelName} has no .model({ … })`);
  let i = open + ".model({".length;
  let depth = 1;
  while (depth > 0 && i < src.length) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  const body = src.slice(open + ".model({".length, i - 1);

  const fields: string[] = [];
  for (const m of body.matchAll(/^ {6}([a-zA-Z][a-zA-Z0-9]*):\s*a\.(\w+)/gm)) {
    if (!RELATIONSHIP_KINDS.has(m[2])) fields.push(m[1]);
  }
  if (fields.length === 0) throw new Error(`parsed no fields for ${modelName} — the parser is broken, not the schema`);
  return fields;
}

const requested = (selectionSet: string) =>
  new Set(selectionSet.split(/\s+/).filter(Boolean));

describe("raw-GraphQL selection sets cover their models", () => {
  it("the parser actually sees financeTransaction's fields", () => {
    // Guards the guard: a silently-empty parse would make every assertion
    // below vacuously pass.
    const fields = declaredScalarFields("financeTransaction");
    expect(fields).toContain("amount");
    expect(fields).toContain("category");
    expect(fields).toContain("categorySource");
    expect(fields.length).toBeGreaterThan(15);
  });

  it("TX_SELECTION_SET requests every scalar on financeTransaction", () => {
    const have = requested(TX_SELECTION_SET);
    const missing = declaredScalarFields("financeTransaction").filter((f) => !have.has(f));
    expect(missing).toEqual([]);
  });

  it("INVOICE_LINK_SELECTION_SET requests every scalar on financeInvoiceLink", () => {
    const have = requested(INVOICE_LINK_SELECTION_SET);
    const missing = declaredScalarFields("financeInvoiceLink").filter((f) => !have.has(f));
    expect(missing).toEqual([]);
  });

  it("includes the implicit system fields a consumer may sort or dedupe on", () => {
    for (const set of [TX_SELECTION_SET, INVOICE_LINK_SELECTION_SET]) {
      const have = requested(set);
      expect(have.has("id")).toBe(true);
      expect(have.has("createdAt")).toBe(true);
      expect(have.has("updatedAt")).toBe(true);
    }
  });
});
