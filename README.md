# TAK Team Manager

Manage TAK teams, users, and channels via Authentik

## Features

- **Authentik OAuth2 Integration** - SSO login for existing users
- **Team Management** - Create/manage teams with hierarchical sub-teams
- **User Management** - Create users in Authentik, assign to teams
- **Channel Management** - Create/manage TAK channels (map to LDAP groups)
- **Access Requests** - Unauthenticated interface for team join requests
- **Approval System** - Team admins approve/deny user requests
- **Mobile Responsive** - Works on mobile devices

## Tech Stack

- **Backend**: Node.js, Express.js, PostgreSQL
- **Frontend**: React, Tailwind CSS, Vite
- **Authentication**: Authentik OAuth2
- **Integration**: Authentik REST API v3

## Development Setup

### Option 1: Docker (Recommended)

1. Copy environment file:
```bash
cp .env.example .env
```

2. Configure `.env` with your Authentik details

3. Start with Docker:
```bash
docker compose up --build
```

4. Initialize database (first time only):
```bash
docker compose exec app node database/init.js
```

5. Access application at http://localhost:3000
6. New users can request access at http://localhost:3000/request-access

### Option 2: Local Development

#### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Authentik instance

#### Backend Setup

1. Install dependencies:
```bash
npm install
```

2. Copy environment file:
```bash
cp .env.example .env
```

3. Configure environment variables in `.env`:
- Database connection details
- Authentik URL and credentials
- JWT secret

4. Initialize database:
```bash
node database/init.js
```

5. Start server:
```bash
npm run server:dev
```

### Frontend Setup

1. Navigate to client directory:
```bash
cd client
```

2. Install dependencies:
```bash
npm install
```

3. Start development server:
```bash
npm run dev
```

### Full Development

Run both backend and frontend:
```bash
npm run dev
```

## API Endpoints

- `GET /api/auth/login` - OAuth2 login redirect
- `GET /api/auth/callback` - OAuth2 callback
- `GET /api/teams/my-teams` - Get user's teams
- `POST /api/teams` - Create team
- `POST /api/users` - Create user in Authentik
- `POST /api/channels` - Create channel with LDAP groups
- `POST /api/requests/team-access` - Submit access request (public)
- `GET /api/requests/pending` - Get pending requests (admin)

## Deployment

The application is designed to run on AWS ECS Fargate with:
- Application Load Balancer
- RDS PostgreSQL
- Secrets Manager for credentials

Production hostname: **`team.tak.nz`**. The app is a single-origin SPA + API (one `FRONTEND_URL`/`APP_URL`, one OAuth2 `redirect_uri`, one session cookie), so it is served from exactly one hostname rather than split across several — Team Management, the Downloads page and the device Enrollment flow are all routes within the same bundle, not separate services. This follows the naming pattern of TAK-NZ's other `*.tak.nz` subdomains (`account`, `map`, `docs`) and replaces the standalone enrollment Lambda previously reachable at `devices.tak.nz`. CDK-based deployment of this hostname is a follow-up and not yet implemented.

### When the CDK stack for the ALB is built: set `TRUSTED_PROXY_HOPS=1`

The app trusts zero reverse-proxy hops by default (`TRUSTED_PROXY_HOPS=0`, see `.env.example`), which is correct for local/dev/test where nothing sits in front of it. Once this is actually deployed behind the ALB, set `TRUSTED_PROXY_HOPS=1` in that environment's config — otherwise `req.ip` resolves to the ALB's own address for every request, collapsing every `req.ip`-keyed rate limiter (`server/middleware/rateLimiters.js`'s `authFlowLimiter`, `requestAccessLimiter`, etc.) onto one shared bucket regardless of how many distinct real clients there are, and `helmet`'s HSTS/HTTPS detection misreads every request as plain HTTP. See `server/config/trustProxy.js`'s header comment and BUGS.md NOTE-001 for the full mechanism.

This must be paired with an ECS security group rule restricting inbound traffic on the container port to the ALB's security group only (never `0.0.0.0/0` or a broad VPC CIDR) — the hop count alone doesn't stop a request that reaches the task directly from forging its own `X-Forwarded-For`. If a CDN (e.g. CloudFront) is ever added in front of the ALB, this becomes `2`, not `1`.

## License

GNU Affero General Public License v3.0