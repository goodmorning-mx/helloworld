"""Rolling-window Tracker parameter selection for realtime workers.

Calibration only uses closed candles already observed. A resulting snapshot is
effective after it is produced and is versioned by the last candle in its
window; it never rewrites the Tracker's signal history.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable, Literal

from app.scanner_analysis import ScannerAnalysisConfig, analyze_tracker


WINDOW_BARS = 480  # Eight hours of closed one-minute candles.
MIN_CALIBRATION_BARS = 120
TRACKER_PERIOD_CANDIDATES = range(4, 21)


def _equity_selected_loss_limit(
    operations: list[dict[str, Any]], *, initial_balance: float, leverage: float, floor_roe_percent: float,
) -> tuple[float, float]:
    """Choose an in-sample MINROE threshold by equity; WF keeps it honest."""
    floor = max(0.0, float(floor_roe_percent))
    candidates = sorted({floor, *(max(floor, abs(float(item.get("min_roe", 0.0)))) for item in operations)})
    best: tuple[float, float] | None = None
    for limit in candidates:
        equity = float(initial_balance)
        for operation in operations:
            pnl = float(operation.get("raw_pnl", operation.get("pnl", 0.0)))
            if float(operation.get("min_roe", 0.0)) <= -limit:
                notional = float(operation.get("notional", 0.0))
                fee = float(operation.get("fees", 0.0))
                pnl = -(limit / (100 * max(1.0, leverage))) * notional - fee
            equity += pnl
        candidate = (equity, -limit)
        if best is None or candidate > best:
            best = candidate
    selected_limit = -best[1] if best is not None else floor
    return selected_limit, best[0] if best is not None else float(initial_balance)


def minroe_to_price_stop_percent(minroe_limit_percent: float, leverage: float) -> float:
    """Convert a leveraged ROE threshold into an underlying price percentage."""
    value = abs(float(minroe_limit_percent)) / max(1.0, float(leverage))
    return max(0.2, min(value or 0.2, 20.0))


def calibrate_tracker_parameters(
    bars: list[dict[str, Any]],
    *,
    risk_percent: float = 1.0,
    leverage: float = 1.0,
    initial_balance: float = 100.0,
    current_tracker_period: int = 5,
    tracker_period_candidates: Iterable[int] | None = None,
    tp_step_percent: float = 0.5,
    fee_rate: float = 0.0014,
    loss_limit_selection: Literal["coverage", "equity"] = "coverage",
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
    candidates = tuple(tracker_period_candidates or TRACKER_PERIOD_CANDIDATES)
    for period in candidates:
        config = ScannerAnalysisConfig(
            tracker_period=period,
            stop_percent=20.0,
            # Calibration leaves the close-based stop wide so it can observe
            # full trades, but the intrabar Limited floor remains the fixed
            # 0.20% price stop used by the product.
            loss_limit_floor_price_percent=0.2,
            initial_balance=max(1.0, min(float(initial_balance), 1_000_000.0)),
            risk_percent=max(0.01, min(float(risk_percent), 100.0)),
            leverage=max(1.0, min(float(leverage), 125.0)),
            fee_rate=max(0.0, float(fee_rate)),
            min_tp_percent=0.5,
            max_tp_percent=20.0,
            tp_step_percent=max(0.1, float(tp_step_percent)),
        )
        result = analyze_tracker(closed, config)
        selected_limit = abs(float(result.get("loss_limit_percent") or 0.0))
        score = float(result.get("equity_final") or max(1.0, float(initial_balance)))
        if loss_limit_selection == "equity":
            floor_roe = 0.2 * max(1.0, float(leverage))
            selected_limit, score = _equity_selected_loss_limit(
                list(result.get("operation_details") or []),
                initial_balance=max(1.0, float(initial_balance)),
                leverage=leverage,
                floor_roe_percent=floor_roe,
            )
        # Stable tie breaking: prefer the currently active N, then the smaller N.
        tie = 1 if period == current_tracker_period else 0
        ranked.append((score, tie, {"period": period, **result, "loss_limit_percent": selected_limit, "equity_final": score}))

    score, _tie, best = max(ranked, key=lambda item: (item[0], item[1], -item[2]["period"]))
    minimum_limit_roe = 0.2 * max(1.0, float(leverage))
    minroe_limit_percent = max(abs(float(best.get("loss_limit_percent") or 0.0)), minimum_limit_roe)
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
        "loss_limit_selection": loss_limit_selection,
        "risk_percent": max(0.01, min(float(risk_percent), 100.0)),
        "leverage": max(1.0, min(float(leverage), 125.0)),
        "initial_balance": max(1.0, min(float(initial_balance), 1_000_000.0)),
        "risk_usdt": round(max(1.0, min(float(initial_balance), 1_000_000.0)) * max(0.01, min(float(risk_percent), 100.0)) / 100, 6),
        "sample_operations": int(best.get("operations") or 0),
        "historical_win_rate": float(best.get("win_rate") or 0.0),
        "historical_result_usdt": round(score - max(1.0, min(float(initial_balance), 1_000_000.0)), 6),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
