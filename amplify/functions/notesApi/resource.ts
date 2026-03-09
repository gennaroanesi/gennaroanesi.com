import { defineFunction } from "@aws-amplify/backend";

// Notes CRUD API — HTTP API Gateway → this Lambda → S3 PARA/
// Auth: Bearer token checked against NOTES_API_TOKEN env var (stored in Secrets Manager)
// resourceGroupName: "data" places this Lambda in the same nested stack as the other
// data-adjacent functions, avoiding the circular dependency Amplify throws when a new
// custom stack references both the function stack and the data stack.
export const notesApi = defineFunction({
  name: "notesApi",
  entry: "./handler.ts",
  timeoutSeconds: 30,
  resourceGroupName: "data",
});
