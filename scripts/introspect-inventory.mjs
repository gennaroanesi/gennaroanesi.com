/**
 * introspect-inventory.mjs
 * Prints the actual AppSync mutation names and input types for inventory models.
 *
 * Usage:
 *   node scripts/introspect-inventory.mjs --user=you@example.com --pass=yourpassword
 */

import { readFileSync } from "fs";
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";

const userArg = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const passArg = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];

if (!userArg || !passArg) {
  console.error("Usage: node scripts/introspect-inventory.mjs --user=you@example.com --pass=yourpassword");
  process.exit(1);
}

const outputs      = JSON.parse(readFileSync("./amplify_outputs.json", "utf8"));
const REGION       = outputs.auth.aws_region;
const CLIENT_ID    = outputs.auth.user_pool_client_id;
const APPSYNC_URL  = outputs.data.url;

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const res = await cognito.send(new InitiateAuthCommand({
  AuthFlow: "USER_PASSWORD_AUTH",
  ClientId: CLIENT_ID,
  AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
}));
const JWT = res.AuthenticationResult.IdToken;
console.log("Authenticated ✓\n");

const r = await fetch(APPSYNC_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": JWT },
  body: JSON.stringify({
    query: `{
      __schema {
        mutationType {
          fields {
            name
            args {
              name
              type { name kind ofType { name } }
            }
          }
        }
      }
    }`
  }),
});

const data = await r.json();
const mutations = data.data.__schema.mutationType.fields
  .filter((f) => f.name.toLowerCase().includes("inventory"))
  .map((f) => ({
    mutation:  f.name,
    inputType: f.args.find((a) => a.name === "input")?.type?.ofType?.name
            ?? f.args.find((a) => a.name === "input")?.type?.name
            ?? "?",
  }));

console.log("Inventory mutations:\n");
for (const m of mutations) {
  console.log(`  ${m.mutation.padEnd(40)} input: ${m.inputType}`);
}
