/**
 * query_calendar_days.mjs
 * Fetches day records from the database for a given date range.
 *
 * Usage:
 *   node query_calendar_days.mjs --user=you@example.com --pass=yourpassword
 *   node query_calendar_days.mjs --user=you@example.com --pass=yourpassword --start=2026-03-01 --end=2026-03-08
 */

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const userArg = process.argv
  .find((a) => a.startsWith("--user="))
  ?.split("=")[1];
const passArg = process.argv
  .find((a) => a.startsWith("--pass="))
  ?.split("=")[1];
const startArg =
  process.argv.find((a) => a.startsWith("--start="))?.split("=")[1] ??
  "2026-03-01";
const endArg =
  process.argv.find((a) => a.startsWith("--end="))?.split("=")[1] ??
  "2026-04-07";

if (!userArg || !passArg) {
  console.error(
    "Usage: node query_calendar_days.mjs --user=you@example.com --pass=yourpassword [--start=YYYY-MM-DD] [--end=YYYY-MM-DD]",
  );
  process.exit(1);
}

const REGION = "us-east-1";
const CLIENT_ID = "2cra2mdgp22rh7813g3aq26k20";
const APPSYNC_URL =
  "https://cdglsrrdm5fhrnu6wge6533jyy.appsync-api.us-east-1.amazonaws.com/graphql";

async function getJwt() {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const res = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
    }),
  );
  if (!res.AuthenticationResult?.IdToken)
    throw new Error("Auth failed. Challenge: " + res.ChallengeName);
  return res.AuthenticationResult.IdToken;
}

async function gql(jwt, query, variables = {}) {
  const res = await fetch(APPSYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: jwt },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

const jwt = await getJwt();
console.log("✓ Authenticated\n");

const result = await gql(
  jwt,
  `
  query ListDays($filter: ModelDayFilterInput) {
    listDays(filter: $filter, limit: 200) {
      items {
        date
        status
        timezone
        notes
        isWeekend
        ptoFraction
        tripId
        tripName
        location {
          city
          country
          timezone
        }
      }
    }
  }
`,
  {
    filter: {
      and: [{ date: { ge: startArg } }, { date: { le: endArg } }],
    },
  },
);

if (result.errors) {
  console.error("GraphQL errors:", JSON.stringify(result.errors, null, 2));
  process.exit(1);
}

const items = result.data?.listDays?.items ?? [];

if (items.length === 0) {
  console.log(`No day records found between ${startArg} and ${endArg}.`);
} else {
  console.log(
    `Found ${items.length} day records between ${startArg} and ${endArg}:\n`,
  );
  // Sort by date
  items.sort((a, b) => a.date.localeCompare(b.date));
  for (const d of items) {
    const parts = [d.date, d.status ?? "(no status)"];
    if (d.location?.city) parts.push(d.location.city);
    if (d.location?.country) parts.push(d.location.country);
    if (d.timezone) parts.push(d.timezone);
    if (d.isWeekend != null) parts.push(`weekend=${d.isWeekend}`);
    if (d.ptoFraction) parts.push(`pto=${d.ptoFraction}`);
    if (d.tripName) parts.push(`trip=${d.tripName}`);
    if (d.notes) parts.push(`"${d.notes}"`);
    console.log(" ", parts.join("  |  "));
  }
}
