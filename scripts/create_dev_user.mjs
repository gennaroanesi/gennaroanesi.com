/**
 * create_dev_user.mjs
 *
 * Creates a Cognito user in the sandbox (or prod) user pool with a permanent
 * password and adds them to the `admins` group — so they can log in to the app
 * immediately with full access, no email verification flow.
 *
 * Uses AWS SDK credentials from the standard chain: env vars, ~/.aws/credentials,
 * SSO session, etc. The identity used must have `cognito-idp:AdminCreateUser`,
 * `AdminSetUserPassword`, and `AdminAddUserToGroup` permissions on the target pool.
 *
 * Usage:
 *   node create_dev_user.mjs \
 *     --env=sandbox \
 *     --user=dev@example.com \
 *     --pass='Dev1234!' \
 *     --name='Dev User'
 *
 * Optional flags:
 *   --profile=NAME  AWS profile to use (default: standard chain: env, default profile, SSO)
 *   --no-admin      Skip adding to admins group (default: add)
 *   --force         If user already exists, reset their password instead of erroring
 */

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminGetUserCommand,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { getConfig } from "./aws-config.mjs";

// ── Args ──────────────────────────────────────────────────────────────────────

const userArg    = process.argv.find((a) => a.startsWith("--user="))?.split("=")[1];
const passArg    = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];
const nameArg    = process.argv.find((a) => a.startsWith("--name="))?.split("=")[1];
const profileArg = process.argv.find((a) => a.startsWith("--profile="))?.split("=")[1];
const noAdmin    = process.argv.includes("--no-admin");
const force      = process.argv.includes("--force");

if (!userArg || !passArg || !nameArg) {
  console.error(
    "Usage: node create_dev_user.mjs --env=sandbox|prod --user=you@example.com --pass='yourpassword' --name='Full Name' [--profile=NAME] [--no-admin] [--force]",
  );
  console.error("\nPassword requirements (Cognito default policy):");
  console.error("  - Minimum 8 characters");
  console.error("  - At least one uppercase letter");
  console.error("  - At least one lowercase letter");
  console.error("  - At least one number");
  console.error("  - At least one symbol (e.g. !@#$%^&*)");
  process.exit(1);
}

const cfg = getConfig();
if (!cfg.userPoolId) {
  console.error(`No userPoolId configured for env=${cfg.env}`);
  process.exit(1);
}

if (cfg.env === "prod") {
  console.log("⚠️  You're targeting PROD. Ctrl-C in the next 3 seconds if that's wrong.");
  await new Promise((r) => setTimeout(r, 3000));
}

if (profileArg) {
  console.log(`Using AWS profile: ${profileArg}`);
}

const cognito = new CognitoIdentityProviderClient({
  region: cfg.region,
  // When --profile is given, pin the SDK to that profile via the node provider chain.
  // Without it, the SDK uses the default chain: env vars, shared config, SSO, etc.
  ...(profileArg ? { credentials: fromNodeProviderChain({ profile: profileArg }) } : {}),
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function userExists() {
  try {
    await cognito.send(
      new AdminGetUserCommand({
        UserPoolId: cfg.userPoolId,
        Username: userArg,
      }),
    );
    return true;
  } catch (err) {
    if (err.name === "UserNotFoundException") return false;
    throw err;
  }
}

async function createUser() {
  console.log(`Creating user ${userArg} in ${cfg.userPoolId}…`);
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: cfg.userPoolId,
      Username: userArg,
      UserAttributes: [
        { Name: "email",           Value: userArg },
        { Name: "email_verified",  Value: "true" },
        { Name: "name",            Value: nameArg },
      ],
      // Suppress the "temporary password" email — we're setting a permanent password next
      MessageAction: "SUPPRESS",
    }),
  );
}

async function setPassword() {
  console.log(`Setting permanent password…`);
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: cfg.userPoolId,
      Username: userArg,
      Password: passArg,
      Permanent: true,
    }),
  );
}

async function addToAdminsGroup() {
  console.log(`Adding to admins group…`);
  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: cfg.userPoolId,
      Username: userArg,
      GroupName: "admins",
    }),
  );
}

async function main() {
  const exists = await userExists();

  if (exists && !force) {
    console.error(`❌ User ${userArg} already exists. Use --force to reset password.`);
    process.exit(1);
  }

  if (!exists) {
    try {
      await createUser();
    } catch (err) {
      if (err instanceof UsernameExistsException) {
        console.log("(user exists — proceeding with password reset)");
      } else {
        throw err;
      }
    }
  } else {
    console.log(`User ${userArg} exists; resetting password and re-adding to group.`);
  }

  await setPassword();

  if (!noAdmin) {
    try {
      await addToAdminsGroup();
    } catch (err) {
      // Idempotent: already in group is fine
      if (err.name !== "ResourceNotFoundException") {
        console.log(`(admin group membership: ${err.message ?? err.name})`);
      } else {
        throw err;
      }
    }
  }

  console.log("");
  console.log("✅ Done.");
  console.log("");
  console.log(`   Email:    ${userArg}`);
  console.log(`   Password: ${passArg}`);
  console.log(`   Admin:    ${noAdmin ? "no" : "yes"}`);
  console.log(`   Pool:     ${cfg.userPoolId} (${cfg.env})`);
  if (profileArg) console.log(`   Profile:  ${profileArg}`);
  console.log("");
  console.log("   Log in at http://localhost:3000 (or your sandbox deploy URL).");
}

main().catch((e) => {
  console.error("\n❌ Failed:");
  console.error(e);
  process.exit(1);
});
