import { defineFunction } from "@aws-amplify/backend";

// Paystub email processor. Triggered by S3 object-created on
// private/paycheck-inbound/ (SES drops raw email for
// paychecks@gennaroanesi.com there — see scripts/setup-ses-inbound.sh).
// Pulls PDF attachments, stages them under attachments/PAYCHECK/staging/,
// extracts fields with Claude (shared prompt with parsePaycheckPdf), and
// creates financePaycheckInbox rows for human review. Never writes
// financePaycheck directly.
//
// No Chromium here (unlike invoiceProcessor): payroll providers only send
// "your statement is ready" notices, so a body render would be useless —
// forwarded emails must carry the PDF.
//
// ANTHROPIC_API_KEY is injected from the gennaroanesi/transcribe secret in
// backend.ts (same pattern as parsePaycheckPdf).
export const paycheckProcessor = defineFunction({
  name: "paycheckProcessor",
  entry: "./handler.ts",
  timeoutSeconds: 120,
  memoryMB: 512,
  resourceGroupName: "data",
});
