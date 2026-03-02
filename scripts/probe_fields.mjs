import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";

const userArg = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const passArg = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];

if (!userArg || !passArg) {
  console.error("Usage: node probe_fields.mjs --env=sandbox|prod --user=you@example.com --pass=yourpassword");
  process.exit(1);
}

const { region: REGION, clientId: CLIENT_ID, appsyncUrl: APPSYNC_URL } = getConfig();

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const res = await cognito.send(new InitiateAuthCommand({
  AuthFlow: "USER_PASSWORD_AUTH", ClientId: CLIENT_ID,
  AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
}));
const jwt = res.AuthenticationResult.IdToken;

const result = await fetch(APPSYNC_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: jwt },
  body: JSON.stringify({ query: `{
    __type(name: "CreateFlightInput") {
      inputFields {
        name
        type { name kind ofType { name } }
      }
    }
  }` }),
});
const data = await result.json();
const fields = data.data?.__type?.inputFields ?? [];
console.log(fields.map(f => `${f.name}: ${f.type.name ?? f.type.ofType?.name ?? f.type.kind}`).join("\n"));
