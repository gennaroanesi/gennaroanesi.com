import { defineBackend } from "@aws-amplify/backend";
// import { Policy, PolicyStatement, Effect } from "aws-cdk-lib/aws-iam";
// import { Stack } from "aws-cdk-lib";
// import { StartingPosition, EventSourceMapping } from "aws-cdk-lib/aws-lambda";
import { auth } from "./auth/resource";
// import { data } from "./data/resource";
import { storage } from "./storage/resource";
// import * as sns from "aws-cdk-lib/aws-sns";

const backend = defineBackend({
  auth,
  //  data,
  storage,
});
