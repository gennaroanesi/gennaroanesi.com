#!/usr/bin/env bash
# setup-ses-inbound.sh
#
# One-time setup for email-triggered logbook import.
# Run this ONCE after deploying the Amplify sandbox/prod environment.
#
# What it does:
#   1. Verifies gennaroanesi.com domain in SES (if not already done)
#   2. Creates/activates the SES receipt rule set
#   3. Creates the receipt rule: logbookimport@ → S3 → Lambda
#   4. Adds the S3 bucket notification to trigger importLogbook Lambda
#   5. Prints the MX record you need to add in Route53
#
# Usage:
#   ./scripts/setup-ses-inbound.sh [--env=sandbox|prod]
#
# Requirements:
#   - AWS CLI configured with admin credentials (not amplify-dev)
#   - jq installed
#   - amplify_outputs.json present (run `npx ampx sandbox` first)

set -euo pipefail

REGION="us-east-1"
ACCOUNT="802060244747"
BUCKET="gennaroanesi.com"
EMAIL_PREFIX="private/email-import"
RULE_SET_NAME="gennaroanesi-inbound"
RULE_NAME="logbook-import"
RECIPIENT="logbookimport@gennaroanesi.com"
DOMAIN="gennaroanesi.com"

# ── Resolve Lambda ARN from Amplify outputs ───────────────────────────────────
echo "==> Resolving importLogbook Lambda ARN..."

# Find the Amplify-generated function name — it contains 'importLogbook'
LAMBDA_NAME=$(aws lambda list-functions \
  --region $REGION \
  --query "Functions[?contains(FunctionName, 'importLogbook') && contains(FunctionName, 'd3hzztqj54ajlt')].FunctionName" \
  --output text | tr '\t' '\n' | head -1)

if [ -z "$LAMBDA_NAME" ]; then
  echo "ERROR: Could not find importLogbook Lambda. Run 'npx ampx sandbox' first."
  exit 1
fi

LAMBDA_ARN=$(aws lambda get-function \
  --function-name "$LAMBDA_NAME" \
  --region $REGION \
  --query "Configuration.FunctionArn" \
  --output text)

echo "  Lambda name: $LAMBDA_NAME"
echo "  Lambda ARN:  $LAMBDA_ARN"

# ── 1. Verify domain in SES ───────────────────────────────────────────────────
echo ""
echo "==> Verifying domain $DOMAIN in SES..."
aws sesv2 create-email-identity \
  --email-identity "$DOMAIN" \
  --region $REGION 2>/dev/null || echo "  (already exists — skipping)"

# ── 2. Create receipt rule set ────────────────────────────────────────────────
echo ""
echo "==> Creating SES receipt rule set: $RULE_SET_NAME..."
aws ses create-receipt-rule-set \
  --rule-set-name "$RULE_SET_NAME" \
  --region $REGION 2>/dev/null || echo "  (already exists — skipping)"

# Activate it — ONLY if no other set holds the active slot. SES allows one
# active rule set per account+region; blindly activating ours would break
# every other app's inbound mail (91dispatcher's set is the active one as
# of 2026-07). If another set is active, add rules to THAT set instead
# (section 6 does this automatically via ACTIVE_RULE_SET).
CURRENT_ACTIVE=$(aws ses describe-active-receipt-rule-set --region $REGION --query "Metadata.Name" --output text 2>/dev/null || echo "None")
if [ "$CURRENT_ACTIVE" = "None" ] || [ -z "$CURRENT_ACTIVE" ]; then
  aws ses set-active-receipt-rule-set \
    --rule-set-name "$RULE_SET_NAME" \
    --region $REGION
  echo "  Rule set activated."
elif [ "$CURRENT_ACTIVE" = "$RULE_SET_NAME" ]; then
  echo "  Rule set already active."
else
  echo "  NOT activating: '$CURRENT_ACTIVE' holds the active slot (shared with other apps)."
