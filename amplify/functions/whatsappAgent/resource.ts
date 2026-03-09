import { defineFunction } from "@aws-amplify/backend";

// Lambda B — does the actual work: reads history, calls Claude, executes tools,
// replies via Twilio. Invoked async by whatsappAck so Twilio never times out.
export const whatsappAgent = defineFunction({
  name: "whatsappAgent",
  entry: "./handler.ts",
  timeoutSeconds: 120,   // Claude + tool round-trips can take 30-60s
  resourceGroupName: "data",
});
