# Architecture

The template contains three services:

- `frontend`: a React/Vite single-page app that calls the backend health endpoint.
- `backend`: a FastAPI API exposing `GET /health` and preparing PostgreSQL connectivity.
- `db`: PostgreSQL for product data when a product adds its own schema.

The backend currently does not create product-specific tables. Database connectivity is isolated in `backend/app/database.py` so future products can add migrations deliberately.

Runtime configuration is supplied through environment variables documented in `.env.example`.

## Binance market scanner

The frontend requests the active market universe, then analyzes its symbols one at a time and updates each card as its result arrives. Tracker optimization is CPU-heavy Python work, so running several symbols at once contends for the GIL and increases each symbol's wall time. The active-universe endpoint requests only `horizon + 1` candles per symbol and loads symbols with bounded concurrency. The backend keeps a short-lived, process-local universe snapshot and a bounded candle cache keyed by symbol and interval. Scanner candles and analyses expire after 48 hours without a successful refresh; expiration removes the associated analysis entries, and an expired symbol reloads a fresh history window. On a cold symbol it loads the requested history; later refreshes re-fetch the last cached candle and request only the next candles. The backend skips Binance requests while it already has the latest expected closed 1m candle. Only closed 1m candles enter Tracker analysis.

Analysis results are cached per symbol, strategy configuration, and latest closed candle time. Identical in-flight candle refreshes and analysis calculations are shared. A failed refresh keeps the last good result and reports `STALE`; a symbol without a usable result reports a recoverable `ERROR`. The frontend merges responses by symbol and keeps the previous metrics visible across refresh failures.

These scanner caches hold derived public market data in memory, are bounded, and rebuild after a backend restart. The browser keeps rolling two-day OHLC caches for live charts and precached markets, refreshing a market when its latest cached candle is more than two intervals behind. The Lab's 30-day history has a separate 31-day cache so the live-chart retention policy does not truncate its input. Separate backend replicas have separate scanner caches; shared cache infrastructure should be considered only if the deployment scales horizontally and measurements show the duplicated work matters.
