import { defineFunction } from "@aws-amplify/backend";

// Invoice email processor. Triggered by S3 object-created on
// private/invoice-inbound/ (SES drops raw email for invoices@gennaroanesi.com
// there — see scripts/setup-ses-inbound.sh). Parses the email, stores a PDF
// facsimile + the raw .eml under private/invoices/{invoiceId}/, extracts
// structured fields with Claude, creates a financeInvoice row, and
// auto-links to a matching financeTransaction when exactly one candidate
// matches on date window + amount.
//
// Chromium bundling: the HTML→PDF fallback needs a real Chromium binary,
// which cannot survive esbuild bundling. Of the two viable shapes —
// (a) custom-provider defineFunction((scope) => NodejsFunction) with
// bundling.nodeModules, or (b) standard defineFunction + a public
// @sparticuz/chromium Lambda layer — we use (b): the `layers` option below
// attaches shelf.io's layer (Chromium v149.0.0, matching the
// @sparticuz/chromium@149 npm dep used for types/args) AND makes Amplify
// mark the module external in the esbuild bundle. Standard defineFunction
// keeps allow.resource(...) data access and the $amplify/env stub working,
// which the custom-provider form would lose. puppeteer-core is pure JS and
// bundles fine. VERIFY ON DEPLOY: layer ARN exists in this account's region
// and the function launches Chromium (send a no-attachment test email).
//
// Memory 2048 MB / 120 s: Chromium needs ~1 GB+ headroom; Claude extraction
// of a multi-page PDF plus S3 round-trips fit comfortably in the timeout.
//
// ANTHROPIC_API_KEY is injected from the existing gennaroanesi/transcribe
// secret in backend.ts (same pattern as parsePaycheckPdf).
export const invoiceProcessor = defineFunction({
  name: "invoiceProcessor",
  entry: "./handler.ts",
  timeoutSeconds: 120,
  memoryMB: 2048,
  resourceGroupName: "data",
  layers: {
    // x86_64, us-east-1 — Chromium v149.0.0 (github.com/shelfio/chrome-aws-lambda-layer)
    "@sparticuz/chromium": "arn:aws:lambda:us-east-1:764866452798:layer:chrome-aws-lambda:115",
  },
});
