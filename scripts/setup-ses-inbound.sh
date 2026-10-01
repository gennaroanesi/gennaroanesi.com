#!/usr/bin/env bash
# setup-ses-inbound.sh
#
# Idempotent setup for inbound-email ingestion on gennaroanesi.com.
# Run after the backend has deployed (the Lambdas must exist).
#
# What it does:
#   1. Verifies the gennaroanesi.com domain in SES (if not already done)
#   2. Retires the dead logbookimport@ pipeline (rule, bucket policy, trigger)
#   3. invoices@  → S3 private/invoice-inbound/  → invoiceProcessor
#   4. paychecks@ → S3 private/paycheck-inbound/ → paycheckProcessor
#   5. Prints the MX record needed in Route53
#
# SES allows ONE active receipt rule set per account+region — not per
# domain. Rules match on recipient, so this site's rules live in whatever set
# is active (currently "91dispatcher-inbound", shared with 91dispatcher.ai).
#
# Usage:
#   AWS_PROFILE=admin ./scripts/setup-ses-inbound.sh
#
# Requirements:
#   - AWS CLI with admin credentials (not amplify-dev — it can't read the
#     bucket policy, and a blind write would clobber it)
#   - python3

set -euo pipefail

REGION="us-east-1"
ACCOUNT="802060244747"
BUCKET="gennaroanesi.com"
DOMAIN="gennaroanesi.com"

# ── 1. Verify domain in SES ───────────────────────────────────────────────────
echo ""
echo "==> Verifying domain $DOMAIN in SES..."
aws sesv2 create-email-identity \
  --email-identity "$DOMAIN" \
  --region $REGION 2>/dev/null || echo "  (already exists — skipping)"

# ── 2. Retire logbookimport@ ──────────────────────────────────────────────────
# The email-triggered logbook import (importLogbook Lambda) is gone. Its rule
# lived in the inactive "gennaroanesi-inbound" set, so it never fired. Strip
# the leftovers so they can't break anything:
#   - the bucket-notification entry MUST go: once the Lambda is deleted, S3
#     rejects every put-bucket-notification-configuration that still
#     references it (which would break sections 3–4 below).
#   - the SES PutObject grant for private/email-import/.
#   - the old receipt rule.
echo ""
echo "==> Retiring logbookimport@ pipeline..."
aws ses delete-receipt-rule --rule-set-name "gennaroanesi-inbound" \
  --rule-name "logbook-import" --region $REGION >/dev/null 2>&1 || true
echo "  Receipt rule logbook-import removed (or already gone)."

NOTIF=$(aws s3api get-bucket-notification-configuration --bucket "$BUCKET") || {
  echo "ERROR: cannot read the bucket notification config (need s3:GetBucketNotification)."
  exit 1
}
if echo "$NOTIF" | grep -q "email-import-to-importLogbook"; then
  python3 -c "
import json
config = json.loads('''$NOTIF''')
config['LambdaFunctionConfigurations'] = [
    l for l in config.get('LambdaFunctionConfigurations', [])
    if l.get('Id') != 'email-import-to-importLogbook'
]
config.pop('ResponseMetadata', None)
print(json.dumps(config))
" | aws s3api put-bucket-notification-configuration --bucket "$BUCKET" --notification-configuration file:///dev/stdin
  echo "  Removed bucket notification email-import-to-importLogbook."
else
  echo "  (bucket notification already gone)"
fi

POLICY=$(aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text) || {
  echo "ERROR: cannot read the current bucket policy (need s3:GetBucketPolicy)."
  exit 1
}
if echo "$POLICY" | grep -q "private/email-import/"; then
  python3 -c "
import json
policy = json.loads('''$POLICY''')
policy['Statement'] = [
    st for st in policy['Statement']
    if 'private/email-import/' not in json.dumps(st.get('Resource', ''))
]
print(json.dumps(policy))
" | aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///dev/stdin
  echo "  Removed SES bucket-policy grant for private/email-import/."
else
  echo "  (bucket-policy grant already gone)"
fi

# ── 3. Invoice ingestion: invoices@ → S3 → invoiceProcessor Lambda ──────────
# The Lambda is triggered by an S3 bucket notification on the invoice-inbound
# prefix (not an SES LambdaAction):
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

# Runs BEFORE the receipt rule: SES validates an S3Action at rule-creation
# time by writing a test object, which fails without this grant.
echo ""
echo "==> Adding S3 bucket policy for SES (invoice prefix)..."
# HARD-FAIL if we can't READ the current policy. The merge below rewrites the
# WHOLE policy — running with credentials that can Put but not Get (e.g.
# amplify-dev) would silently replace the bucket policy with only our
# statement, breaking public reads + the other SES grants. This exact
# incident happened on 2026-07-29; run with an admin profile:
#   AWS_PROFILE=admin ./scripts/setup-ses-inbound.sh
EXISTING_POLICY=$(aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text) || {
  echo "ERROR: cannot read the current bucket policy (need s3:GetBucketPolicy)."
  echo "Refusing to continue — a blind put would clobber existing statements."
  exit 1
}

