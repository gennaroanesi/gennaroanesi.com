import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";

const userArg = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const passArg = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];

const REGION      = "us-east-1";
const CLIENT_ID   = "2cra2mdgp22rh7813g3aq26k20";
const APPSYNC_URL = "https://cdglsrrdm5fhrnu6wge6533jyy.appsync-api.us-east-1.amazonaws.com/graphql";

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const res = await cognito.send(new InitiateAuthCommand({
  AuthFlow: "USER_PASSWORD_AUTH", ClientId: CLIENT_ID,
  AuthParameters: { USERNAME: userArg, PASSWORD: passArg },
}));
const jwt = res.AuthenticationResult.IdToken;

// Introspect the schema to find the exact mutation and input type names
const result = await fetch(APPSYNC_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: jwt },
  body: JSON.stringify({ query: `{
    __schema {
      mutationType {
        fields {
          name
          args { name type { name kind ofType { name } } }
        }
      }
    }
  }` }),
});
const data = await result.json();
const mutations = data.data?.__schema?.mutationType?.fields ?? [];
const flightMutations = mutations.filter(m => m.name.toLowerCase().includes("flight"));
console.log(JSON.stringify(flightMutations, null, 2));