fi

# ── 3. Create receipt rule: logbookimport@ → S3 ───────────────────────────────
echo ""
echo "==> Creating receipt rule: $RULE_NAME..."

# Build the rule JSON
RULE_JSON=$(cat <<EOF
{
  "Name": "$RULE_NAME",
  "Enabled": true,
  "TlsPolicy": "Optional",
  "Recipients": ["$RECIPIENT"],
  "Actions": [
    {
      "S3Action": {
        "BucketName": "$BUCKET",
        "ObjectKeyPrefix": "$EMAIL_PREFIX/",
        "TopicArn": null
      }
    },
    {
      "LambdaAction": {
        "FunctionArn": "$LAMBDA_ARN",
        "InvocationType": "Event"
      }
    }
  ],
  "ScanEnabled": false
}
EOF
)

aws ses create-receipt-rule \
  --rule-set-name "$RULE_SET_NAME" \
  --rule "$RULE_JSON" \
  --region $REGION 2>/dev/null || \
aws ses update-receipt-rule \
  --rule-set-name "$RULE_SET_NAME" \
  --rule "$RULE_JSON" \
  --region $REGION
echo "  Receipt rule created/updated."

# ── 4. Grant SES permission to write to S3 ───────────────────────────────────
echo ""
echo "==> Adding S3 bucket policy for SES..."
EXISTING_POLICY=$(aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text 2>/dev/null || echo "{\"Statement\":[]}")

# Check if SES policy already present
if echo "$EXISTING_POLICY" | grep -q "ses.amazonaws.com"; then
  echo "  SES bucket policy already present — skipping."
else
  # Append SES write statement
  SES_STATEMENT=$(cat <<EOF
{
  "Sid": "AllowSESPutObject",
  "Effect": "Allow",
  "Principal": { "Service": "ses.amazonaws.com" },
  "Action": "s3:PutObject",
  "Resource": "arn:aws:s3:::$BUCKET/$EMAIL_PREFIX/*",
  "Condition": {
    "StringEquals": { "AWS:SourceAccount": "$ACCOUNT" }
  }
}
EOF
)
  # Merge: use Python since we can't pipe in bash
  python3 -c "
import json, sys
policy = json.loads('''$EXISTING_POLICY''')
stmt = json.loads('''$SES_STATEMENT''')
policy['Statement'].append(stmt)
print(json.dumps(policy))
" | aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///dev/stdin
  echo "  S3 bucket policy updated."
fi

# ── 5. Grant SES permission to invoke Lambda ─────────────────────────────────
echo ""
echo "==> Adding Lambda resource policy for SES..."
aws lambda add-permission \
  --function-name "$LAMBDA_ARN" \
  --statement-id "AllowSESInvoke" \
  --action "lambda:InvokeFunction" \
  --principal "ses.amazonaws.com" \
  --source-account "$ACCOUNT" \
  --region $REGION 2>/dev/null || echo "  (permission already exists — skipping)"

# ── 6. Invoice ingestion: invoices@ → S3 → invoiceProcessor Lambda ──────────
# Same shape as the logbook rule, but the Lambda is triggered by an S3
# bucket notification on the invoice-inbound prefix (not an SES LambdaAction):
#   SES rule stores raw email → s3://gennaroanesi.com/private/invoice-inbound/
#   S3 object-created notification (prefix-filtered) → invoiceProcessor.
# The Lambda's s3.amazonaws.com invoke permission is granted in
# amplify/backend.ts; this section owns the SES rule, the SES→S3 bucket
# policy for the new prefix, and the bucket-notification entry (merged into
# the existing config — put-bucket-notification-configuration REPLACES it).

INVOICE_RULE_NAME="invoice-ingest"
INVOICE_RECIPIENT="invoices@gennaroanesi.com"
INVOICE_PREFIX="private/invoice-inbound"

