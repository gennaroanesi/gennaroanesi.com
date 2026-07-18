/**
 * simplefin_probe.mjs
 *
 * Test-only script for the SimpleFIN Bridge integration. Does NOT write
 * anything to the database — just verifies credentials and prints what
 * the bridge is exposing so you can build up the account-id mapping.
 *
 * Two modes:
 *
 *   1. Claim a setup token (one-time):
 *        node scripts/simplefin_probe.mjs --setup-token=<b64>
 *      Exchanges the token for a persistent access URL. Copy the printed
 *      URL into .env.local as SIMPLEFIN_ACCESS_URL. Never commit it.
 *
 *   2. Fetch accounts + recent transactions (any time after):
 *        npm run sf:probe
 *        npm run sf:probe -- --days=90
 *        npm run sf:probe -- --start=2026-06-01 --end=2026-07-01
 *        npm run sf:probe -- --sample=8
 *        npm run sf:probe -- --account=ACC-abc123
 *
 *      Requires SIMPLEFIN_ACCESS_URL in .env.local. Prints:
 *        - Each SimpleFIN account: id, name, bank/org, currency, balance
 *        - Transaction count in the window
 *        - Latest N transactions per account (default 5)
 *
 * Nothing here touches AWS. Safe to run repeatedly.
 */

import { claimAccessUrl, fetchAccounts, maskAccessUrl } from "./_simplefin.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  })
);

async function main() {
  // ── Mode 1: setup-token exchange ──────────────────────────────────────
  if (args["setup-token"]) {
    console.log("Exchanging setup token for access URL…");
    const accessUrl = await claimAccessUrl(args["setup-token"]);
    console.log("\nSUCCESS. Access URL:\n\n  " + accessUrl + "\n");
    console.log("Save this in .env.local:\n");
    console.log("  SIMPLEFIN_ACCESS_URL=" + accessUrl + "\n");
    console.log("The setup token is now consumed and cannot be exchanged again.");
    return;
  }

  // ── Mode 2: probe accounts ────────────────────────────────────────────
  const accessUrl = process.env.SIMPLEFIN_ACCESS_URL;
  if (!accessUrl) {
    console.error(
      "Missing SIMPLEFIN_ACCESS_URL. Either:\n" +
      "  - Add it to .env.local, or\n" +
      "  - Claim it first:  node scripts/simplefin_probe.mjs --setup-token=<token>"
    );
    process.exit(1);
  }

  const days = args.days ? parseInt(args.days, 10) : 30;
  const startArg = args.start ?? isoDaysAgo(days);
  const endArg = args.end ?? isoToday();
  const sampleN = args.sample ? parseInt(args.sample, 10) : 5;
  const accountFilter = args.account ? [args.account] : undefined;

  console.log(`Access URL:  ${maskAccessUrl(accessUrl)}`);
  console.log(`Window:      ${startArg} → ${endArg}${accountFilter ? `  (account=${accountFilter[0]})` : ""}`);
  console.log();

  const { errors, accounts } = await fetchAccounts(accessUrl, {
    start:      startArg,
    end:        endArg,
    pending:    true,
    accountIds: accountFilter,
  });

  if (errors.length) {
    console.log("Bridge-level errors:");
    for (const e of errors) console.log("  · " + e);
    console.log();
  }

  if (accounts.length === 0) {
    console.log("No accounts returned. If you're mid-connection, wait for the bank to finish syncing and re-run.");
    return;
  }

  for (const a of accounts) {
    const bal = a.currency === "USD"
      ? `$${a.balance.toFixed(2)}`
      : `${a.balance.toFixed(2)} ${a.currency}`;
    console.log(`─── ${a.name}${a.orgName ? "  ·  " + a.orgName : ""}`);
    console.log(`    id:          ${a.id}`);
    console.log(`    balance:     ${bal}${a.availableBalance != null ? `  (available: ${a.availableBalance.toFixed(2)})` : ""}  as of ${a.balanceDate}`);
    console.log(`    txs in window: ${a.transactions.length}`);
    if (a.transactions.length > 0) {
      console.log(`    latest ${Math.min(sampleN, a.transactions.length)}:`);
      for (const t of a.transactions.slice(0, sampleN)) {
        const sign = t.amount >= 0 ? "+" : "";
        const memo = t.memo ? `   [memo: ${t.memo.slice(0, 60)}]` : "";
        const pend = t.pending ? "  (pending)" : "";
        console.log(`      ${t.posted}  ${sign}${t.amount.toFixed(2).padStart(9)}  ${(t.payee || t.description).slice(0, 50).padEnd(50)}${pend}${memo}`);
      }
    }
    if (a.holdings.length > 0) {
      const total = a.holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0);
      console.log(`    holdings: ${a.holdings.length} position(s), total market value ${total.toFixed(2)} ${a.currency}`);
      for (const h of a.holdings.slice(0, sampleN)) {
        const label = h.symbol || h.description.slice(0, 20);
        const sh = h.shares != null ? `${h.shares.toString().padStart(10)} sh` : " ".repeat(13);
        const mv = h.marketValue != null ? h.marketValue.toFixed(2).padStart(12) : " ".repeat(12);
        const cb = h.costBasis != null ? `  cost ${h.costBasis.toFixed(2)}` : "";
        console.log(`      ${label.padEnd(18)}  ${sh}  ${mv}${cb}`);
      }
      if (a.holdings.length > sampleN) console.log(`      … and ${a.holdings.length - sampleN} more`);
    }
    console.log();
  }

  console.log(`Summary: ${accounts.length} account(s), ${accounts.reduce((s, a) => s + a.transactions.length, 0)} tx(s) in window.`);
  console.log("\nCopy the id from each account you want to sync into scripts/data/simplefin_mapping.json.");
  console.log("Template: cp scripts/data/simplefin_mapping.example.json scripts/data/simplefin_mapping.json");
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}
function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
