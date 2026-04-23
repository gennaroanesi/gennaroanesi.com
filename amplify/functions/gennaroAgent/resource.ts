import { defineFunction } from "@aws-amplify/backend";

// Personal assistant Lambda — tool-calling loop against Claude. Starts with a
// read-only finance surface; additional tool domains (inventory, flight, etc.)
// will layer in over time. Invoked via the invokeGennaroAgent AppSync mutation
// defined in amplify/data/resource.ts.
//
// resourceGroupName: "data" keeps this in the same nested stack as other
// data-adjacent functions, avoiding cross-stack circular deps.
//
// ANTHROPIC_API_KEY is injected from the existing gennaroanesi/transcribe
// Secrets Manager secret via CDK in backend.ts. The handler reads it through
// process.env rather than $amplify/env/* so Amplify's codegen doesn't need to
// know about a var we're feeding in manually via CDK.
export const gennaroAgent = defineFunction({
  name: "gennaroAgent",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  memoryMB: 512,
  resourceGroupName: "data",
});
