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

These scanner caches hold derived public market data in memory, are bounded, and rebuild after a backend restart. The browser keeps rolling two-day OHLC caches per symbol and interval. Live IndexedDB data uses one row per candle, so an update appends a new row or replaces only the still-open candle; startup catch-up requests begin after the latest cached candle once the last expected candle is missing, then page through any gap. An upgrade migrates the previous live per-series records. Live buffers drop candles outside the 48-hour window, and IndexedDB is swept hourly so unused rows are physically removed after they age out. The chart appends/updates only the current Heikin-Ashi point. RSI, SSL, Tracker, wick, and daily-window series retain prior output and recompute the current point, including when the rolling window advances; SVG paths and markers render only for the visible chart range. The Lab's 30-day history keeps its separate 31-day array cache so its less frequent bulk loads avoid per-candle storage overhead and the live-chart retention policy does not truncate its input. Separate backend replicas have separate scanner caches; shared cache infrastructure should be considered only if the deployment scales horizontally and measurements show the duplicated work matters.
