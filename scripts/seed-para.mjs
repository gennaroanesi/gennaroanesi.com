/**
 * seed-para.mjs
 *
 * Creates the PARA folder structure in the gennaroanesi.com S3 bucket.
 * Each folder gets a .gitkeep placeholder so Obsidian/Remotely Save sees it.
 *
 * Usage:
 *   node scripts/seed-para.mjs
 *
 * Requires AWS credentials with s3:PutObject on the bucket.
 * Uses the default AWS profile (same one Amplify uses).
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const BUCKET  = "gennaroanesi.com";
const REGION  = "us-east-1"; // update if your bucket is in a different region

const FOLDERS = [
  "PARA/Projects/",
  "PARA/Areas/",
  "PARA/Resources/",
  "PARA/Archives/",
];

// Starter notes — one per section so the vault isn't empty on first open
const STARTER_NOTES = [
  {
    key:     "PARA/Projects/example-project.md",
    content: `# Example Project\n\n**Created:** ${new Date().toISOString().slice(0,10)}  \n**Status:** Active  \n**Goal:** Replace this with a real project\n\n---\n\n## Overview\n\n\n## Next Actions\n\n- [ ] Delete this file and create your first real project\n\n## Notes\n\n`,
  },
  {
    key:     "PARA/Areas/home.md",
    content: `# Home\n\n**Created:** ${new Date().toISOString().slice(0,10)}  \n\n---\n\n## Purpose\n\nOngoing home maintenance and household responsibilities.\n\n## Notes\n\n`,
  },
  {
    key:     "PARA/Resources/para-system.md",
    content: `# PARA System\n\n**Created:** ${new Date().toISOString().slice(0,10)}  \n\n---\n\n## What is PARA?\n\n- **Projects** — outcomes with a deadline\n- **Areas** — ongoing responsibilities with no end date\n- **Resources** — reference material you might use someday\n- **Archives** — completed or inactive items from the above\n\n## Rules\n\n1. Every note belongs in exactly one category\n2. Projects are active until done, then archived\n3. Areas represent roles you maintain over time\n`,
  },
  {
    key:     "PARA/Resources/agent-config.md",
    content: `# Agent Configuration

This file controls how the household agent behaves.
Edit it in Obsidian — changes sync to S3 and take effect on the next agent message.

---

## Auto-Commit Rules

Actions listed here are executed **immediately without asking for confirmation**.
Everything else requires an explicit "yes" reply before the agent acts.

### Tasks
- Create a task with no due date
- Mark a task as done
- Snooze a task

### Notes
- Append content to an existing note
- Create a new note in Resources or Archives

### Queries (always auto, never needs confirmation)
- Check ammo inventory
- Check account balances
- List recent transactions
- List open tasks
- Read a note
- List notes

---

## Require Confirmation

These actions **always** require confirmation regardless of phrasing:

- Any financial transaction (add_transaction)
- Ammo decrement (log_ammo_use)
- Delete a task
- Overwrite an existing note
- Create a task with a due date or assignee
- Notify the other person (notify_person)

---

## People

The agent knows these people by name. Use first names in messages.

- **Gennaro** — primary user
- **Wife** — secondary user (update this with her actual name)

---

## Preferences

- **Language:** English
- **Timezone:** America/Chicago
- **Currency:** USD
- **Date format:** YYYY-MM-DD
- **Confirmation word:** "yes" or "confirm" (case-insensitive)
- **Cancel word:** "no", "cancel", or "nevermind"
`,
  },
];

const client = new S3Client({ region: REGION });

async function put(key, body = "") {
  await client.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        body,
    ContentType: key.endsWith(".md") ? "text/markdown" : "application/octet-stream",
  }));
  console.log(`  ✓  s3://${BUCKET}/${key}`);
}

async function main() {
  console.log(`\nSeeding PARA structure in s3://${BUCKET}/\n`);

  console.log("Creating folder placeholders…");
  for (const folder of FOLDERS) {
    await put(folder + ".gitkeep");
  }

  console.log("\nCreating starter notes…");
  for (const note of STARTER_NOTES) {
    await put(note.key, note.content);
  }

  console.log("\nDone. Open Obsidian, install Remotely Save, point it at:");
  console.log(`  Bucket:  ${BUCKET}`);
  console.log(`  Prefix:  PARA/`);
  console.log(`  Region:  ${REGION}\n`);
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
