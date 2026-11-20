# Tracker walk-forward research

`POST /trading/tracker/walk-forward` queues a read-only Tracker study and returns
a `job_id`. Poll `GET /trading/tracker/walk-forward/{job_id}` for status and
results. It is authenticated and does not start or modify the production
worker. Binance history is public, so no new app or exchange user is needed;
the route uses the existing web login. `mode` defaults to `fixed_holdout` and
can be set to `adaptive` to evaluate an online window selector.

Example adaptive request (send it to the DEV API with the usual web session
cookie):

```json
{
  "symbol": "BTCUSDT",
  "days": 7,
  "mode": "adaptive",
  "window_bars": [120, 240, 360, 480],
  "recalibration_bars": [15],
  "meta_lookback_segments": 4,
  "initial_balance": 100,
  "risk_percent": 1,
  "leverage": 20,
  "calibration_grid": "coarse"
}
```

The response contains `job_id` and `poll_url`; poll the returned path until
`status` becomes `COMPLETE`. The DEV API base is
`https://api.dev.helloworld.goodmorning.mx`.

The default candidates are W = 120, 240, 360, and 480 closed candles (2, 4, 6,
and 8 hours). Binance Futures public klines supply at most seven days. In
`fixed_holdout`, the tuning portion selects a W/recalibration cadence pair; the
final 30% is then untouched by that selection. In `adaptive`, each W runs as a
shadow over the most recently completed segment, and the best trailing score
selects W for the *next* segment. The first segment uses the largest candidate
as a neutral warm-up. The default adaptive cadence is 15 candles (15 minutes);
`meta_lookback_segments` controls how many prior segment scores are summed.
Tracker N, TP, limited SL, and other calibrated values are recomputed from the
chosen trailing candle window at each cadence. An open operation keeps its
entry-time parameter snapshot until it closes. Results include fold timestamps,
selected W/N/TP/SL, operations, drawdown, Limited count, and candle-data SHA-256.
Cadence ticks align to absolute candle timestamps, avoiding phase drift.

The default `calibration_grid: "coarse"` searches N = 4, 8, 12, 16, 20 and TP
in 1% steps. `"full"` uses the production calibrator grid (N = 4..20, TP in
0.5% steps), and costs substantially more CPU. Both modes use only closed
candles and include the current 0.14% notional fee estimate. `fixed_holdout`
accepts several cadence candidates; `adaptive` uses the shortest requested
cadence and reports the online selection history.

This research metric follows the current Scanner convention: a Limited result
keeps its WIN/FAIL classification, while its displayed PnL is capped from the
historical adverse excursion. The exact equality boundary counts as Limited.
Sizing balance follows the raw close-based simulation, matching the current
Scanner implementation. Fees are estimated from notional; slippage, funding,
spread, and actual market fills are not modeled, so these results are not an
exchange fill simulation.

## Experimental status

The study is research-only. Record the selected W/R, calibration grid, candle
range, and holdout metrics for each run. Do not transfer a selected setting to
the live worker solely because its tuning-period result is positive. The exact
data is fetched from Binance at request time, so reruns can differ as the
seven-day period rolls.
