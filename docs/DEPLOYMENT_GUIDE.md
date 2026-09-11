# 🚀 TAK Team Manager - Deployment Guide

## **Quick Start (Recommended)**

### **Prerequisites**
- AWS Account with configured credentials
- Base infrastructure stack (`TAK-<name>-BaseInfra`) deployed
- Authentication infrastructure stack (`TAK-<name>-AuthInfra`) deployed
- TAK server infrastructure stack (`TAK-<name>-TakInfra`) deployed *(required when device management is enabled, which is the default)*
- Public Route 53 hosted zone for your domain in the same account
- Node.js 18+ and npm installed

### **One-Command Deployment**

CDK deployment runs from the `cdk/` directory:

```bash
# Install dependencies
cd cdk && npm install

# Also install the OIDC-setup Lambda's runtime deps (axios, form-data)
(cd src/oidc-setup && npm install)

# Deploy development environment
npm run deploy:dev

# Deploy production environment
npm run deploy:prod
```

The `deploy:*` scripts build the TypeScript, resolve the environment's CDK context, and deploy. Account and region come from `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`, falling back to the `tak-defaults` region (`ap-southeast-2`).

---

## **📋 Environment Configurations**

| Environment | Stack Name | Domain | Features |
|-------------|------------|--------|----------|
| **dev-test** | `TAK-Dev-TAKTeamManager` | `team.dev.tak.nz` | Cost-optimized, Serverless v2 database, single task |
| **prod** | `TAK-Prod-TAKTeamManager` | `team.tak.nz` | High availability, provisioned database instances, two tasks |

---

## **⚠️ Before the First Deploy: the S3 Config Object**

The application reads operations-editable settings (SMTP, reCAPTCHA, feature flags, colour/role labels, tuning, branding) from a config file loaded into the ECS task via `ecs.EnvironmentFile.fromBucket`. **This object must exist in the shared BaseInfra env-config bucket before the first deploy** - an empty file is valid, every entry is optional except SMTP for real use.

The CDK expects the object named `tak-team-manager-config.env`. Edit it later by replacing the S3 object and restarting the task - no CDK redeploy required. See the [Configuration Guide](PARAMETERS.md) for the full list of what belongs in this file versus what CDK manages directly.

---

## **🔧 Advanced Configuration**

### **ECS Sizing Overrides**
```bash
# Larger task and more replicas for a busy dev environment
npm run deploy:dev -- --context taskCpu=1024 --context taskMemory=2048 --context desiredCount=3
```

### **Feature Dependency Overrides**
```bash
# Deploy without the TAK Server device-management dependency
npm run deploy:dev -- --context deviceManagementEnabled=false

# Deploy without the offline-maps download bucket dependency
npm run deploy:dev -- --context offlineMapsEnabled=false
```

Both `deviceManagementEnabled` and `offlineMapsEnabled` default to `true` in `cdk.json`, so the tak-infra exports and the base-infra map-downloads bucket are effectively required for a normal deploy. Set the flags to `false` to deploy without those dependencies.

### **Container Image Selection**
```bash
# Use pre-built images from the BaseInfra ECR repo (CI/CD)
npm run deploy:prod -- --context usePreBuiltImages=true --context imageTag=<tag>
```

See the [Docker Image Strategy Guide](DOCKER_IMAGE_STRATEGY.md) for details.

### **Infrastructure Preview**
```bash
# Preview changes before deployment
npm run synth:dev            # Development environment
npm run synth:prod           # Production environment
npm run cdk:diff:dev         # Show what would change in dev
npm run cdk:diff:prod        # Show what would change in prod
```

---

## **Behind the Load Balancer: `TRUSTED_PROXY_HOPS`**

The app trusts zero reverse-proxy hops by default (`TRUSTED_PROXY_HOPS=0`), correct for local/dev/test where nothing sits in front of it. Deployed behind the ALB, set `TRUSTED_PROXY_HOPS=1` - otherwise `req.ip` resolves to the ALB's own address for every request, collapsing every IP-keyed rate limiter onto one shared bucket, and helmet's HSTS/HTTPS detection misreads every request as plain HTTP. Pair it with an ECS security-group rule restricting the container port to the ALB's security group only. If a CDN (e.g. CloudFront) is ever added in front of the ALB, this becomes `2`.

---

## **Local Development**

The application runs entirely without AWS for development, using Docker or a local Node + PostgreSQL setup.

### **Option 1: Docker (Recommended)**
```bash
# From the repository root
cp .env.example .env          # then fill in your Authentik details
npm run docker:up             # postgres + app + sync worker
npm run docker:init-db        # initialize the database (first run only)
```

Access the app at http://localhost:3000; new users can request access at http://localhost:3000/request-access.

### **Option 2: Local Node + PostgreSQL**

**Prerequisites:** Node.js 18+, PostgreSQL 14+, and an Authentik instance.

```bash
# From the repository root
npm install
cp .env.example .env          # configure DB, Authentik, and JWT settings
node database/init.js         # initialize the database
npm run dev                   # run server + client concurrently
```

The client dev server (Vite) proxies `/api` to the backend on port 3000. Client tests run from `client/` with Vitest (`cd client && npm test`); server tests run from the root (`npm test`).

---

## **CI/CD Deployment**

Deployment via GitHub Actions (build once, deploy pre-built images) is covered in the [AWS & GitHub Setup Guide](AWS_GITHUB_SETUP.md).

---

## Quick Links

- **[Main README](../README.md)** - Complete project overview
- **[Quick Reference](QUICK_REFERENCE.md)** - Fast deployment commands and environment comparison
- **[Configuration Guide](PARAMETERS.md)** - Complete configuration reference
- **[Architecture Guide](ARCHITECTURE.md)** - Technical architecture details
- **[AWS & GitHub Setup](AWS_GITHUB_SETUP.md)** - CI/CD configuration
