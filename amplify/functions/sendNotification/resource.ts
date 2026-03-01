import { defineFunction } from "@aws-amplify/backend";

export const sendNotification = defineFunction({
  name: "sendNotification",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  environment: {
    // Twilio credentials injected at deploy time from Secrets Manager
    // via backend.ts — do NOT hardcode here
  },
});
