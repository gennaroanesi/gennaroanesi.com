/**
 * aws-config.mjs
 * Shared environment config for all scripts.
 *
 * Usage: import { getConfig } from "./aws-config.mjs";
 *        const cfg = getConfig(); // reads --env=sandbox|prod from process.argv, defaults to "prod"
 *
 * API keys are NOT committed here. They come from (in order):
 *   1. process.env.APPSYNC_API_KEY_SANDBOX / APPSYNC_API_KEY_PROD
 *      (set automatically when running with `node --env-file=.env.local`)
 *   2. .env.local at the repo root, parsed directly — so scripts invoked as
 *      plain `node scripts/foo.mjs` still resolve keys without --env-file.
 * Keys are only required by scripts that actually read cfg.apiKey; scripts
 * that authenticate purely via Cognito JWT work without them.
 *
 * To (re)fetch a key:
 *   aws appsync list-api-keys --api-id <id> --region us-east-1
 * Sandbox api-id: vaqkgteemrdfroauddnr2mp4dm — Prod api-id: cdglsrrdm5fhrnu6wge6533jyy
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Pool/client IDs and URLs are public identifiers (they ship in every client
// bundle) — safe to keep inline. Only the API keys are credentials.
const ENVIRONMENTS = {
  sandbox: {
    region:     "us-east-1",
    userPoolId: "us-east-1_aOPRNH5x3",
    clientId:   "14jdsru65a6be94lj26r2mm259",
    appsyncUrl: "https://vaqkgteemrdfroauddnr2mp4dm.appsync-api.us-east-1.amazonaws.com/graphql",
    apiKeyEnv:  "APPSYNC_API_KEY_SANDBOX",
  },
  prod: {
    region:     "us-east-1",
    userPoolId: "us-east-1_ifc6gPJmc",
    clientId:   "2cra2mdgp22rh7813g3aq26k20",
    appsyncUrl: "https://cdglsrrdm5fhrnu6wge6533jyy.appsync-api.us-east-1.amazonaws.com/graphql",
    apiKeyEnv:  "APPSYNC_API_KEY_PROD",
  },
};

/** Parse KEY=value lines from .env.local (repo root). Quotes stripped. */
function readEnvLocal() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const out = {};
    for (const line of readFileSync(join(root, ".env.local"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

function resolveApiKey(envVar) {
  if (process.env[envVar]) return process.env[envVar];
  const local = readEnvLocal();
  if (local[envVar]) return local[envVar];
  return null; // fine for JWT-only scripts; key-reading scripts fail with context below
}

export function getConfig() {
  const envArg = process.argv.find((a) => a.startsWith("--env="))?.split("=")[1] ?? "prod";
  if (!ENVIRONMENTS[envArg]) {
    console.error(`Unknown --env="${envArg}". Valid options: sandbox, prod`);
    process.exit(1);
  }
  console.log(`Environment: ${envArg}\n`);
  const { apiKeyEnv, ...cfg } = ENVIRONMENTS[envArg];
  const apiKey = resolveApiKey(apiKeyEnv);
  return {
    env: envArg,
    ...cfg,
    get apiKey() {
      if (!apiKey) {
        console.error(
          `Missing AppSync API key for "${envArg}". Set ${apiKeyEnv} in .env.local ` +
          `(fetch it with: aws appsync list-api-keys --api-id <id> --region us-east-1).`,
        );
        process.exit(1);
      }
      return apiKey;
    },
  };
}
