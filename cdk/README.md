# TAK Team Manager — CDK deployment

AWS CDK app that deploys TAK Team Manager onto ECS Fargate, following the same
conventions as the other TAK-NZ stacks (`base-infra`, `auth-infra`,
`tak-infra`, `CloudTAK`). It provisions the application tier and imports its
shared infrastructure from the layers below it via CloudFormation exports.

## What it deploys

- **ECS Fargate service** running the app container (Express API + built SPA on
  one origin, port 3000), behind a **dual-stack Application Load Balancer**
  (HTTPS + HTTP→HTTPS redirect, health check `GET /health`).
- **Aurora PostgreSQL** cluster (`tak_team_manager` DB) — Serverless v2 in
  dev-test, provisioned instances in prod.
- **Route53** `A`/`AAAA` alias at `team.<zone>`.
- **Secrets** it generates itself (JWT signing secret; the base64 32-byte
  credential-encryption key, written by a small custom-resource Lambda).
- An **Authentik OIDC provider + "Team Manager" application** (slug
  `team-manager`, placed in the *Team Awareness Kit* group, with the app icon),
  created at deploy time by a custom-resource Lambda — mirroring CloudTAK's
  `CloudTakOidcSetup`. Its client id/secret are wired into the container.

## Cross-stack imports (`TAK-<Env>-<Layer>-<Key>`)

Dependency stack names are derived from the single shared `stackName` (e.g.
`Dev`/`Prod`) — deploy this with the same env label as the layers below.

- **base-infra**: VPC + subnets, ECS cluster, KMS key, hosted zone, ACM
  certificate, ELB-logs bucket, env-config bucket (the Part-2 config file), and
  the map-downloads bucket (when offline maps are enabled).
- **auth-infra**: `AuthentikUrl`, `AuthentikTeamManagerTokenArn` (the app's
  least-privilege API token), `AuthentikAdminTokenArn` (used by the OIDC-setup
  Lambda, and by device enrollment when device management is on).
- **tak-infra** *(only when `app.deviceManagementEnabled`)*: `TakServerUrl`
  (:8443), `TakCertEnrollment` (:8446), `TakAdminCertSecretArn`.

> **Note:** both `deviceManagementEnabled` and `offlineMapsEnabled` now default
> to `true` in `cdk.json` for BOTH the `dev-test` and `prod` profiles. So the
> tak-infra exports above and base-infra's map-downloads bucket are effectively
> REQUIRED for a normal deploy — the target account must have tak-infra deployed
> and those exports present, or the deploy fails with a "No export named ..."
> error. Set the flag to `false` (in `cdk.json` or via `--context
> deviceManagementEnabled=false` / `--context offlineMapsEnabled=false`) to
> deploy without those dependencies.

## Container configuration (two layers)

Matching this app's `.env.example` deployment model:

- **Part 1 — CDK-managed** task-definition `environment`/`secrets`: everything
  imported from another stack or managed by this stack (DB connection, JWT +
  credential-encryption secrets, Authentik URL/token/OIDC client, app URLs,
  optional TAK Server + offline-maps values).
- **Part 2 — S3 `EnvironmentFile`**: `tak-team-manager-config.env` in the shared
  base-infra env-config bucket, loaded into the same task. This holds the
  ops-editable config (reCAPTCHA, SMTP, feature flags, colour/role labels,
  tuning, branding, etc.). Edit by replacing the S3 object and restarting the
  task — no CDK redeploy. **You must create this object before first deploy**
  (an empty file is valid; every entry is optional except SMTP for real use).

## Container image

By default the image is built locally from the repo-root `Dockerfile` via a CDK
`DockerImageAsset`. In CI, pass `--context usePreBuiltImages=true` (optionally
`--context imageTag=<tag>`) to instead pull from the base-infra artifacts ECR
repo.

## Usage

```bash
npm install
# also install the OIDC-setup Lambda's runtime deps (axios, form-data):
(cd src/oidc-setup && npm install)

npm run build
npm run synth:dev        # cdk synth --context envType=dev-test
npm run synth:prod
npm run deploy:dev       # cdk deploy --context envType=dev-test
npm run deploy:prod
```

Account/region come from `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`
(falling back to the `tak-defaults` region, `ap-southeast-2`). Any single
context value can be overridden on the CLI, e.g.
`--context taskCpu=1024 --context desiredCount=3`.

## Configuration (`cdk.json` context)

Per-environment blocks (`dev-test`, `prod`) hold `stackName`, `r53ZoneName`,
`hostname`, `database`, `ecs`, `app` (`deviceManagementEnabled`,
`offlineMapsEnabled`), and `general`. See `lib/stack-config.ts` for the full
interface.

## Notes

- The OIDC-setup and secret-generator Lambdas are bundled by `NodejsFunction`
  (esbuild). `src/oidc-setup/` needs its `node_modules` present (run its
  `npm install`) so `axios`/`form-data` bundle — the same way CloudTAK ships
  its OIDC-setup Lambda's dependencies.
- Imported-VPC route-table warnings during synth are expected (the VPC is
  imported via `fromVpcAttributes`, same as every other TAK-NZ app stack).
