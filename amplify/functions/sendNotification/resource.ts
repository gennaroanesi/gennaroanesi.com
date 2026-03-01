import { defineFunction } from "@aws-amplify/backend";

export const sendNotification = defineFunction({
  name: "sendNotification",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  resourceGroupName: "data", // co-locate with data stack to avoid circular dependency
});
