/**
 * amplify/post_sandbox.ts
 *
 * Runs automatically after every `ampx sandbox` deployment.
 * Creates a persistent test user so you never have to manually set one up.
 *
 * Credentials come from environment variables (see .env.sandbox):
 *   SANDBOX_TEST_EMAIL    e.g. test@example.com
 *   SANDBOX_TEST_PASSWORD e.g. Test1234!
 *   SANDBOX_TEST_NAME     e.g. Test User
 *
 * The user is:
 *   - Created with a permanent password (no force-change step)
 *   - Email marked as verified (no confirmation email needed)
 *   - Added to the "admins" group so they can reach protected pages
 *
 * If the user already exists (re-running sandbox) the script is a no-op.
 */

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";

// Amplify injects the deployed backend outputs as env vars after deploy.
// The user pool ID is available as AMPLIFY_AUTH_USERPOOL_ID in the sandbox env.
const USER_POOL_ID = process.env.AMPLIFY_AUTH_USERPOOL_ID;

const EMAIL    = process.env.SANDBOX_TEST_EMAIL    ?? "test@sandbox.local";
const PASSWORD = process.env.SANDBOX_TEST_PASSWORD ?? "SandboxTest1!";
const NAME     = process.env.SANDBOX_TEST_NAME     ?? "Sandbox Tester";

if (!USER_POOL_ID) {
  console.warn("[post_sandbox] AMPLIFY_AUTH_USERPOOL_ID not set — skipping test user creation.");
  process.exit(0);
}

const cognito = new CognitoIdentityProviderClient({ region: "us-east-1" });

async function run() {
  console.log(`[post_sandbox] Creating test user: ${EMAIL}`);

  // 1. Create the user (suppress welcome email, mark email verified)
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId:        USER_POOL_ID,
      Username:          EMAIL,
      MessageAction:     "SUPPRESS",   // don't send invitation email
      UserAttributes: [
        { Name: "email",          Value: EMAIL },
        { Name: "email_verified", Value: "true" },
        { Name: "name",           Value: NAME },
      ],
      TemporaryPassword: PASSWORD,     // will be overwritten to permanent below
    }));
    console.log("[post_sandbox] User created.");
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      console.log("[post_sandbox] User already exists — skipping create.");
    } else {
      throw err;
    }
  }

  // 2. Set a permanent password so the user doesn't hit FORCE_CHANGE_PASSWORD
  await cognito.send(new AdminSetUserPasswordCommand({
    UserPoolId: USER_POOL_ID,
    Username:   EMAIL,
    Password:   PASSWORD,
    Permanent:  true,
  }));
  console.log("[post_sandbox] Permanent password set.");

  // 3. Add to admins group
  await cognito.send(new AdminAddUserToGroupCommand({
    UserPoolId: USER_POOL_ID,
    Username:   EMAIL,
    GroupName:  "admins",
  }));
  console.log("[post_sandbox] Added to admins group.");

  console.log(`[post_sandbox] ✓ Test user ready — ${EMAIL} / ${PASSWORD}`);
}

run().catch((err) => {
  console.error("[post_sandbox] Error:", err);
  process.exit(1);
});