# Each SES statement is scoped to its own prefix, so check for THIS prefix.
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

# Create-or-update by explicit existence check: the old
# `create 2>/dev/null || update` hid the real create error (e.g. SES failing
# its test write to S3) behind a misleading RuleDoesNotExist from update.
if aws ses describe-receipt-rule --rule-set-name "$ACTIVE_RULE_SET" \
     --rule-name "$INVOICE_RULE_NAME" --region $REGION >/dev/null 2>&1; then
  aws ses update-receipt-rule \
    --rule-set-name "$ACTIVE_RULE_SET" \
    --rule "$INVOICE_RULE_JSON" \
    --region $REGION
else
  aws ses create-receipt-rule \
    --rule-set-name "$ACTIVE_RULE_SET" \
    --rule "$INVOICE_RULE_JSON" \
    --region $REGION
fi
echo "  Receipt rule created/updated."

echo ""
echo "==> Wiring S3 bucket notification → invoiceProcessor..."
# Merge (don't clobber) — put-bucket-notification-configuration replaces the
# whole config, so read the current one and append/refresh our entry.
# HARD-FAIL if the read fails (same clobber hazard as the bucket policy above).
EXISTING_NOTIF=$(aws s3api get-bucket-notification-configuration --bucket "$BUCKET") || {
  echo "ERROR: cannot read the current bucket notification config (need s3:GetBucketNotification)."
  echo "Refusing to continue — a blind put would drop the other triggers."
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

# ── 4. Paycheck ingestion: paychecks@ → S3 → paycheckProcessor Lambda ───────
# Identical shape to section 3 (reuses ACTIVE_RULE_SET). Rows land in
# financePaycheckInbox as NEEDS_REVIEW; the paychecks page imports them.

PAYCHECK_RULE_NAME="paycheck-ingest"
PAYCHECK_RECIPIENT="paychecks@gennaroanesi.com"
PAYCHECK_PREFIX="private/paycheck-inbound"

echo ""
echo "==> Resolving paycheckProcessor Lambda ARN..."
PAYCHECK_LAMBDA_NAME=$(aws lambda list-functions \
  --region $REGION \
  --query "Functions[?contains(FunctionName, 'paycheckProcessor') && contains(FunctionName, 'd3hzztqj54ajlt')].FunctionName" \
  --output text | tr '\t' '\n' | head -1)

if [ -z "$PAYCHECK_LAMBDA_NAME" ]; then
  echo "ERROR: Could not find paycheckProcessor Lambda. Deploy the backend first."
  exit 1
fi

PAYCHECK_LAMBDA_ARN=$(aws lambda get-function \
  --function-name "$PAYCHECK_LAMBDA_NAME" \
  --region $REGION \
  --query "Configuration.FunctionArn" \
  --output text)

echo "  Lambda name: $PAYCHECK_LAMBDA_NAME"
echo "  Lambda ARN:  $PAYCHECK_LAMBDA_ARN"

# Runs BEFORE the receipt rule: SES validates an S3Action at rule-creation
# time by writing a test object, which fails without this grant.
echo ""
echo "==> Adding S3 bucket policy for SES (paycheck prefix)..."
# HARD-FAIL if we can't READ the current policy. The merge below rewrites the
# WHOLE policy — running with credentials that can Put but not Get (e.g.
# amplify-dev) would silently replace the bucket policy with only our
# statement, breaking public reads + the other SES grants. This exact
# incident happened on 2026-07-29; run with an admin profile:
#   AWS_PROFILE=admin ./scripts/setup-ses-inbound.sh
EXISTING_POLICY=$(aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text) || {
  echo "ERROR: cannot read the current bucket policy (need s3:GetBucketPolicy)."
  echo "Refusing to continue — a blind put would clobber existing statements."
  exit 1
}

# Each SES statement is scoped to its own prefix, so check for THIS prefix.
if echo "$EXISTING_POLICY" | grep -q "$PAYCHECK_PREFIX"; then
  echo "  SES bucket policy for $PAYCHECK_PREFIX already present — skipping."
else
  SES_PAYCHECK_STATEMENT=$(cat <<EOF
{
  "Sid": "AllowSESPutObjectPaychecks",
  "Effect": "Allow",
  "Principal": { "Service": "ses.amazonaws.com" },
  "Action": "s3:PutObject",
  "Resource": "arn:aws:s3:::$BUCKET/$PAYCHECK_PREFIX/*",
  "Condition": {
    "StringEquals": { "AWS:SourceAccount": "$ACCOUNT" }
  }
}
EOF
)
  python3 -c "
import json, sys
policy = json.loads('''$EXISTING_POLICY''')
stmt = json.loads('''$SES_PAYCHECK_STATEMENT''')
policy['Statement'].append(stmt)
print(json.dumps(policy))
" | aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///dev/stdin
  echo "  S3 bucket policy updated."
fi

echo ""
echo "==> Creating receipt rule: $PAYCHECK_RULE_NAME..."
PAYCHECK_RULE_JSON=$(cat <<EOF
{
  "Name": "$PAYCHECK_RULE_NAME",
  "Enabled": true,
  "TlsPolicy": "Optional",
  "Recipients": ["$PAYCHECK_RECIPIENT"],
  "Actions": [
    {
      "S3Action": {
        "BucketName": "$BUCKET",
        "ObjectKeyPrefix": "$PAYCHECK_PREFIX/"
      }
    }
  ],
  "ScanEnabled": false
}
EOF
)

# Create-or-update by explicit existence check: the old
# `create 2>/dev/null || update` hid the real create error (e.g. SES failing
# its test write to S3) behind a misleading RuleDoesNotExist from update.
if aws ses describe-receipt-rule --rule-set-name "$ACTIVE_RULE_SET" \
     --rule-name "$PAYCHECK_RULE_NAME" --region $REGION >/dev/null 2>&1; then
  aws ses update-receipt-rule \
    --rule-set-name "$ACTIVE_RULE_SET" \
    --rule "$PAYCHECK_RULE_JSON" \
    --region $REGION
else
  aws ses create-receipt-rule \
    --rule-set-name "$ACTIVE_RULE_SET" \
    --rule "$PAYCHECK_RULE_JSON" \
    --region $REGION
fi
echo "  Receipt rule created/updated."

echo ""
echo "==> Wiring S3 bucket notification → paycheckProcessor..."
# Merge (don't clobber) — put-bucket-notification-configuration replaces the
# whole config, so read the current one and append/refresh our entry.
# HARD-FAIL if the read fails (same clobber hazard as the bucket policy above).
EXISTING_NOTIF=$(aws s3api get-bucket-notification-configuration --bucket "$BUCKET") || {
  echo "ERROR: cannot read the current bucket notification config (need s3:GetBucketNotification)."
  echo "Refusing to continue — a blind put would drop the other triggers."
  exit 1
}
python3 -c "
import json
config = json.loads('''$EXISTING_NOTIF''')
lambdas = config.get('LambdaFunctionConfigurations', [])
# Drop any stale entry for this id, then re-add with the current ARN.
lambdas = [l for l in lambdas if l.get('Id') != 'paycheck-inbound-to-paycheckProcessor']
lambdas.append({
    'Id': 'paycheck-inbound-to-paycheckProcessor',
    'LambdaFunctionArn': '$PAYCHECK_LAMBDA_ARN',
    'Events': ['s3:ObjectCreated:*'],
    'Filter': {'Key': {'FilterRules': [{'Name': 'prefix', 'Value': '$PAYCHECK_PREFIX/'}]}},
})
config['LambdaFunctionConfigurations'] = lambdas
config.pop('ResponseMetadata', None)
print(json.dumps(config))
" | aws s3api put-bucket-notification-configuration --bucket "$BUCKET" --notification-configuration file:///dev/stdin
echo "  Bucket notification wired."

# ── 5. Check the MX record ────────────────────────────────────────────────────
# Inbound mail only reaches SES if the domain's MX points at it. Already in
# place for gennaroanesi.com — only print instructions when it's missing.
MX_TARGET="inbound-smtp.$REGION.amazonaws.com"
echo ""
echo "==> Checking MX record for $DOMAIN..."
if dig +short MX "$DOMAIN" | grep -q "$MX_TARGET"; then
  echo "  MX → $MX_TARGET already in place."
else
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "  MANUAL STEP REQUIRED: add this MX record in Route53"
  echo "════════════════════════════════════════════════════════════"
  echo "  Hosted Zone : $DOMAIN"
  echo "  Record Type : MX"
  echo "  Name        : $DOMAIN  (or @)"
  echo "  Value       : 10 $MX_TARGET"
  echo "  TTL         : 300"
  echo "════════════════════════════════════════════════════════════"
fi

echo ""
echo "==> Setup complete!"
echo ""
echo "  Invoices : forward an invoice email (PDF attachment or plain body) to"
echo "             $INVOICE_RECIPIENT — a financeInvoice row appears."
echo "  Paychecks: forward a paystub PDF to $PAYCHECK_RECIPIENT — it shows"
echo "             under \"Needs review\" on /finance/paychecks."
echo ""
