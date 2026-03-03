/**
 * aws-config.mjs
 * Shared environment config for all scripts.
 *
 * Usage: import { getConfig } from "./aws-config.mjs";
 *        const cfg = getConfig(); // reads --env=sandbox|prod from process.argv, defaults to "prod"
 */

const ENVIRONMENTS = {
  sandbox: {
    region:     "us-east-1",
    clientId:   "1gqivvp8d9uh2vqnv6v0ehuoj4",
    appsyncUrl: "https://xaictck6irbbzfa6n5lsayukwq.appsync-api.us-east-1.amazonaws.com/graphql",
    apiKey:     "da2-c2f4tfsjjrcvxa6h2m2sroluqu",
  },
  prod: {
    region:     "us-east-1",
    clientId:   "1gqivvp8d9uh2vqnv6v0ehuoj4",
    appsyncUrl: "https://cdglsrrdm5fhrnu6wge6533jyy.appsync-api.us-east-1.amazonaws.com/graphql",
    apiKey:     null, // TODO: paste prod API key here (from prod amplify_outputs.json data.api_key)
  },
};

export function getConfig() {
  const envArg = process.argv.find((a) => a.startsWith("--env="))?.split("=")[1] ?? "prod";
  if (!ENVIRONMENTS[envArg]) {
    console.error(`Unknown --env="${envArg}". Valid options: sandbox, prod`);
    process.exit(1);
  }
  console.log(`Environment: ${envArg}\n`);
  return { env: envArg, ...ENVIRONMENTS[envArg] };
}
