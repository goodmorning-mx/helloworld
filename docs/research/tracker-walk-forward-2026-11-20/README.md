# Tracker adaptive walk-forward research — 2026-11-20

## Scope correction

These six symbol tests used a manually specified list. They did **not** use the
universe returned by the live Scanner, so their combined result must not be
reported as the Scanner's performance or as four Scanner-selected losses.

The live Scanner currently filters Binance USDT perpetuals by at least 50M USDT
24-hour quote volume, 100,000 trades, and 0.5% absolute 24-hour movement. It
keeps up to 20 ranked candidates, then orders those candidates by summed
absolute close-to-close variation over the latest ten 5-minute candles. The
web client refreshes this universe every 60 seconds. Persistence retains only
the latest scanner snapshot, so historical symbol membership for the tested
period is unavailable. A valid Scanner-specific forward test must record the
actual Scanner universe at each scan time and evaluate those symbols forward;
it cannot be reconstructed from this fixed sample after the fact.

## Result

On this fixed manual sample, the adaptive method did not sustain profitability.
The symbol-level figures below describe only these individually selected pairs;
they say nothing about which symbols the Scanner actually returned.

| Symbol | Adaptive holdout | Mark-to-market | Trades | Max drawdown (USDT) | Fixed 70/30 holdout, where run |
| --- | ---: | ---: | ---: | ---: | ---: |
| BTCUSDT | +2.14% | +1.75% | 45 | 15.03 | +9.33%, W=360 |
| ETHUSDT | −13.14% | −13.78% | 60 | 23.10 | −32.43%, W=480 |
| SOLUSDT | −31.93% | −26.85% | 67 | 32.05 | −36.47%, W=480 |
| BNBUSDT | −22.56% | −22.77% | 57 | 37.12 | not run |
| XRPUSDT | −27.39% | −25.85% | 61 | 27.39 | not run |
| DOGEUSDT | +17.67% | +17.62% | 76 | 41.25 | not run |

The BTC adaptive holdout is positive, but the cross-asset result is strongly
negative. DOGE also had a 41.25 USDT maximum drawdown against a 100 USDT start.
The result therefore fails the sustained-positive criterion. The full BTC
period also lost 9.61% under the adaptive schedule.

The full BTC walk-forward chose W=360 and recalibration every 15 minutes from
the 70% training section after comparing all 12 W/cadence pairs (W 120/240/360/480
and cadence 15/30/60 minutes). The frozen final 30% returned +9.33% closed
(+8.54% including its open position). This is one positive holdout, but the
same predeclared adaptive selector does not generalize across the other assets
in this sample. The full-period fixed-W comparison also includes a post-hoc
W=360 return of +42.66%; that uses the whole sample for W and is descriptive
only, not an out-of-sample claim.

## Protocol

- Data: Binance USDⓈ-M Futures public 1-minute klines, 10,079 closed candles
  per symbol, requested over the prior seven days. Each artifact contains the
  normalized candles and the SHA-256 digest, so a run can be recreated exactly.
- Start balance: 100 USDT; sizing risk: 1%; leverage: 20x; fee/slippage estimate:
  0.14% of notional per completed operation, matching the current Scanner
  convention.
- Candidate context windows W: 120, 240, 360, and 480 candles (2, 4, 6, 8
  hours). N candidates: 4, 8, 12, 16, 20. Coarse TP grid starts at 0.5% and
  advances in 1% increments through 19.5%. Limited SL comes from MINROE history with the product's 0.20%
  price-stop floor. Parameters are recalibrated every 15 closed candles.
- Fixed comparison: select W on the first 70% only, freeze it, then evaluate on
  the last 30%. For BTC, ETH, and SOL, selection chose W=360, 480, and 480.
- Adaptive comparison: warm up on the first 70%, then let each W shadow the
  most recently completed 15-candle segment. Select W for the next segment from
  the sum of its previous four shadow-segment mark-to-market returns. N/TP/SL
  are calibrated from candles strictly before each effective time. Open trades
  retain their entry-time parameters; they are never rewritten.
- Reports include closed PnL, estimated open PnL, fees, Limited adjustments,
  operation/fold details, and parameter versions. Candle close time is the
  decision boundary; the still-open Binance candle is excluded.

This is a historical test, not a fill simulator. It does not model funding,
liquidation, order-book spread, exchange rejects, or exact partial fills. The
adaptive shadow portfolios are reset at each 15-candle scoring segment; their
scores select the next W, while the primary adaptive portfolio itself remains
continuous. Treat this as research evidence, not a production recommendation.

## Reproducibility

The compressed JSON files hold the exact normalized candle snapshots plus each
run's folds, operation list, parameter selections, statistics, and data hash.
For example:

```sh
gzip -dc btcusdt.json.gz > btcusdt.json
```

Baseline before implementation: tag
`baseline/walk-forward-2026-11-20` at commit `336b7310c57f61ce0626c557e0a959d33b1f1880`.
The feature is isolated to authenticated, asynchronous, read-only research API
jobs and does not start or modify the production worker.

## Checks

- Backend: `PYTHONPATH=. python -m pytest -q` — 120 passed.
- Frontend: `npm run typecheck && npm run build` — passed.
- GitHub PR #96 checks: backend, frontend, Docker build, CodeQL, and language
  analyses passed.
