# Docker Image Strategy

This document explains the hybrid Docker image strategy used by the TAKTeamManager CDK stack, which supports both pre-built images from ECR and local Docker building for maximum flexibility.

## Overview

The stack uses a **fallback strategy** that:
1. **First tries to use a pre-built image** from ECR (fast CI/CD deployments)
2. **Falls back to building the image locally** from the repo-root `Dockerfile` via a CDK `DockerImageAsset`

This provides the best of both worlds:
- **Fast CI/CD deployments** using pre-built images
- **Flexible local development** with on-demand building

## One Image, Two Processes

TAK Team Manager ships as a **single** Docker image, so there is only one image to build and tag. The image is a two-stage build:

1. **Builder stage** - installs root + client dependencies and runs `vite build`.
2. **Runtime stage** - installs production-only root dependencies, copies `server/`, `database/`, and the built `client/dist`, runs as the non-root `node` user, and defines a `HEALTHCHECK` against `GET /health`.

The image's default `CMD` starts the **web process** (`node server/index.js`). The **sync worker** is the *same image* with its command overridden to `node server/workers/syncWorker.js` - there is no separate Dockerfile or image for it. The CDK stack runs the two as separate ECS tasks from the one image.

## Configuration

### Context Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `usePreBuiltImages` | Use a pre-built ECR image instead of building locally | `true` or `false` |
| `imageTag` | Tag of the pre-built image to pull | `abc123` |

When `usePreBuiltImages` is false or unset, the tag is ignored and the image is built locally. When true, the stack pulls `<ECR_ARTIFACTS_REPO>:<imageTag>` from the BaseInfra artifacts repository; an unset `imageTag` resolves to `latest`.

### Default Behavior

- **Local development / `npm run deploy:*`**: builds the image on-demand (default)
- **CI/CD**: passes `--context usePreBuiltImages=true --context imageTag=<sha>` after a separate build-and-push step
- **Manual override**: either mode can be forced via context parameters

## Usage Examples

### GitHub Actions (Pre-built Image)
```bash
npm run deploy:prod -- \
  --context usePreBuiltImages=true \
  --context imageTag=abc123
```

### Local Development (Build on Demand)
```bash
# NPM scripts build locally by default
npm run deploy:dev     # Dev environment, build locally
npm run deploy:prod    # Prod environment, build locally

# Or explicitly disable pre-built images
npm run deploy:dev -- --context usePreBuiltImages=false
```

## Image Repository

The pre-built image is stored in the ECR **artifacts** repository provisioned by BaseInfra and imported via CloudFormation exports - the stack does not create its own repository. The CI build step pushes `<ECR_ARTIFACTS_REPO>:<git-sha>` and the deploy step references that tag.

## Local, All-in-One Docker

For pure local development without AWS, `docker-compose.yml` runs three services from the same image family: `postgres`, `app` (concurrent server + client dev servers), and `sync-worker`. Start it with `npm run docker:up`; this is unrelated to the CDK image strategy above and is meant only for local work.

## Quick Links

- **[Main README](../README.md)** - Complete project overview
- **[Deployment Guide](DEPLOYMENT_GUIDE.md)** - Detailed deployment instructions
- **[AWS & GitHub Setup](AWS_GITHUB_SETUP.md)** - CI/CD configuration
- **[Configuration Guide](PARAMETERS.md)** - Complete configuration reference
