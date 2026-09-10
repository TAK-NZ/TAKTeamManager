#!/bin/bash
# CloudFormation change set validation.
#
# Synthesises this repo's CDK stack with the PROD profile and creates a
# throwaway CloudFormation change set against the live stack to detect resource
# REPLACEMENTS (which would cause downtime or data loss) before a deploy runs.
# A clean change set exits 0; any replacement exits 1 unless overridden with
# '[force-deploy]' in the triggering commit message (handled by the caller).
#
# Adapted from the sibling TAK-NZ infra repos, with two differences specific to
# this project:
#   - The CDK app lives in cdk/, not the repo root, so synth runs from there.
#   - The stack takes only `--context envType`; it has no stackName/adminUserEmail
#     context inputs (the deployed stackName comes from cdk.json's env block).
#
# Usage: scripts/github/validate-changeset.sh <cloudformation-stack-name>
#   e.g. scripts/github/validate-changeset.sh TAK-Prod-TAKTeamManager

set -euo pipefail

STACK_NAME=${1:?Usage: validate-changeset.sh <cloudformation-stack-name>}
CHANGE_SET_NAME="breaking-change-check-$(date +%s)"

echo "🔍 Creating CloudFormation change set for $STACK_NAME..."

# Nothing to compare against on a first-ever deploy.
if ! aws cloudformation describe-stacks --stack-name "$STACK_NAME" >/dev/null 2>&1; then
  echo "✅ Stack does not exist - skipping change set validation for initial deployment"
  exit 0
fi

# Generate the CDK template with the SAME context the production deploy uses.
# Synth from cdk/ (where package.json/cdk.json live); write the template to the
# repo root so the path below is stable regardless of cwd.
TEMPLATE_PATH="$(pwd)/template.json"
(
  cd cdk
  npm run --silent build
  npx cdk synth --context envType=prod
) > "$TEMPLATE_PATH"

aws cloudformation create-change-set \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME" \
  --template-body "file://$TEMPLATE_PATH" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM

aws cloudformation wait change-set-create-complete \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME"

REPLACEMENTS=$(aws cloudformation describe-change-set \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME" \
  --query 'Changes[?ResourceChange.Replacement==`True`].ResourceChange.LogicalResourceId' \
  --output text)

# Best-effort cleanup; never fail the run on cleanup alone.
aws cloudformation delete-change-set \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME" || true

if [ -n "$REPLACEMENTS" ]; then
  echo "❌ Resource replacements detected:"
  echo "$REPLACEMENTS"
  echo "💡 Use '[force-deploy]' in the commit message to override"
  exit 1
else
  echo "✅ No resource replacements detected"
fi
