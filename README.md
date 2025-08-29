# TAK Team Manager

A standalone web application for managing TAK (Team Awareness Kit) teams, users, and channels with Authentik integration.

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

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Authentik instance

### Backend Setup

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

## License

MIT