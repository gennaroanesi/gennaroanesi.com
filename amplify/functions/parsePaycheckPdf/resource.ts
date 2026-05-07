import { defineFunction } from "@aws-amplify/backend";

// Paycheck PDF extractor — pulls a pay-stub PDF from S3, sends it to Claude
// for structured field extraction, returns a draft `financePaycheck`-shaped
// JSON the frontend pre-fills into the create form for review.
//
// Memory: PDFs are small (typically <500 KB) but the base64 + Claude SDK
// allocations push past the 128 MB default. 512 MB matches gennaroAgent.
//
// ANTHROPIC_API_KEY is injected from the existing gennaroanesi/transcribe
// secret in backend.ts (same pattern as gennaroAgent).
export const parsePaycheckPdf = defineFunction({
  name: "parsePaycheckPdf",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  memoryMB: 512,
  resourceGroupName: "data",
});
