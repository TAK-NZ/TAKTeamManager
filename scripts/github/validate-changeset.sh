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
