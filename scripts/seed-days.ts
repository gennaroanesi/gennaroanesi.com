/**
 * seed-days.ts
 * Pre-creates every day from 2026 to 2035 in the DynamoDB day table
 * via the Amplify Gen 2 data client.
 *
 * Run with:
 *   npx tsx scripts/seed-days.ts
 *
 * Requires you to be logged in as an admin user. Set these env vars:
 *   AMPLIFY_USERNAME=your@email.com
 *   AMPLIFY_PASSWORD=yourpassword
 */

import { Amplify } from "aws-amplify";
import { signIn } from "aws-amplify/auth";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../amplify/data/resource";
import outputs from "../amplify_outputs.json";

Amplify.configure(outputs);

const client = generateClient<Schema>();

const START_YEAR = 2026;
const END_YEAR = 2035;
const BATCH_SIZE = 25; // stay well under AppSync limits

function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6; // 0 = Sunday, 6 = Saturday
}

function formatDate(date: Date): string {
  // YYYY-MM-DD in local time
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function generateDays(): { date: string; status: string; isWeekend: boolean; timezone: string }[] {
  const days: { date: string; status: string; isWeekend: boolean; timezone: string }[] = [];
  const start = new Date(START_YEAR, 0, 1);
  const end = new Date(END_YEAR, 11, 31);

  const cursor = new Date(start);
  while (cursor <= end) {
    const weekend = isWeekend(cursor);
    days.push({
      date: formatDate(cursor),
      status: weekend ? "WEEKEND_HOLIDAY" : "WORKING_HOME",
      isWeekend: weekend,
      timezone: "America/Chicago",  // Austin default; update when traveling
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const username = process.env.AMPLIFY_USERNAME;
  const password = process.env.AMPLIFY_PASSWORD;

  if (!username || !password) {
    console.error(
      "❌  Set AMPLIFY_USERNAME and AMPLIFY_PASSWORD env vars before running."
    );
    process.exit(1);
  }

  console.log("🔐  Signing in...");
  await signIn({ username, password });
  console.log("✅  Signed in.\n");

  const days = generateDays();
  console.log(
    `📅  Seeding ${days.length} days (${START_YEAR}–${END_YEAR})...\n`
  );

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < days.length; i += BATCH_SIZE) {
    const batch = days.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (day) => {
        try {
          const { errors } = await client.models.day.create(day);
          if (errors && errors.length > 0) {
            // Likely a conflict — day already exists
            skipped++;
          } else {
            created++;
          }
        } catch (e) {
          console.error(`  ❌  Failed for ${day.date}:`, e);
          failed++;
        }
      })
    );

    const progress = Math.min(i + BATCH_SIZE, days.length);
    process.stdout.write(
      `  ${progress}/${days.length} (${Math.round((progress / days.length) * 100)}%)\r`
    );

    // Small pause between batches to avoid throttling
    if (i + BATCH_SIZE < days.length) {
      await sleep(200);
    }
  }

  console.log(`\n\n✅  Done!`);
  console.log(`   Created : ${created}`);
  console.log(`   Skipped : ${skipped} (already existed)`);
  console.log(`   Failed  : ${failed}`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
