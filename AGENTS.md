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

- `dev` is clean at merge commit `7892c20`.
- PR #16 (`perf: reuse tracker signals during tp search`) is merged.
- PR #16 passed backend, frontend, and Docker checks; its post-merge `dev` CI also passed.
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

### Outstanding scanner resilience work

The next scanner goal is persistent incremental analysis for unstable internet:

1. Do not clear `scannerAnalysisBySymbol` when a cycle restarts.
2. Preserve the last valid result per symbol and update it with append/update.
3. On a network failure, keep the previous result and mark it stale/retryable instead of restarting all symbols.
4. Retry only failed symbols or symbols with new candle data.
5. Reuse cached candles and request only new candles where possible.
6. Deduplicate in-flight requests for the same symbol/configuration.
7. Distinguish `ANALIZANDO`, valid, `STALE`, and recoverable error states in the UI.
8. Add tests for cache, retry, preservation, and incremental updates.

Do not mark this resilience work complete until the timing improvement and incremental behavior are tested, merged, deployed to DEV, and verified by CI.

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
