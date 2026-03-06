import { defineFunction } from "@aws-amplify/backend";

export const importLogbook = defineFunction({
  name: "importLogbook",
  entry: "./handler.ts",
  timeoutSeconds: 300,
  memoryMB: 512,
  environment: {
    // Injected in backend.ts after tables are available
  },
});
