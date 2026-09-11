# TAK Team Manager

<p align=center>Team, user, and channel management for Team Awareness Kit (TAK) deployments

## Overview

The [Team Awareness Kit (TAK)](https://tak.gov/solutions/emergency) provides Fire, Emergency Management, and First Responders an operationally agnostic tool for improved situational awareness and a common operational picture.

TAK Team Manager is the back-office web application for a complete TAK deployment. It manages TAK teams, users, and channels using [Authentik](https://goauthentik.io/) as the identity provider, with an optional TAK Server device-management integration for client-certificate enrollment and revocation - all while using [free and open source software](https://en.wikipedia.org/wiki/Free_and_open-source_software).

It is a Node/Express + PostgreSQL server with a React single-page-application client, served from a single origin (`team.tak.nz`) and deployed onto AWS ECS Fargate via AWS CDK, following the same conventions as the other TAK.NZ layers.

It is specifically targeted at the deployment of [TAK.NZ](https://tak.nz) via a CI/CD pipeline. Nevertheless others interested in deploying a similar application can do so by adapting the configuration items.

### Architecture Layers

This application requires the base, authentication, and (for device management) TAK infrastructure layers, each deployed as a separate stack from its own repository.

For the full layer diagram and deployment order across all TAK.NZ repositories, see the
[TAK.NZ organization overview](https://github.com/TAK-NZ). That diagram is maintained in one place
so it stays current as layers are added.

## Quick Start

### Prerequisites
- [AWS Account](https://signin.aws.amazon.com/signup) with configured credentials
- Base infrastructure stack (`TAK-<name>-BaseInfra`) must be deployed first
- Authentication infrastructure stack (`TAK-<name>-AuthInfra`) must be deployed first
- TAK server infrastructure stack (`TAK-<name>-TakInfra`) must be deployed first (required when device management is enabled - the default)
- Public Route 53 hosted zone (e.g., `tak.nz`)
- [Node.js](https://nodejs.org/) and npm installed
- **For CI/CD deployment:** See [AWS & GitHub Setup Guide](docs/AWS_GITHUB_SETUP.md) for TAKTeamManager-specific GitHub Actions configuration

### Installation & Deployment

```bash
# 1. Install CDK dependencies
cd cdk && npm install

# 2. Bootstrap CDK (first time only)
npx cdk bootstrap --profile your-aws-profile

# 3. Deploy development environment
npm run deploy:dev

# 4. Deploy production environment
npm run deploy:prod
```

For running the application locally without AWS, see the [Deployment Guide](docs/DEPLOYMENT_GUIDE.md#local-development).

## Application Resources

### Compute & Services
- **ECS Fargate Service** - The app container (Express API + built SPA on one origin, port 3000) behind a dual-stack Application Load Balancer with a `GET /health` check
- **Sync Worker** - A second ECS task (the same image with its command overridden) that drains the Authentik / TAK Server write queue and runs the device-management pollers
- **Aurora PostgreSQL** - Serverless v2 (dev) or provisioned instances (prod), holding teams, users, channels, the sync queue, and audit logs

### Integration
- **Authentik** - OAuth2/OIDC single sign-on, plus a least-privilege management-API service account for user and group writes
- **TAK Server** *(optional)* - Marti certadmin mutual-TLS integration for device certificate enrollment, polling, and revocation
- **CloudTAK** *(optional)* - Agency-group mirroring into Authentik LDAP groups

### Security & DNS
- **AWS Secrets Manager** - JWT signing secret, credential-encryption key, database and Authentik credentials
- **Route 53 Records** - `A`/`AAAA` alias at `team.<zone>`, dual-stack
- **KMS Encryption** - Data encryption at rest and in transit (imported from BaseInfra)
- **ACM Certificate** - SSL certificate (imported from BaseInfra)

## Docker Image Strategy

This application ships as a single Docker image (a two-stage build: `vite build` for the client, then a production Node runtime). The web process and the sync worker are the same image with different startup commands. The CDK stack uses a hybrid image strategy that supports both local building and pre-built ECR images.

- **Strategy**: See [Docker Image Strategy Guide](docs/DOCKER_IMAGE_STRATEGY.md) for details
- **CI/CD Mode**: Uses pre-built images from the BaseInfra artifacts ECR repo (`--context usePreBuiltImages=true`)
- **Development Mode**: Builds the image locally from the repo-root `Dockerfile` via a CDK `DockerImageAsset`
- **Automatic Fallback**: Selects the mode based on context parameters

### Docker Images Used

1. **TAK Team Manager**: Express API, built SPA, and the sync worker (one image, two commands)

## Available Environments

| Environment | Stack Name | Description | Domain |
|-------------|------------|-------------|--------|
| `dev-test` | `TAK-Dev-TAKTeamManager` | Cost-optimized development | `team.dev.tak.nz` |
| `prod` | `TAK-Prod-TAKTeamManager` | High-availability production | `team.tak.nz` |

## Development Workflow

### NPM Scripts

CDK deployment scripts run from the `cdk/` directory:

```bash
# From cdk/ - Environment-Specific Deployment
npm run deploy:dev            # Deploy to dev-test
npm run deploy:prod           # Deploy to production
npm run synth:dev             # Preview dev infrastructure
npm run synth:prod            # Preview prod infrastructure
npm run cdk:diff:dev          # Show what would change in dev
npm run cdk:diff:prod         # Show what would change in prod
npm run cdk:bootstrap         # Bootstrap CDK in account
```

Application development scripts run from the repository root:

```bash
# From repo root - Local Development
npm run dev                   # Run server + client concurrently
npm run server:dev            # Run the API with nodemon
npm run build                 # Build the client bundle
npm start                     # Run the production web process
npm test                      # Run the server Jest suite
npm run lint                  # Lint server, scripts, and database code

# Database
npm run migrate:up            # Apply migrations
npm run migrate:create        # Scaffold a new migration

# Docker (local, all-in-one)
npm run docker:up             # Start postgres + app + sync worker
npm run docker:init-db        # Initialize the database (first run)
```

Client tests run from `client/` with their own Vitest runner (`cd client && npm test`).

### Configuration System

Deployment uses two complementary layers, both landing in the same running ECS task:

- **AWS CDK context** - Infrastructure settings (stack name, hostname, database, ECS sizing, feature toggles) stored in [`cdk/cdk.json`](cdk/cdk.json) under the `context` section, version-controlled and overridable at deploy time with `--context`.
- **Deployment config file** - Operations-editable runtime settings (SMTP, reCAPTCHA, feature flags, colour/role labels, tuning) uploaded to the shared S3 config bucket and loaded via `ecs.EnvironmentFile.fromBucket`. Edit by replacing the S3 object and restarting the task - no CDK redeploy.

See the [Configuration Guide](docs/PARAMETERS.md) for the full reference and [`.env.example`](.env.example) for every variable the application reads.

#### Configuration Override Examples
```bash
# Override ECS task sizing
npm run deploy:dev -- --context taskCpu=1024 --context desiredCount=3

# Deploy without the TAK Server device-management dependency
npm run deploy:dev -- --context deviceManagementEnabled=false

# Use pre-built images instead of building locally
npm run deploy:prod -- --context usePreBuiltImages=true
```

## 📚 Documentation

- **[🚀 Deployment Guide](docs/DEPLOYMENT_GUIDE.md)** - Comprehensive deployment instructions, including local development
- **[🏗️ Architecture Guide](docs/ARCHITECTURE.md)** - Technical architecture and design decisions
- **[⚡ Quick Reference](docs/QUICK_REFERENCE.md)** - Fast deployment commands and environment comparison
- **[⚙️ Configuration Guide](docs/PARAMETERS.md)** - Complete configuration management reference
- **[🔧 AWS & GitHub Setup](docs/AWS_GITHUB_SETUP.md)** - CI/CD, GitHub Actions, and multi-account OIDC configuration
- **[🐳 Docker Image Strategy](docs/DOCKER_IMAGE_STRATEGY.md)** - Hybrid image strategy for fast CI/CD and flexible development
- **[👥 End-User Guide](docs/END-USER-DOCS.md)** - Day-to-day guide for team members and team admins
- **[📈 Authentik Scaling Lessons](docs/authentik-scaling-lessons.md)** - Operational lessons from scaling against Authentik
- **[🔬 Authentik Rate-Limit Profiling](docs/authentik-ratelimit-profiling.md)** - Measured evidence behind the rate-limit ceilings
- **[📊 CloudWatch Metrics & Alarms](docs/cloudwatch-metrics.md)** - Metrics and alarms guidance for the CDK deployment
- **[🗺️ Offline Maps Deployment](docs/offline-maps-deployment.md)** - AWS handoff for the offline-maps download feature

## Security Features

### Enterprise-Grade Security
- **🔑 KMS Encryption** - All data encrypted with customer-managed keys
- **🛡️ Deny-by-Default Authorization** - An unmapped route is denied, never permitted; permissions resolve through a central registry
- **🔒 Least-Privilege Integration** - A scoped Authentik service account with only the permissions the app calls, never a superuser token
- **🔐 SSO Integration** - Single sign-on via Authentik OAuth2/OIDC, with server-signed session cookies
- **📋 Feature Flags Inert by Default** - Every capability flag ships off and is true only for the exact string `'true'`
- **🚦 Rate Limiting** - IP-keyed request limiters and a shared, cross-process throttle on Authentik management-API calls

## Getting Help

### Common Issues
- **Base / Auth / TAK Infrastructure** - Ensure the required stacks are deployed first; device management additionally requires TakInfra
- **Route53 Hosted Zone** - Ensure your domain's hosted zone exists before deployment
- **AWS Permissions** - CDK requires broad permissions for CloudFormation operations
- **Deployment config file** - The S3 config object must exist before the first deploy (an empty file is valid; SMTP is required for real use)
- **Trusted proxy hops** - Behind the ALB, set `TRUSTED_PROXY_HOPS=1` (see the [Configuration Guide](docs/PARAMETERS.md)); the default `0` is correct only for local/dev

### Support Resources
- **AWS CDK Documentation** - https://docs.aws.amazon.com/cdk/
- **Authentik Documentation** - https://goauthentik.io/docs/
- **TAK.NZ Project** - https://github.com/TAK-NZ/
- **Issue Tracking** - Use GitHub Issues for bug reports and feature requests

## License

TAK.NZ is distributed under [AGPL-3.0-only](LICENSE)
Copyright (C) 2026 - Christian Elsen, Team Awareness Kit New Zealand (TAK.NZ)
