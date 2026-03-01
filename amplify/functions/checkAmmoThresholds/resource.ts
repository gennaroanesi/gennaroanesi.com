import { defineFunction } from "@aws-amplify/backend";

export const checkAmmoThresholds = defineFunction({
  name: "checkAmmoThresholds",
  entry: "./handler.ts",
  timeoutSeconds: 60,
});
