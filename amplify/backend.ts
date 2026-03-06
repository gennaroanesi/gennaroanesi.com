import { defineBackend } from "@aws-amplify/backend";
import { Effect, Policy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { CfnUserPool } from "aws-cdk-lib/aws-cognito";
import { Bucket } from "aws-cdk-lib/aws-s3";
import {
  StartingPosition,
  Function as LambdaFunction,
  DockerImageFunction,
  DockerImageCode,
} from "aws-cdk-lib/aws-lambda";
import { Repository } from "aws-cdk-lib/aws-ecr";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Duration, Size } from "aws-cdk-lib";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";

import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { sendNotification } from "./functions/sendNotification/resource";
import { checkAmmoThresholds } from "./functions/checkAmmoThresholds/resource";

const backend = defineBackend({
  auth,
  data,
  sendNotification,
  checkAmmoThresholds,
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

// ── Notification infrastructure ──────────────────────────────────────────────

const sendFn = backend.sendNotification.resources.lambda as LambdaFunction;

// 1. Twilio secret — WhatsApp only (SMS + Email now use AWS-native services)
//    Secret shape: { accountSid, authToken, fromWhatsapp }
//    Create once:
//      aws secretsmanager create-secret --name gennaroanesi/twilio \
//        --secret-string '{"accountSid":"ACxxx","authToken":"xxx","fromWhatsapp":"+14155238886"}'
const twilioSecret = Secret.fromSecretNameV2(
  backend.stack,
  "TwilioSecret",
  "gennaroanesi/twilio",
);
twilioSecret.grantRead(sendFn);

// Inject all sendNotification env vars in one block via CfnFunction.
// PERSON_TABLE_NAME must also go here (not via addEnvironment) because
// sendFn lives in the data stack — addEnvironment across stacks doesn't apply.
const cfnSendFn = sendFn.node.defaultChild as any;
const personTable = backend.data.resources.tables["notificationPerson"];
personTable.grantReadData(sendFn);
Object.assign(cfnSendFn, {
  environment: {
    variables: {
      TWILIO_ACCOUNT_SID:   twilioSecret.secretValueFromJson("accountSid").unsafeUnwrap(),
      TWILIO_AUTH_TOKEN:    twilioSecret.secretValueFromJson("authToken").unsafeUnwrap(),
      TWILIO_FROM_WHATSAPP: twilioSecret.secretValueFromJson("fromWhatsapp").unsafeUnwrap(),
      SES_FROM_EMAIL:       "noreply@gennaroanesi.com",
      PERSON_TABLE_NAME:    personTable.tableName,
    },
  },
});

// 2. SNS — direct-to-phone SMS (no topic; just Publish to a phone number)
sendFn.addToRolePolicy(
  new PolicyStatement({
    effect:    Effect.ALLOW,
    actions:   ["sns:Publish"],
    resources: ["*"], // SNS direct-to-phone requires * resource
  }),
);

// 3. SES — outbound email
//    Verify your sender address once:
//      aws ses verify-email-identity --email-address noreply@gennaroanesi.com
sendFn.addToRolePolicy(
  new PolicyStatement({
    effect:    Effect.ALLOW,
    actions:   ["ses:SendEmail", "ses:SendRawEmail"],
    resources: ["*"],
  }),
);

// 3. Wire checkAmmoThresholds Lambda
const checkFn = backend.checkAmmoThresholds.resources.lambda as LambdaFunction;
const tables = backend.data.resources.tables;
const ammoTable = tables["inventoryAmmo"];
const thresholdTable = tables["ammoThreshold"];

// Give it read access to the three tables it needs
[ammoTable, thresholdTable, personTable].forEach((t) =>
  t.grantReadData(checkFn),
);

// Inject table names + sendNotification ARN
checkFn.addEnvironment("AMMO_TABLE_NAME", ammoTable.tableName);
checkFn.addEnvironment("THRESHOLD_TABLE_NAME", thresholdTable.tableName);
checkFn.addEnvironment("PERSON_TABLE_NAME", personTable.tableName);
checkFn.addEnvironment("SEND_NOTIFICATION_ARN", sendFn.functionArn);

// Allow checkAmmoThresholds to invoke sendNotification
sendFn.grantInvoke(checkFn);

// 4. Trigger checkAmmoThresholds from inventoryAmmo DynamoDB stream
ammoTable.grantStreamRead(checkFn);
checkFn.addEventSource(
  new DynamoEventSource(ammoTable, {
    startingPosition: StartingPosition.LATEST,
    batchSize: 10,
    retryAttempts: 2,
    filters: [
      // Only fire on item modifications (not inserts/deletes)
      { pattern: JSON.stringify({ eventName: ["MODIFY"] }) },
    ],
  }),
);

// ── transcribeAudio infrastructure ──────────────────────────────────────────
// Python container Lambda — cannot use defineFunction (Node.js only).
// Built from the Dockerfile in amplify/functions/transcribeAudio/.

const transcribeStack = backend.createStack("transcribe-audio-stack");

const audioTable       = tables["flightAudio"];
const flightTable      = tables["flight"];
const airportTable     = tables["airport"];
const instrApprTable   = tables["instrumentApproach"];
const apprProcTable    = tables["approachProcedure"];

// Secrets: HuggingFace token + Anthropic API key
// Create once:
//   aws secretsmanager create-secret --name gennaroanesi/transcribe \
//     --secret-string '{"hfToken":"hf_xxx","anthropicApiKey":"sk-ant-xxx"}'
const transcribeSecret = Secret.fromSecretNameV2(
  transcribeStack,
  "TranscribeSecret",
  "gennaroanesi/transcribe",
);

// Image is built and pushed manually via:
//   ./amplify/functions/transcribeAudio/scripts/docker-push.sh
// Using a fixed stable tag avoids CDK hash recomputation on every sandbox run.
const ECR_REPO_URI = "802060244747.dkr.ecr.us-east-1.amazonaws.com/transcribe-audio";
const ECR_TAG      = "latest";

const transcribeRepo = Repository.fromRepositoryName(
  transcribeStack,
  "TranscribeAudioRepo",
  "transcribe-audio",
);

const transcribeFn = new DockerImageFunction(transcribeStack, "TranscribeAudioFn", {
  code: DockerImageCode.fromEcr(transcribeRepo, { tagOrDigest: ECR_TAG }),
  timeout:          Duration.seconds(900),   // 15 min max
  memorySize:       10240,                   // 10 GB — Whisper large-v3 int8 needs ~8-9 GB peak
  ephemeralStorageSize: Size.gibibytes(10),  // 10 GB /tmp — model weights are ~2 GB
  environment: {
    AUDIO_TABLE_NAME:     audioTable.tableName,
    FLIGHT_TABLE_NAME:    flightTable.tableName,
    AIRPORT_TABLE_NAME:   airportTable.tableName,
    APPROACH_TABLE_NAME:  instrApprTable.tableName,
    PROCEDURE_TABLE_NAME: apprProcTable.tableName,
    BUCKET_NAME:          "gennaroanesi.com",
    HF_TOKEN:             transcribeSecret.secretValueFromJson("hfToken").unsafeUnwrap(),
    ANTHROPIC_API_KEY:    transcribeSecret.secretValueFromJson("anthropicApiKey").unsafeUnwrap(),
  },
});

// Grant secret read
transcribeSecret.grantRead(transcribeFn);

// Read access to all tables the context builder queries
[audioTable, flightTable, airportTable, instrApprTable, apprProcTable].forEach((t) =>
  t.grantReadData(transcribeFn),
);

// Write access to flightAudio so the Lambda can update status + transcript
audioTable.grantWriteData(transcribeFn);

// S3 read: uploaded audio files + model weights cache
transcribeFn.addToRolePolicy(
  new PolicyStatement({
    effect:  Effect.ALLOW,
    actions: ["s3:GetObject", "s3:ListBucket"],
    resources: [
      `${customBucket.bucketArn}/public/flights/audio/*`,  // audio files
      `${customBucket.bucketArn}/private/models/*`,        // model weights
      customBucket.bucketArn,                              // needed for ListBucket
    ],
  }),
);

// DynamoDB Stream trigger — fires when transcriptStatus → PENDING
audioTable.grantStreamRead(transcribeFn);
transcribeFn.addEventSource(
  new DynamoEventSource(audioTable, {
    startingPosition: StartingPosition.LATEST,
    batchSize: 1,        // one at a time — each job is heavyweight
    retryAttempts: 1,    // one retry; FAILED status set by handler on error
    filters: [
      {
        pattern: JSON.stringify({
          eventName: ["INSERT", "MODIFY"],
          dynamodb: {
            NewImage: {
              transcriptStatus: { S: ["PENDING"] },
            },
          },
        }),
      },
    ],
  }),
);
