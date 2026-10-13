# GoodMorning MVP Template Agent Instructions

## Branching and pull requests
- `main` is production and must remain deployable.
- `dev` is the integrated development branch.
- Create feature branches from `dev`.
- Open normal pull requests toward `dev`.
- Open release pull requests from `dev` to `main`.
- Do not push directly to `main`.

## Verification and reporting
- Run the relevant checks before reporting work as complete.
- Report every command run and its result.
- Call out any check that could not run and explain the environment limitation.
- Confirm that no real secrets, credentials, tokens, or production identifiers were added.

## Safety and approvals
- Do not perform destructive operations without explicit approval.
- Do not run production operations, migrations, deploys, rollbacks, or infrastructure changes without explicit approval.
- Do not fabricate infrastructure details, credentials, application IDs, server names, or deployment status.

## Product context for Luna 6

### Repositories and source of truth

- Current project: `/home/goodmorning/helloworld`.
- Legacy Dash/Plotly project: `/home/goodmorning/src/helloworld`.
- New work belongs in the current project. The legacy project is read-only reference material for behavior migrations.
- Integrated branch: `dev`. Production branch: `main`.
- DEV frontend: `https://dev.helloworld.goodmorning.mx/`.

### Current Git/deployment state

- PR #18 (`feat: cache scanner candles incrementally`) merged to `dev` at `fb5f4a1`.
- PR #18 and its post-merge `dev` CI passed backend, frontend, and Docker checks.
- DEV frontend and API were verified after deployment: both returned HTTP 200, the API reported `environment=dev`, and the frontend bundle contained the scanner `STALE`/`ERROR` states.
- PR #16 (`perf: reuse tracker signals during tp search`) remains the earlier Tracker-signal optimization.
- Treat this as the last recorded snapshot; inspect GitHub and DEV before relying on it for later work.
- Required workflow: branch from `dev` → PR to `dev` → checks → merge → post-merge `dev` CI.
- Never push directly to `dev` or `main`.

### Application context

This is a Binance Futures/cTrader trading dashboard with 1m/5m charts, Tracker levels, SSL, wick extensions, sessions, drawing tools, replay, Paper trading, production workers, backtesting, equity curves, MFE/MAE, and a market scanner.

The UI already includes:

- Wheel-style trackpad zoom and click-drag pan.
- Candle replay with click-to-start, play/pause, previous/next candle, and stop.
- Preview with risk, margin, leverage, SL, TP, notional, fee, and PNL.
- Tracker and wick backtesting with tables, equity curves, operation labels, and filters.
- Scanner cards showing optimal TP, average duration, final USD result, and activity state.

### Canonical Tracker strategy

Primary files:

- `backend/app/tracker_strategy.py`
- `backend/app/production_worker.py`
- `backend/app/scanner_analysis.py`

Rules:

- The current candle is excluded from the Tracker range; only the previous `tracker_period` candles are used.
- H2: close >= max(high) and close >= max(open, close).
- H1: close >= max(open, close) and close < max(high).
- L1: close <= min(open, close) and close > min(low).
- L2: close <= min(low) and close <= min(open, close).
- Classification is exclusive with `if/elif`.
- Only one operation may be open at a time.
- Entries and exits are evaluated at candle close, not as intrabar market fills.
- TP/SL, fees, estimated slippage, leverage, balance, and equity are part of each simulation.
- A winning close can reverse immediately on the same candle; a failed close may retry from the same candle according to the current Tracker logic.
- Do not use legacy `basic.py` or `strategies.py` as the primary implementation.

### Scanner profiling and optimization

Primary files:

- `backend/app/main.py`: `/market/binance/scanner-analysis`.
- `backend/app/scanner_analysis.py`: TP search and simulation.
- `backend/app/profiling.py`: backend profiler.
- `frontend/src/App.tsx`: progressive scanner loop/cards.
- `frontend/src/profiling.ts`: frontend profiler.

