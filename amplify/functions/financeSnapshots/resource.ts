import { defineFunction } from "@aws-amplify/backend";

// Daily account-snapshot Lambda. Triggered by an EventBridge cron (see
// backend.ts) at 11:00 UTC, captures one financeAccountSnapshot row per
// account for yesterday (America/Chicago local). Also supports ad-hoc
// backfill: invoking with { targetDate: "YYYY-MM-DD" } or
// { fromDate, toDate } walks a specific range for all accounts.
export const financeSnapshots = defineFunction({
  name: "financeSnapshots",
  entry: "./handler.ts",
  timeoutSeconds: 300,      // backfill over many days + accounts can be slow
  memoryMB: 512,
  resourceGroupName: "data",
});
