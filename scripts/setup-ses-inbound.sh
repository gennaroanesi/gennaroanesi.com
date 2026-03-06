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
  --query "Functions[?contains(FunctionName, 'importLogbook')].FunctionName" \
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

# Activate it
aws ses set-active-receipt-rule-set \
  --rule-set-name "$RULE_SET_NAME" \
  --region $REGION
echo "  Rule set activated."

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

# ── 6. Print Route53 instructions ────────────────────────────────────────────
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
