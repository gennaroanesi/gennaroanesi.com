#!/bin/bash
# docker-push.sh
# Build and push the transcribeAudio Lambda container to its own ECR repo.
# Run this whenever you change the Dockerfile, requirements.txt, or src/*.py
#
# Usage: ./amplify/functions/transcribeAudio/scripts/docker-push.sh

set -e

ACCOUNT="802060244747"
REGION="us-east-1"
REPO="transcribe-audio"
TAG="latest"
IMAGE_URI="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:$TAG"

echo "==> Authenticating to ECR..."
aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

echo "==> Building image for linux/amd64..."
# --provenance=false prevents BuildKit from creating a multi-arch manifest index,
# which Lambda does not support. --output type=registry pushes directly to ECR.
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --output type=registry \
  -t "$IMAGE_URI" \
  "$(dirname "$0")/../"
echo "(image pushed directly to registry via buildx)"

echo "==> Done. Run 'npx ampx sandbox' to deploy."