# SES allows exactly ONE active receipt rule set per account+region, and in
# this account 91dispatcher's set ("91dispatcher-inbound") holds the slot.
# A rule created in an inactive set silently bounces mail (550 5.1.1 —
# 2026-07-29 incident). Always target the ACTIVE set, whatever its name.
ACTIVE_RULE_SET=$(aws ses describe-active-receipt-rule-set --region $REGION --query "Metadata.Name" --output text)
if [ -z "$ACTIVE_RULE_SET" ] || [ "$ACTIVE_RULE_SET" = "None" ]; then
  echo "ERROR: no active SES receipt rule set in $REGION — activate one first."
  exit 1
fi
echo "  Active rule set: $ACTIVE_RULE_SET"

echo ""
echo "==> Resolving invoiceProcessor Lambda ARN..."
INVOICE_LAMBDA_NAME=$(aws lambda list-functions \
  --region $REGION \
  --query "Functions[?contains(FunctionName, 'invoiceProcessor') && contains(FunctionName, 'd3hzztqj54ajlt')].FunctionName" \
  --output text | tr '\t' '\n' | head -1)

if [ -z "$INVOICE_LAMBDA_NAME" ]; then
  echo "ERROR: Could not find invoiceProcessor Lambda. Deploy the backend first."
  exit 1
fi

INVOICE_LAMBDA_ARN=$(aws lambda get-function \
  --function-name "$INVOICE_LAMBDA_NAME" \
  --region $REGION \
  --query "Configuration.FunctionArn" \
  --output text)

echo "  Lambda name: $INVOICE_LAMBDA_NAME"
echo "  Lambda ARN:  $INVOICE_LAMBDA_ARN"

echo ""
echo "==> Creating receipt rule: $INVOICE_RULE_NAME..."
INVOICE_RULE_JSON=$(cat <<EOF
{
  "Name": "$INVOICE_RULE_NAME",
  "Enabled": true,
  "TlsPolicy": "Optional",
  "Recipients": ["$INVOICE_RECIPIENT"],
  "Actions": [
    {
      "S3Action": {
        "BucketName": "$BUCKET",
        "ObjectKeyPrefix": "$INVOICE_PREFIX/"
      }
    }
  ],
  "ScanEnabled": false
}
EOF
)

aws ses create-receipt-rule \
  --rule-set-name "$ACTIVE_RULE_SET" \
  --rule "$INVOICE_RULE_JSON" \
  --region $REGION 2>/dev/null || \
aws ses update-receipt-rule \
  --rule-set-name "$ACTIVE_RULE_SET" \
  --rule "$INVOICE_RULE_JSON" \
  --region $REGION
echo "  Receipt rule created/updated."

echo ""
echo "==> Adding S3 bucket policy for SES (invoice prefix)..."
# HARD-FAIL if we can't READ the current policy. The merge below rewrites the
# WHOLE policy — running with credentials that can Put but not Get (e.g.
# amplify-dev) would silently replace the bucket policy with only our
# statement, breaking public reads + the logbook SES grant. This exact
# incident happened on 2026-07-29; run with an admin profile:
#   AWS_PROFILE=admin ./scripts/setup-ses-inbound.sh
EXISTING_POLICY=$(aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text) || {
  echo "ERROR: cannot read the current bucket policy (need s3:GetBucketPolicy)."
  echo "Refusing to continue — a blind put would clobber existing statements."
  exit 1
}

# The logbook statement is scoped to its own prefix, so check for THIS prefix.
if echo "$EXISTING_POLICY" | grep -q "$INVOICE_PREFIX"; then
  echo "  SES bucket policy for $INVOICE_PREFIX already present — skipping."
else
  SES_INVOICE_STATEMENT=$(cat <<EOF
{
  "Sid": "AllowSESPutObjectInvoices",
  "Effect": "Allow",
  "Principal": { "Service": "ses.amazonaws.com" },
  "Action": "s3:PutObject",
  "Resource": "arn:aws:s3:::$BUCKET/$INVOICE_PREFIX/*",
  "Condition": {
    "StringEquals": { "AWS:SourceAccount": "$ACCOUNT" }
  }
}
EOF
)
  python3 -c "
