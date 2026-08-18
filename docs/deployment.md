# Coolify Deployment Contract

This repository is deployed by GoodMorning Factory as three independent Coolify resources. Do not use `compose.yaml` as the remote deployment source; it is local and CI only.

## Frontend Application

- Source: private repository through the Coolify GitHub App.
- Branch: `dev`.
- Base directory: `/frontend`.
- Dockerfile location: `/Dockerfile` relative to the base directory.
- Build pack: Dockerfile.
- Internal port: `80`.
- Domain: `https://dev.<product>.goodmorning.mx` without a public `:80` suffix.
- Build variable: `VITE_API_URL`.
- Expected dev value: `https://api.dev.<product>.goodmorning.mx`.

`VITE_API_URL` is embedded by Vite during `npm run build`. Changing it requires rebuilding the frontend image. DATABASE_URL must never be added to the frontend runtime or frontend build environment.

## Backend Application

- Source: private repository through the Coolify GitHub App.
- Branch: `dev`.
- Base directory: `/backend`.
- Dockerfile location: `/Dockerfile` relative to the base directory.
- Build pack: Dockerfile.
- Internal port: `8000`.
- Domain: `https://api.dev.<product>.goodmorning.mx` without a public `:8000` suffix.
- Runtime variables:
  - `APP_NAME`.
  - `APP_ENV=dev`.
  - `CORS_ORIGINS=https://dev.<product>.goodmorning.mx`.
  - `DATABASE_URL` as a secret runtime variable.

The backend uses SQLAlchemy with psycopg 3. Therefore `DATABASE_URL` must use the `postgresql+psycopg://` scheme when the backend starts.

Coolify may provide an internal native PostgreSQL URL with the initial scheme `postgresql://`. `goodmorning-factory` is responsible for converting only that initial scheme to `postgresql+psycopg://`. The conversion must not alter the username, password, hostname, port, database, query string, or URL-encoded characters. This template intentionally contains no Coolify integration function and must not know Coolify UUIDs, internal hostnames, or credentials.

## Native PostgreSQL resource

- Resource type: native Coolify PostgreSQL.
- Version: PostgreSQL 16.
- Network exposure: private only.
- Public domain: none.
- Public port: none.
- Credentials: managed by Factory/Coolify outside Git.
- Connectivity: backend reaches PostgreSQL through Coolify's internal network.

## Migration and startup flow

1. The backend receives `DATABASE_URL` from its runtime environment.
2. `/app/entrypoint.sh` runs `alembic upgrade head`.
3. If migrations fail, the shell exits immediately and Uvicorn does not start.
4. After migrations succeed, `exec uvicorn app.main:app --host 0.0.0.0 --port 8000` starts the API process.

Alembic configuration keeps only non-secret migration settings in `backend/alembic.ini`. The dynamic database URL is loaded from backend settings and is not written to `alembic.ini`, printed, or passed through ConfigParser interpolation.

## Local Compose only

`compose.yaml` is documented and configured exclusively for local development and CI:

- Services are exactly `frontend`, `backend`, and `postgres`.
- Frontend builds `./frontend`, receives build arg `VITE_API_URL`, maps local `8080:80`, waits for the backend healthcheck, and checks Nginx on port `80`.
- Backend builds `./backend`, maps local `8000:8000`, receives `DATABASE_URL` pointing to `postgres:5432`, waits for PostgreSQL health, and checks `/health` on `127.0.0.1:8000`.
- PostgreSQL uses `postgres:16-alpine`, a persistent `postgres_data` volume, `pg_isready` with the configured user/database, and no host `ports:` mapping.

Do not add Traefik labels, `docker_compose_domains`, Coolify domains, server paths, remote shell/file-copy tooling, or remote deployment settings to `compose.yaml`.

## Environment variable separation

Do not copy every variable from `.env.example` into both Coolify applications. Use only the variables required by each resource:

- Frontend build-time: `VITE_API_URL`.
- Backend runtime: `APP_NAME`, `APP_ENV`, `CORS_ORIGINS`, `DATABASE_URL`.
- Local Compose only: `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, plus local placeholder defaults.

No real secrets, credentials, tokens, production identifiers, Coolify UUIDs, or generated hostnames belong in Git.
