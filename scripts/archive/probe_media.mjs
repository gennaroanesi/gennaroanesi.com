import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";

const userArg = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const passArg = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];

if (!userArg || !passArg) {
  console.error("Usage: node probe_media.mjs --env=sandbox|prod --user=you@example.com --pass=yourpassword");
  process.exit(1);
}

const { region: REGION, clientId: CLIENT_ID, appsyncUrl: APPSYNC_URL } = getConfig();

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const res = await cognito.send(new InitiateAuthCommand({
  AuthFlow: "USER_PASSWORD_AUTH", ClientId: CLIENT_ID,
  AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
}));
const jwt = res.AuthenticationResult.IdToken;

const gql = async (query) => {
  const r = await fetch(APPSYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: jwt },
    body: JSON.stringify({ query }),
  });
  return r.json();
};

// Check flight count
const flights = await gql(`{ listFlights(limit: 5) { items { id date from to flightType } nextToken } }`);
console.log("── Flights ──");
console.log(`  items: ${flights.data?.listFlights?.items?.length}`);
console.log(`  hasMore: ${!!flights.data?.listFlights?.nextToken}`);
flights.data?.listFlights?.items?.forEach(f => console.log(`  ${f.date}  ${f.from}→${f.to}  [${f.flightType}]  ${f.id}`));

// Check flightMedia model exists
const mediaFields = await gql(`{ __type(name: "CreateFlightMediaInput") { inputFields { name } } }`);
console.log("\n── FlightMedia fields ──");
console.log(mediaFields.data?.__type?.inputFields?.map(f => f.name).join(", "));
