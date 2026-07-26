import { defineFunction } from "@aws-amplify/backend";

// Daily balance-drift detector. Triggered by an EventBridge cron (see
// backend.ts) at 11:30 UTC, after the 11:00 financeSnapshots capture. For
// each active account it recomputes the ledger sum (Σ POSTED impact) and
// compares currentBalance − ledgerSum against the account's stored
// reconcileOffset. A changed offset means some write path desynced the
// cached balance from the ledger — logged to financeReconcileLog; the cron
// never mutates currentBalance itself. Ad-hoc: invoke with {} any time.
export const financeReconcile = defineFunction({
  name: "financeReconcile",
  entry: "./handler.ts",
  timeoutSeconds: 120,
  memoryMB: 512,
  resourceGroupName: "data",
});