import json, sys
policy = json.loads('''$EXISTING_POLICY''')
stmt = json.loads('''$SES_INVOICE_STATEMENT''')
policy['Statement'].append(stmt)
print(json.dumps(policy))
" | aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///dev/stdin
  echo "  S3 bucket policy updated."
fi

echo ""
echo "==> Wiring S3 bucket notification → invoiceProcessor..."
# Merge (don't clobber) — put-bucket-notification-configuration replaces the
# whole config, so read the current one and append/refresh our entry.
# HARD-FAIL if the read fails (same clobber hazard as the bucket policy above).
EXISTING_NOTIF=$(aws s3api get-bucket-notification-configuration --bucket "$BUCKET") || {
  echo "ERROR: cannot read the current bucket notification config (need s3:GetBucketNotification)."
  echo "Refusing to continue — a blind put would drop the logbook trigger."
  exit 1
}
python3 -c "
import json
config = json.loads('''$EXISTING_NOTIF''')
lambdas = config.get('LambdaFunctionConfigurations', [])
# Drop any stale entry for this id, then re-add with the current ARN.
lambdas = [l for l in lambdas if l.get('Id') != 'invoice-inbound-to-invoiceProcessor']
lambdas.append({
    'Id': 'invoice-inbound-to-invoiceProcessor',
    'LambdaFunctionArn': '$INVOICE_LAMBDA_ARN',
    'Events': ['s3:ObjectCreated:*'],
    'Filter': {'Key': {'FilterRules': [{'Name': 'prefix', 'Value': '$INVOICE_PREFIX/'}]}},
})
config['LambdaFunctionConfigurations'] = lambdas
config.pop('ResponseMetadata', None)
print(json.dumps(config))
" | aws s3api put-bucket-notification-configuration --bucket "$BUCKET" --notification-configuration file:///dev/stdin
echo "  Bucket notification wired."

# ── 7. Print Route53 instructions ────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  MANUAL STEP REQUIRED: Add this MX record in Route53"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "  Hosted Zone : $DOMAIN"
echo "  Record Type : MX"
echo "  Name        : $DOMAIN  (or @ )"
echo "  Value       : 10 inbound-smtp.$REGION.amazonaws.com"
echo "  TTL         : 300"
echo ""
echo "  In AWS Console:"
echo "  Route53 → Hosted zones → $DOMAIN → Create record"
echo "  Type: MX, Value: 10 inbound-smtp.$REGION.amazonaws.com"
echo ""
echo "  Or via CLI (replace HOSTED_ZONE_ID):"
echo "  aws route53 change-resource-record-sets \\"
echo "    --hosted-zone-id YOUR_ZONE_ID \\"
echo "    --change-batch '{"
echo '      "Changes": [{'
echo '        "Action": "CREATE",'
echo '        "ResourceRecordSet": {'
echo '          "Name": "'"$DOMAIN"'",'
echo '          "Type": "MX",'
echo '          "TTL": 300,'
echo '          "ResourceRecords": [{"Value": "10 inbound-smtp.'"$REGION"'.amazonaws.com"}]'
echo '        }'
echo "      }]'"
echo "    }'"
echo ""
echo "════════════════════════════════════════════════════════════"
echo ""
echo "==> Setup complete!"
echo ""
echo "Test by forwarding a ForeFlight CSV export email to:"
echo "  $RECIPIENT"
echo ""
echo "You'll receive a summary email when the import finishes."
echo ""
echo "Invoice ingestion: forward an invoice email (PDF attachment or plain"
echo "body) to $INVOICE_RECIPIENT — a financeInvoice record appears with the"
echo "PDF stored under private/invoices/."
