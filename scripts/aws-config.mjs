/**
 * aws-config.mjs
 * Shared environment config for all scripts.
 * Usage: import { getConfig } from "./aws-config.mjs";
 *        const cfg = getConfig(); // reads --env=sandbox|prod from process.argv
 */

const ENVIRONMENTS = {
  sandbox: {
    region:      "us-east-1",
    clientId:    "2cra2mdgp22rh7813g3aq26k20",
    appsyncUrl:  "https://cdglsrrdm5fhrnu6wge6533jyy.appsync-api.us-east-1.amazonaws.com/graphql",
  },
  prod: {
    region:      "us-east-1",
    clientId:    "1gqivvp8d9uh2vqnv6v0ehuoj4",
    appsyncUrl:  "https://xaictck6irbbzfa6n5lsayukwq.appsync-api.us-east-1.amazonaws.com/graphql",
  },
};

export function getConfig() {
  const envArg = process.argv.find((a) => a.startsWith("--env="))?.split("=")[1] ?? "sandbox";
  if (!ENVIRONMENTS[envArg]) {
    console.error(`Unknown --env="${envArg}". Valid options: sandbox, prod`);
    process.exit(1);
  }
  console.log(`Environment: ${envArg}\n`);
  return { env: envArg, ...ENVIRONMENTS[envArg] };
}
