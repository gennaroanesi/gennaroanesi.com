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
    // Sender must be an SES-verified identity. Using the verified Gmail for now;
    // switch to "noreply@gennaroanesi.com" once the gennaroanesi.com domain is
    // verified in SES (us-east-1).
    SES_FROM_EMAIL:  "gennaroanesi@gmail.com",
    WEEKLY_TO_EMAIL: "gennaroanesi@gmail.com",
    BUFFER:          "750",
  },
});
