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
#   - The stack has no adminUserEmail context input.
#
# The synth MUST use the same stackName the deploy will use, or it produces a
# template for the wrong stack (with the wrong TAK-<name>-BaseInfra imports) and
# the change set is meaningless. The stackName COMPONENT is derived from the
# passed CloudFormation stack name (TAK-<component>-TAKTeamManager -> <component>)
# and forwarded as --context stackName, so this works for BOTH callers:
#   - demo-deploy passes TAK-<DEMO_STACK_NAME>-TAKTeamManager (prod profile,
#     demo stack name), and
#   - production-deploy passes TAK-<PROD_STACK_NAME>-TAKTeamManager.
# The profile is always envType=prod: change-set validation checks the
# production CONFIGURATION against the live stack, which is exactly what the
# demo flow's prod-profile deploy and the production deploy both apply.
#
# Usage: scripts/github/validate-changeset.sh <cloudformation-stack-name>
#   e.g. scripts/github/validate-changeset.sh TAK-Prod-TAKTeamManager

set -euo pipefail

STACK_NAME=${1:?Usage: validate-changeset.sh <cloudformation-stack-name>}
CHANGE_SET_NAME="breaking-change-check-$(date +%s)"

# Derive the stackName component from the CFN stack name: strip the leading
# "TAK-" and the trailing "-TAKTeamManager". If the name does not match that
# shape, fall back to the whole argument (so an unusual name still synths
# *something* rather than an empty context value).
STACK_NAME_COMPONENT="$STACK_NAME"
STACK_NAME_COMPONENT="${STACK_NAME_COMPONENT#TAK-}"
STACK_NAME_COMPONENT="${STACK_NAME_COMPONENT%-TAKTeamManager}"

echo "🔍 Creating CloudFormation change set for $STACK_NAME (stackName=$STACK_NAME_COMPONENT)..."

# Nothing to compare against on a first-ever deploy.
if ! aws cloudformation describe-stacks --stack-name "$STACK_NAME" >/dev/null 2>&1; then
  echo "✅ Stack does not exist - skipping change set validation for initial deployment"
  exit 0
fi

# Generate the CDK template with the SAME context the deploy uses: the prod
# profile under the target stack's own name.
#
# Invoked as `npm run cdk synth --` (NOT `npx cdk synth`), matching auth-infra /
# tak-infra. This runs the package's own `cdk` script, which resolves the local
# CDK and evaluates `cdk.json`'s `app` (ts-node bin/cdk.ts) so the env-config
# context is loaded correctly. `npx cdk synth` here previously ran the compiled
# bin/cdk.js with the context not applied, so envType defaulted to dev-test and
# the app threw "Environment configuration for 'dev-test' not found" -- the
# whole reason this validation step was failing. No separate `npm run build` is
# needed; ts-node executes the TypeScript directly.
#
# Run from cdk/ (this repo's CDK app lives there, unlike the sibling repos whose
# CDK is at the repo root); write the template to the repo root so the path
# below is stable regardless of cwd. deviceManagementEnabled / offlineMapsEnabled
# are NOT passed -- they now default to true in cdk.json (see PR #18), so the
# synthesised template already matches what deploys.
TEMPLATE_PATH="$(pwd)/template.json"
(
  cd cdk
  npm run --silent cdk synth -- --context envType=prod --context stackName="$STACK_NAME_COMPONENT"
) > "$TEMPLATE_PATH"

# create-change-set accepts an INLINE --template-body only up to 51,200 bytes;
# a larger template MUST be uploaded to S3 and referenced with --template-url.
# Ours crossed that limit once device management + offline maps became defaults
# (extra resources/imports), so branch on the actual size rather than assuming
# inline always works (the sibling repos' templates happen to stay under it).
TEMPLATE_BYTES=$(wc -c < "$TEMPLATE_PATH")
INLINE_LIMIT=51200
S3_UPLOADED=""

