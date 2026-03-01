import { defineBackend } from "@aws-amplify/backend";
import { Effect, Policy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { CfnUserPool } from "aws-cdk-lib/aws-cognito";
import { Bucket } from "aws-cdk-lib/aws-s3";

import { auth } from "./auth/resource";
import { data } from "./data/resource";

const backend = defineBackend({
  auth,
  data,
  //storage,
});

// Disable self-registration — only admin-created users can sign in
const { cfnUserPool } = backend.auth.resources.cfnResources;
(cfnUserPool as CfnUserPool).adminCreateUserConfig = {
  allowAdminCreateUserOnly: true,
};

// Use existing gennaroanesi.com bucket

const customBucketStack = backend.createStack("gennaroanesi-bucket-stack");

const customBucket = Bucket.fromBucketAttributes(
  customBucketStack,
  "gennaroAnesiBucket",
  {
    bucketArn: "arn:aws:s3:::gennaroanesi.com",
    region: "us-east-1",
  },
);

backend.addOutput({
  storage: {
    // optional: `buckets` can be used when setting up more than one existing bucket
    buckets: [
      {
        aws_region: customBucket.env.region,
        bucket_name: customBucket.bucketName,
        name: customBucket.bucketName,
        /*
          optional: `paths` can be used to set up access to specific
          bucket prefixes and configure user access types to them
        */
        paths: {
          "public/*": {
            // "write" and "delete" can also be added depending on your use case
            guest: ["get", "list"],
          },
          "*": {
            authenticated: ["read", "write"],
          },
        },
      },
    ],
  },
});

/*
  Define an inline policy to attach to Amplify's unauth role
  This policy defines how unauthenticated/guest users can access your existing bucket
*/
const unauthPolicy = new Policy(backend.stack, "customBucketUnauthPolicy", {
  statements: [
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:GetObject"],
      resources: [`${customBucket.bucketArn}/public/*`],
    }),
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:ListBucket"],
      resources: [`${customBucket.bucketArn}`, `${customBucket.bucketArn}/*`],
      conditions: {
        StringLike: {
          "s3:prefix": ["public/", "public/*"],
        },
      },
    }),
  ],
});

// Add the policies to the unauthenticated user role
backend.auth.resources.unauthenticatedUserIamRole.attachInlinePolicy(
  unauthPolicy,
);

/*
  Define an inline policy for authenticated users so they can
  read, write and delete objects anywhere in the bucket (inventory uploads, etc.)
*/
const authPolicy = new Policy(backend.stack, "customBucketAuthPolicy", {
  statements: [
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      resources: [`${customBucket.bucketArn}/*`],
    }),
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:ListBucket"],
      resources: [`${customBucket.bucketArn}`],
    }),
  ],
});

backend.auth.resources.authenticatedUserIamRole.attachInlinePolicy(authPolicy);

// Admins group gets its own IAM role — attach the same S3 policy to it
backend.auth.resources.groups["admins"].role.attachInlinePolicy(
  new Policy(backend.stack, "customBucketAdminsGroupPolicy", {
    statements: [
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [`${customBucket.bucketArn}/*`],
      }),
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [`${customBucket.bucketArn}`],
      }),
    ],
  }),
);
