# GoodMorning MVP Template

A minimal, production-oriented full-stack template for new products created by the GoodMorning Software Factory.

## Stack
- React, TypeScript, and Vite frontend.
- FastAPI backend on Python 3.12.
- PostgreSQL database.
- Alembic migration infrastructure for the backend.
- Docker Compose for local integrated development only.
- Coolify deployment as three independent remote resources.
- GitHub Actions for quality checks.

## Repository structure
```text
AGENTS.md                 Agent workflow and safety rules
CLAUDE.md                 Claude-specific responsibilities
compose.yaml              Local-only frontend, backend, and PostgreSQL stack
frontend/                 React/Vite application served by Nginx on container port 80
backend/                  FastAPI application, Alembic infrastructure, and tests
docs/                     Architecture, development, deployment, and rollback docs
.github/workflows/ci.yml  CI verification
```

## Local setup with Docker Compose
`compose.yaml` is exclusively for local development. It is not the source of the remote Coolify deployment.

1. Copy the environment template:
   ```bash
   cp .env.example .env
   ```
2. Start the local stack:
   ```bash
   docker compose up --build
   ```
3. Open the frontend at <http://localhost:8080> and the API health endpoint at <http://localhost:8000/health>.

Local Compose services are exactly:
- `frontend`: builds `./frontend`, maps host `8080` to container `80` for local development.
- `backend`: builds `./backend`, maps host `8000` to container `8000` for local development.
- `postgres`: PostgreSQL with a persistent `postgres_data` volume and no host port by default.

The backend connects to PostgreSQL at `postgres:5432` inside the Compose network.

## Coolify deployment standard
Remote Coolify deployments must be configured as three independent resources, not as a Compose deployment:

1. Frontend Application from branch `dev`, base directory `/frontend`, Dockerfile location `/Dockerfile`, build pack `dockerfile`, internal port `80`, domain `https://dev.<product>.goodmorning.mx`, and build variable `VITE_API_URL=https://api.dev.<product>.goodmorning.mx`. `VITE_API_URL` is embedded during `npm run build`, so changes require a frontend rebuild.
2. Backend Application from branch `dev`, base directory `/backend`, Dockerfile location `/Dockerfile`, build pack `dockerfile`, internal port `8000`, domain `https://api.dev.<product>.goodmorning.mx`, and runtime variables `APP_NAME`, `APP_ENV=dev`, `CORS_ORIGINS=https://dev.<product>.goodmorning.mx`, and secret `DATABASE_URL`.
3. Native private Coolify PostgreSQL 16 resource with no public domain, no public port, credentials managed by Factory/Coolify, and connectivity through the internal Coolify network.

The backend uses SQLAlchemy with psycopg 3, so runtime `DATABASE_URL` must use `postgresql+psycopg://`. If Coolify provides an internal URL beginning with `postgresql://`, `goodmorning-factory` converts only that initial scheme and preserves the user, password, hostname, port, database, query string, and URL-encoded characters exactly. The template must not contain Coolify UUIDs, internal hostnames, credentials, or a Factory integration function. `DATABASE_URL` is a backend runtime secret and must never be incorporated into the frontend or frontend build.

Public URLs must never include `:80` or `:8000`; Coolify routing should terminate HTTPS and route to the internal container ports.

## Environment configuration
All variables are documented in `.env.example`. Keep real secrets out of Git. The local placeholders are intentionally safe for development only.

## Testing
Frontend:
```bash
cd frontend
npm ci
npm run typecheck
npm run build
```

Backend:
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m pytest
alembic history --verbose
```

Docker validation:
```bash
docker compose config
docker compose build
docker compose up --build --wait
curl --fail http://127.0.0.1:8000/health
curl --fail http://127.0.0.1:8080/
docker compose down --volumes
```

## Branch behavior
- `main` is production and must remain deployable.
- `dev` is the integrated development branch.
- Create feature branches from `dev`.
- Open normal pull requests toward `dev`.
- Open release pull requests from `dev` to `main`.
- Do not push directly to `main`.

## Creating a new product from this template
After copying the template, replace template metadata and names in:
- `README.md`
- `frontend/package.json`
- `frontend/index.html`
- `.env.example`
- `compose.yaml`
- `backend/app/config.py`
- Documentation under `docs/`

Keep the environment contract synchronized across code, Compose, Dockerfiles, CI, and deployment configuration.
