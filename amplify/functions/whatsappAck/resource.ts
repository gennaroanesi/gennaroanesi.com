import { defineFunction } from "@aws-amplify/backend";

// Lambda A — receives Twilio webhook, validates signature, ACKs in < 1s,
// then invokes whatsappAgent asynchronously.
export const whatsappAck = defineFunction({
  name: "whatsappAck",
  entry: "./handler.ts",
  timeoutSeconds: 10,
  resourceGroupName: "data",
});
