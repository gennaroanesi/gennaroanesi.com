import { defineFunction } from "@aws-amplify/backend";

// Weekly cashflow briefing Lambda. Triggered by an EventBridge cron (see
// backend.ts) on Monday mornings ~7 AM America/Chicago. Loads finance accounts +
// recurring rules, runs the pure engine, and emails an actionable briefing via
// SES. Also invokable ad-hoc with { dryRun: true } or { to: "addr" }.
//
// Data access is granted via schema-level allow.resource(weeklyCashflow) in
// amplify/data/resource.ts. SES send permission + env are wired in backend.ts.
export const weeklyCashflow = defineFunction({
  name: "weeklyCashflow",
  entry: "./handler.ts",
  timeoutSeconds: 120,
  memoryMB: 512,
  resourceGroupName: "data",
  environment: {
    // Sender must be an SES-verified identity. The gennaroanesi.com domain is
    // verified in SES (us-east-1), so send from noreply@. Do NOT use an
    // @gmail.com From — Gmail silently drops mail claiming to be from a
    // gmail.com address that didn't originate from Google's servers, so SES
    // reports success (MessageId) but the briefing never reaches the inbox.
    SES_FROM_EMAIL:  "noreply@gennaroanesi.com",
    WEEKLY_TO_EMAIL: "gennaroanesi@gmail.com",
    BUFFER:          "750",
  },
});
