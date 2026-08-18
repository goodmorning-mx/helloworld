# Development

## Prerequisites
- Docker and Docker Compose for integrated development.
- Node.js 22 for local frontend checks.
- Python 3.12 for local backend checks.

## Start the integrated stack
```bash
cp .env.example .env
docker compose up --build
```

Frontend: <http://localhost:8080>
Backend health: <http://localhost:8000/health>

## Local checks
```bash
cd frontend && npm install && npm run typecheck && npm run build
cd backend && pip install -r requirements.txt && python -m pytest
docker compose config
```
