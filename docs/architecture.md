# Architecture

The template contains three services:

- `frontend`: a React/Vite single-page app that calls the backend health endpoint.
- `backend`: a FastAPI API exposing `GET /health` and preparing PostgreSQL connectivity.
- `db`: PostgreSQL for product data when a product adds its own schema.

The backend currently does not create product-specific tables. Database connectivity is isolated in `backend/app/database.py` so future products can add migrations deliberately.

Runtime configuration is supplied through environment variables documented in `.env.example`.
