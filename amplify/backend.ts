import { defineBackend } from "@aws-amplify/backend";
import { Effect, Policy, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
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
import { CfnApi, CfnIntegration, CfnRoute, CfnStage } from "aws-cdk-lib/aws-apigatewayv2";
import { CfnOutput } from "aws-cdk-lib";


import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { sendNotification } from "./functions/sendNotification/resource";
import { checkAmmoThresholds } from "./functions/checkAmmoThresholds/resource";
import { importLogbook } from "./functions/importLogbook/resource";
import { notesApi } from "./functions/notesApi/resource";

const backend = defineBackend({
  auth,
  data,
  sendNotification,
  checkAmmoThresholds,
  importLogbook,
  notesApi,
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

// ── importLogbook infrastructure ─────────────────────────────────────────────
// SES receipt rule stores raw inbound email to S3 → triggers this Lambda.
// Manual setup required (see scripts/setup-ses-inbound.sh):
//   1. Verify gennaroanesi.com domain in SES
//   2. Add MX record: 10 inbound-smtp.us-east-1.amazonaws.com
//   3. Create SES receipt rule set + rule (handled in setup script)

const importFn = backend.importLogbook.resources.lambda as LambdaFunction;
const importFlightTable = tables["flight"];

// AppSync URL + API key for mutations — resolved from CDK at deploy time
const graphqlApi = backend.data.resources.graphqlApi as any;
importFn.addEnvironment("APPSYNC_URL",     graphqlApi.graphqlUrl);
importFn.addEnvironment("APPSYNC_API_KEY", graphqlApi.apiKey ?? "");
importFn.addEnvironment("FLIGHT_TABLE_NAME", importFlightTable.tableName);

// DynamoDB read for dedup scan
importFlightTable.grantReadData(importFn);

// AppSync write — Lambda calls AppSync directly via HTTP (API key auth)
// No extra IAM needed for API key auth.

// S3: read raw emails deposited by SES
importFn.addToRolePolicy(
  new PolicyStatement({
    effect:  Effect.ALLOW,
    actions: ["s3:GetObject"],
    resources: [`${customBucket.bucketArn}/private/email-import/*`],
  }),
);

// SES: send summary reply email
importFn.addToRolePolicy(
  new PolicyStatement({
    effect:  Effect.ALLOW,
    actions: ["ses:SendEmail", "ses:SendRawEmail"],
    resources: ["*"],
  }),
);

// S3 trigger: fires when SES writes a new email object
importFn.addToRolePolicy(
  new PolicyStatement({
    effect:  Effect.ALLOW,
    actions: ["s3:GetBucketNotification", "s3:PutBucketNotification"],
    resources: [customBucket.bucketArn],
  }),
);

// ── notesApi infrastructure ─────────────────────────────────────────────────
// HTTP API Gateway → Lambda → S3 PARA/
// Auth: Bearer token stored in gennaroanesi/notes secret
// Create once:
//   aws secretsmanager create-secret --name gennaroanesi/notes \
//     --secret-string '{"token":"<generate a strong random token>"}'
//
// After deploy, the API URL is printed in the stack outputs as NotesApiUrl.
// Use it in Claude as: https://<id>.execute-api.us-east-1.amazonaws.com

{
  // Lambda lives in the "data" resource group (same nested stack as other data functions).
  // API Gateway constructs go in backend.stack (root) to avoid circular dependencies.
  const notesFn    = backend.notesApi.resources.lambda as LambdaFunction;
  const notesScope = backend.stack;

  // Secret: the bearer token Claude will use
  const notesSecret = Secret.fromSecretNameV2(
    notesScope,
    "NotesApiSecret",
    "gennaroanesi/notes",
  );
  notesSecret.grantRead(notesFn);

  // Env vars — injected via cfnFn to avoid cross-stack addEnvironment issues
  const cfnNotesFn = notesFn.node.defaultChild as any;
  Object.assign(cfnNotesFn, {
    environment: {
      variables: {
        BUCKET_NAME:      "gennaroanesi.com",
        NOTES_API_TOKEN:  notesSecret.secretValueFromJson("token").unsafeUnwrap(),
      },
    },
  });

  // S3 permissions — PARA/ prefix only
  notesFn.addToRolePolicy(new PolicyStatement({
    effect:  Effect.ALLOW,
    actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
    resources: ["arn:aws:s3:::gennaroanesi.com/PARA/*"],
  }));
  notesFn.addToRolePolicy(new PolicyStatement({
    effect:    Effect.ALLOW,
    actions:   ["s3:ListBucket"],
    resources: ["arn:aws:s3:::gennaroanesi.com"],
    conditions: { StringLike: { "s3:prefix": ["PARA/", "PARA/*"] } },
  }));

  // HTTP API (L1 constructs — no alpha packages needed)
  const cfnApi = new CfnApi(notesScope, "NotesHttpApi", {
    name:         "notesApi",
    description:  "Household PARA vault CRUD",
    protocolType: "HTTP",
    corsConfiguration: {
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "PUT", "DELETE", "OPTIONS"],
      allowOrigins: ["*"],
    },
  });

  // Auto-deploy $default stage
  new CfnStage(notesScope, "NotesDefaultStage", {
    apiId:      cfnApi.ref,
    stageName:  "$default",
    autoDeploy: true,
  });

  // Lambda proxy integration
  const cfnIntegration = new CfnIntegration(notesScope, "NotesLambdaIntegration", {
    apiId:                cfnApi.ref,
    integrationType:      "AWS_PROXY",
    integrationUri:       notesFn.functionArn,
    payloadFormatVersion: "2.0",
  });

  // Grant API Gateway permission to invoke the Lambda
  notesFn.addPermission("NotesApiGatewayInvoke", {
    principal:   new ServicePrincipal("apigateway.amazonaws.com"),
    action:      "lambda:InvokeFunction",
    sourceArn:   `arn:aws:execute-api:${notesScope.region}:${notesScope.account}:${cfnApi.ref}/*`,
  });

  // Routes
  new CfnRoute(notesScope, "NotesListRoute", {
    apiId:    cfnApi.ref,
    routeKey: "GET /notes",
    target:   `integrations/${cfnIntegration.ref}`,
  });
  new CfnRoute(notesScope, "NotesGetRoute", {
    apiId:    cfnApi.ref,
    routeKey: "GET /notes/{key+}",
    target:   `integrations/${cfnIntegration.ref}`,
  });
  new CfnRoute(notesScope, "NotesPutRoute", {
    apiId:    cfnApi.ref,
    routeKey: "PUT /notes/{key+}",
    target:   `integrations/${cfnIntegration.ref}`,
  });
  new CfnRoute(notesScope, "NotesDeleteRoute", {
    apiId:    cfnApi.ref,
    routeKey: "DELETE /notes/{key+}",
    target:   `integrations/${cfnIntegration.ref}`,
  });

  // Output URL — printed after deploy, needed to configure Claude
  new CfnOutput(notesScope, "NotesApiUrl", {
    value:       `https://${cfnApi.ref}.execute-api.us-east-1.amazonaws.com`,
    description: "Notes API base URL — use as NOTES_API_URL in Claude",
  });
}

// Allow S3 to invoke the Lambda (also done in setup-ses-inbound.sh for SES direct invoke)
importFn.addPermission("S3InvokeImportLogbook", {
  principal: new ServicePrincipal("s3.amazonaws.com"),
  action:    "lambda:InvokeFunction",
  sourceArn: customBucket.bucketArn,
});

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
