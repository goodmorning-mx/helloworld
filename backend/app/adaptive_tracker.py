"""Rolling-window Tracker parameter selection for realtime workers.

Calibration only uses closed candles already observed. A resulting snapshot is
effective after it is produced and is versioned by the last candle in its
window; it never rewrites the Tracker's signal history.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.scanner_analysis import ScannerAnalysisConfig, analyze_tracker


WINDOW_BARS = 480  # Eight hours of closed one-minute candles.
MIN_CALIBRATION_BARS = 120
TRACKER_PERIOD_CANDIDATES = range(4, 21)


def minroe_to_price_stop_percent(minroe_limit_percent: float, leverage: float) -> float:
    """Convert a leveraged ROE threshold into an underlying price percentage."""
    value = abs(float(minroe_limit_percent)) / max(1.0, float(leverage))
    return max(0.05, min(value or 0.2, 20.0))


def calibrate_tracker_parameters(
    bars: list[dict[str, Any]],
    *,
    risk_percent: float = 1.0,
    leverage: float = 1.0,
    initial_balance: float = 100.0,
    current_tracker_period: int = 5,
) -> dict[str, Any]:
    """Select N/TP and derive the historical MINROE stop from the same window.

    The scanner simulator is reused so ranking and execution use one strategy
    contract. The coarser 0.5% TP grid keeps recalibration bounded; it runs in a
    worker thread so market callbacks stay nonblocking.
    """
    closed = [
        {key: item[key] for key in ("time", "open", "high", "low", "close")}
        for item in bars
        if item.get("closed", True)
    ][-WINDOW_BARS:]
    latest = int(closed[-1]["time"]) if closed else None
    if len(closed) < MIN_CALIBRATION_BARS:
        return {
            "status": "INSUFFICIENT_HISTORY",
            "window_hours": len(closed) / 60,
            "bars": len(closed),
            "last_bar_time": latest,
            "tracker_period": max(4, min(20, int(current_tracker_period))),
            "target_percent": 1.0,
            "stop_percent": 0.2,
            "minroe_limit_percent": 0.2 * max(1.0, float(leverage)),
            "risk_percent": risk_percent,
            "leverage": leverage,
            "initial_balance": initial_balance,
            "risk_usdt": initial_balance * risk_percent / 100,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    ranked: list[tuple[float, int, dict[str, Any]]] = []
    for period in TRACKER_PERIOD_CANDIDATES:
        config = ScannerAnalysisConfig(
            tracker_period=period,
            stop_percent=20.0,
            initial_balance=max(1.0, min(float(initial_balance), 1_000_000.0)),
            risk_percent=max(0.01, min(float(risk_percent), 100.0)),
            leverage=max(1.0, min(float(leverage), 125.0)),
            min_tp_percent=0.5,
            max_tp_percent=20.0,
            tp_step_percent=0.5,
        )
        result = analyze_tracker(closed, config)
        score = float(result.get("equity_final") or 100.0)
        # Stable tie breaking: prefer the currently active N, then the smaller N.
        tie = 1 if period == current_tracker_period else 0
        ranked.append((score, tie, {"period": period, **result}))

    score, _tie, best = max(ranked, key=lambda item: (item[0], item[1], -item[2]["period"]))
    minroe_limit_percent = abs(float(best.get("loss_limit_percent") or 0.0))
    # MINROE is a leveraged return (ROE); execution SL is a price move.
    # Convert explicitly so a 20% ROE limit at 20x means a 1% price stop.
    # A zero or unbounded historical threshold is not a usable protective stop.
    stop_percent = minroe_to_price_stop_percent(minroe_limit_percent, leverage)
    return {
        "status": "ADAPTIVE",
        "window_hours": len(closed) / 60,
        "bars": len(closed),
        "last_bar_time": latest,
        "tracker_period": int(best["period"]),
        "target_percent": max(0.1, min(float(best.get("tp_optimal_percent") or 1.0), 20.0)),
        "stop_percent": stop_percent,
        "minroe_limit_percent": minroe_limit_percent,
        "risk_percent": max(0.01, min(float(risk_percent), 100.0)),
        "leverage": max(1.0, min(float(leverage), 125.0)),
        "initial_balance": max(1.0, min(float(initial_balance), 1_000_000.0)),
        "risk_usdt": round(max(1.0, min(float(initial_balance), 1_000_000.0)) * max(0.01, min(float(risk_percent), 100.0)) / 100, 6),
        "sample_operations": int(best.get("operations") or 0),
        "historical_win_rate": float(best.get("win_rate") or 0.0),
        "historical_result_usdt": round(score - 100.0, 6),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