if [ "$TEMPLATE_BYTES" -le "$INLINE_LIMIT" ]; then
  echo "Template is ${TEMPLATE_BYTES} bytes (<= ${INLINE_LIMIT}); passing inline."
  TEMPLATE_ARG=(--template-body "file://$TEMPLATE_PATH")
else
  echo "Template is ${TEMPLATE_BYTES} bytes (> ${INLINE_LIMIT}); uploading to S3 and using --template-url."
  # Reuse the BaseInfra env-config bucket (the deploy role already reads/writes
  # it — it holds the Part-2 config file). Resolved from the same per-stack
  # export the stack imports, so it tracks the target account/region.
  CONFIG_BUCKET=$(aws cloudformation describe-stacks \
    --stack-name "TAK-${STACK_NAME_COMPONENT}-BaseInfra" \
    --query 'Stacks[0].Outputs[?OutputKey==`EnvConfigBucketOutput` || OutputKey==`EnvConfigBucket`].OutputValue' \
    --output text 2>/dev/null)
  if [ -z "$CONFIG_BUCKET" ] || [ "$CONFIG_BUCKET" = "None" ]; then
    # Fall back to the CloudFormation EXPORT name if the output key differs.
    CONFIG_BUCKET=$(aws cloudformation list-exports \
      --query "Exports[?Name=='TAK-${STACK_NAME_COMPONENT}-BaseInfra-EnvConfigBucket'].Value" \
      --output text 2>/dev/null)
  fi
  if [ -z "$CONFIG_BUCKET" ] || [ "$CONFIG_BUCKET" = "None" ]; then
    echo "ERROR: could not resolve the BaseInfra env-config bucket for changeset template upload"
    exit 1
  fi
  S3_KEY="changeset-templates/${STACK_NAME}-${CHANGE_SET_NAME}.json"
  S3_UPLOADED="s3://${CONFIG_BUCKET}/${S3_KEY}"
  aws s3 cp "$TEMPLATE_PATH" "$S3_UPLOADED" >/dev/null
  # A presigned URL lets create-change-set fetch the object without granting
  # CloudFormation its own bucket read; valid well beyond the short-lived
  # change-set create.
  TEMPLATE_URL=$(aws s3 presign "$S3_UPLOADED" --expires-in 900)
  TEMPLATE_ARG=(--template-url "$TEMPLATE_URL")
fi

# Remove the uploaded template on exit (best-effort), whatever the outcome.
cleanup_s3() { [ -n "$S3_UPLOADED" ] && aws s3 rm "$S3_UPLOADED" >/dev/null 2>&1 || true; }
trap cleanup_s3 EXIT

aws cloudformation create-change-set \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME" \
  "${TEMPLATE_ARG[@]}" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM

aws cloudformation wait change-set-create-complete \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME"

# Detect DANGEROUS resource replacements, EXCLUDING AWS::ECS::TaskDefinition.
#
# An ECS task definition is IMMUTABLE by design: every property that matters
# (ContainerDefinitions, Cpu, Memory) has RequiresRecreation: Always, so ANY
# change -- including the image tag, which is a fresh content hash on every
# build -- makes CloudFormation "replace" it with a new revision and roll the
# service onto it. That is the normal, safe ECS deploy mechanism, NOT a
# destructive replacement like an RDS instance or an S3 bucket. So a task-def
# replacement shows up on essentially every deploy and is a false positive for
# this guard; excluding it keeps the guard meaningful for the replacements that
# actually cause downtime/data loss.
#
# This is a deliberate divergence from the sibling repos' changeset scripts
# (auth-infra/tak-infra), which filter nothing -- they simply haven't exercised
# the changeset path with a changed container, so they've not hit this. The
# exclusion is scoped STRICTLY to AWS::ECS::TaskDefinition; every other resource
# type still trips the guard on replacement.
REPLACEMENTS=$(aws cloudformation describe-change-set \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME" \
  --query "Changes[?ResourceChange.Replacement=='True' && ResourceChange.ResourceType!='AWS::ECS::TaskDefinition'].ResourceChange.LogicalResourceId" \
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