Profiling returns `stages` with count/total/last/max timing and chronological `marks` with `stage`, `elapsed_ms`, and details. Checkpoints cover fetch, parse, Tracker signal construction, TP candidates, simulation, limited equity, best TP, aggregation, and activity classification.

The merged optimization in PR #16 precomputes target-independent Tracker signals once and reuses only that signal series for each TP candidate. It does not reuse operations or exits: every TP still simulates its own entries, closes, balance, and equity.

Measured benchmark with 1,500 bars and 200 TP candidates:

- Before: `1474.95 ms`.
- After: `396.85 ms`.
- Reduction: `73.09%`.
- Operations were identical.

### Scanner cache and resilience

The incremental scanner cache was introduced in PR #18 and refined with a closed-candle polling guard; see `docs/architecture.md`:

- The frontend requests the active scanner universe in one batch and retains per-symbol results across refreshes.
- The backend keeps a bounded process-local cache of active-universe snapshots, closed 1m candles (up to 1,500 per symbol), and analyses keyed by symbol, strategy configuration, and latest closed candle.
- Candle history is loaded on a cold symbol; later refreshes request only from the last cached candle. The backend skips Binance requests while the latest expected closed candle is already cached and retries symbols whose refresh failed.
- Identical candle refreshes and analysis calculations share in-flight tasks.
- Network failures preserve metrics and report `STALE`; symbols with no prior result report a recoverable error. The next scanner cycle retries stale symbols.
- Tests cover universe caching, candle merging/eviction, closed-candle filtering, cache hits, incremental fetches, stale preservation, retries, and deduplication.
- DEV deployment and post-merge CI for PR #18 were verified. Preserve the same PR, CI, and DEV verification workflow for scanner follow-ups.

Measured local benchmark on 1,500 synthetic bars: a full Tracker TP analysis took about `1,305 ms`; reading the cached analysis for an unchanged candle took about `0.005 ms`. The cache lookup timing excludes HTTP/network overhead. The existing PR #16 benchmark separately records signal-reuse improvements.

Caches are process-local and rebuild after restart; replicas do not share state. The Tracker analysis still recalculates across its bar window when a new closed candle or strategy configuration arrives.

### Telegram integration

The current project already has an async Telegram service in `backend/app/telegram_service.py`:

- `TelegramSink` is bounded and rate-limited.
- `BackendEventBus` fans out events to Telegram.
- It is initialized and managed by `backend/app/main.py`.
- Current events include scanner state changes, worker start/stop, and Paper/Live entries/exits.

Backend runtime variables needed in Coolify:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_ENABLED=true
TELEGRAM_MIN_DELAY=0.25
```

These variables are not yet documented in `.env.example` and are not explicitly passed by local `compose.yaml`. The legacy implementation is in `src/helloworld/main.py` around `TelegramSink`, queue listening, and startup. It also contains duplicated implementations and a hardcoded token; treat that token as compromised, rotate it, and never copy it into the current project or documentation.

### Binance credentials

- Current credentials belong to each authenticated user.
- They are encrypted and stored in PostgreSQL through `backend/app/binance_credentials.py`.
- The user enters them through the UI: Profile → Binance.
- Do not put personal Binance keys in Git, the frontend, or this file.
- Backend/Coolify must have a persistent `BINANCE_CREDENTIALS_ENCRYPTION_KEY` Fernet key.
- `JWT_SECRET`, `DATABASE_URL`, and the encryption key are runtime secrets.
- Changing the encryption key makes previously stored Binance credentials unreadable.

### Verification commands

```bash
cd backend && pytest
cd frontend && npm run typecheck && npm run build
git diff --check
```

Also run the repository GitHub Actions checks and the post-merge `dev` CI. Report skipped checks and never claim DEV deployment without evidence. Do not add secrets, tokens, credentials, private IDs, or production identifiers to this file.
