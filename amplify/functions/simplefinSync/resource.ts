import { defineFunction } from "@aws-amplify/backend";

// SimpleFIN daily-sync Lambda. Triggered by an EventBridge cron (see backend.ts)
// 3×/day (~4 AM / 12 PM / 7 PM America/Chicago, tolerating the 1-hour DST skew
// like financeSnapshots). Pulls balances + transactions + holdings from the
// SimpleFIN Bridge for every financeAccount that has simplefinAccountId set,
// dedups + categorizes, upserts transactions/balances/holdings, and writes one
// financeSyncLog audit row per run.
//
// Data access is granted via schema-level allow.resource(simplefinSync) in
// amplify/data/resource.ts. The SimpleFIN access URL (a secret) is injected as
// SIMPLEFIN_ACCESS_URL from Secrets Manager in backend.ts.
//
// Ad-hoc invoke payloads (see handler.ts):
//   {}                                  → default 14-day window, writes
//   { days: 30 }                        → custom lookback
//   { start: "YYYY-MM-DD", end: "..." } → explicit window
//   { accountId: "<financeAccountId>" } → limit to one mapped account
//   { dryRun: true }                    → compute + log, no writes
export const simplefinSync = defineFunction({
  name: "simplefinSync",
  entry: "./handler.ts",
  timeoutSeconds: 300,   // several accounts × paginated reads + writes
  memoryMB: 512,
  resourceGroupName: "data",
});
