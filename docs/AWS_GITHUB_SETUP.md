# AWS GitHub Actions Setup for TAKTeamManager

This guide covers setting up GitHub Actions for the TAKTeamManager repository, building on the base infrastructure already configured in BaseInfra.

## Prerequisites

**⚠️ Important:** Steps 1-2 from the [BaseInfra AWS GitHub Setup](https://github.com/TAK-NZ/base-infra/blob/main/docs/AWS_GITHUB_SETUP.md) must be completed first:
- Route 53 DNS setup
- GitHub OIDC Identity Provider and IAM roles

> **Note:** The organization variables and secrets configured in BaseInfra are reused across environments.

**Required Infrastructure:** Ensure these stacks are deployed before TAKTeamManager:
- BaseInfra (VPC, ECS, KMS, ACM, config + artifacts buckets)
- AuthInfra (Authentik authentication services)
- TakInfra (TAK Server) - required when device management is enabled (the default)

## 3. GitHub Environment Setup for TAKTeamManager

The two deployment workflows target two GitHub environments:

- **`demo`** - deployed on every push to `main` (`.github/workflows/demo-deploy.yml`). It builds the app image, deploys the **production profile** under the demo stack name to exercise the prod configuration, then reverts demo back to its cheaper dev-test profile so it is always left in a consistent state.
- **`production`** - deployed on a `v*` tag (`.github/workflows/production-deploy.yml`).

### 3.1 Create Environments

In **Settings → Environments**, create:

1. **`production`**
   - **Protection rules:**
     - Required reviewers: Add team leads
     - Deployment branches and tags: "Selected branches and tags" → add rule `v*`

2. **`demo`**
   - **Protection rules:**
     - Deployment branches and tags: "Selected branches and tags" → add rule `main`

### 3.2 Environment Secrets and Variables

Each environment needs the OIDC role and region for its target account. The workflows reference:

| Name | Type | Used by | Purpose |
|------|------|---------|---------|
| `DEMO_AWS_ROLE_ARN` | Secret | demo | OIDC role to assume in the demo account |
| `DEMO_AWS_REGION` | Secret | demo | Deployment region |
| `DEMO_STACK_NAME` | Variable | demo | Env label; deploys `TAK-<DEMO_STACK_NAME>-TAKTeamManager` |
| `DEMO_TEST_DURATION` | Variable | demo | Optional soak time after deploy (seconds, default 300) |
| `PROD_AWS_ROLE_ARN` | Secret | production | OIDC role to assume in the production account |
| `PROD_AWS_REGION` | Secret | production | Deployment region |
| `PROD_AWS_ACCOUNT_ID` | Secret | production | Account id, used for `cdk bootstrap` |
| `PROD_STACK_NAME` | Variable | production | Env label; deploys `TAK-<PROD_STACK_NAME>-TAKTeamManager` |

> Each workflow overrides `--context stackName=<...>` so the deploy, change-set validation, and imported `TAK-<StackName>-BaseInfra` exports stay consistent with the target account - rather than using the `stackName` baked into `cdk.json`.

## 4. Branch Protection Setup

**Configure branch protection for `main`** to ensure only tested code is deployed:

1. Go to **Settings → Branches → Add rule**
2. **Branch name pattern**: `main`
3. **Enable these protections:**
   - ☑️ Require a pull request before merging
   - ☑️ Require status checks to pass before merging

## 5. How the Pipelines Build and Deploy

The CDK app lives in the `cdk/` subdirectory (not the repo root), so every workflow step runs CDK with `working-directory: cdk`.

- **Build once, deploy pre-built.** A reusable build workflow builds the single application image and pushes it to the BaseInfra artifacts ECR repo, emitting an `image-tag`. The deploy step then passes `--context usePreBuiltImages=true --context imageTag=<tag>` so no rebuild happens at deploy time. See the [Docker Image Strategy Guide](DOCKER_IMAGE_STRATEGY.md).
- **S3 config file.** Deploys pass `--context useS3TAKTeamManagerConfigFile=true` so the ECS task loads the ops-editable `tak-team-manager-config.env` object from the shared BaseInfra config bucket. This object must exist before the first deploy (an empty file is valid).
- **Change-set validation.** Before deploying, `scripts/github/validate-changeset.sh TAK-<StackName>-TAKTeamManager` guards against unexpected resource replacements. Put `[force-deploy]` in the commit message to skip it.
- **CDK tests.** `.github/workflows/cdk-test.yml` runs the CDK unit tests as a gate before any deploy.

## Quick Links

- **[Main README](../README.md)** - Complete project overview
- **[Deployment Guide](DEPLOYMENT_GUIDE.md)** - Detailed deployment instructions
- **[Docker Image Strategy](DOCKER_IMAGE_STRATEGY.md)** - Image build and selection
- **[Configuration Guide](PARAMETERS.md)** - Complete configuration reference
