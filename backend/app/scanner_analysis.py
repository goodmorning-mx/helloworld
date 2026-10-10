"""Lightweight, backend-owned Tracker analysis for the market scanner."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from app.tracker_strategy import tracker_close_reason, tracker_levels, tracker_signal


@dataclass(frozen=True)
class ScannerAnalysisConfig:
    tracker_period: int = 5
    stop_percent: float = 0.2
    initial_balance: float = 100.0
    risk_percent: float = 1.0
    leverage: float = 1.0
    fee_rate: float = 0.0014  # Binance taker commission + estimated slippage.
    min_tp_percent: float = 0.1
    max_tp_percent: float = 20.0
    tp_step_percent: float = 0.1


def _point_roe(side: str, entry: float, price: float, leverage: float) -> float:
    direction = 1 if side == "LONG" else -1
    return ((price - entry) / entry * direction * max(1.0, leverage) * 100) if entry else 0.0


def _simulate(bars: list[dict[str, Any]], config: ScannerAnalysisConfig, target_percent: float) -> list[dict[str, float | int | str]]:
    period = max(1, int(config.tracker_period))
    leverage = max(1.0, float(config.leverage))
    stop_percent = abs(float(config.stop_percent))
    stop_distance = max(stop_percent / 100, 0.000001)
    balance = max(0.0, float(config.initial_balance))
    operations: list[dict[str, float | int | str]] = []
    open_operation: dict[str, float | int | str] | None = None

    for index in range(period, len(bars)):
        bar = bars[index]
        previous = bars[index - period:index]
        close = float(bar["close"])
        signal = tracker_signal(close, tracker_levels(previous))

        if open_operation is not None:
            side = str(open_operation["side"])
            entry = float(open_operation["entry"])
            notional = float(open_operation["notional"])
            low_or_high = float(bar["low"] if side == "LONG" else bar["high"])
            favorable = float(bar["high"] if side == "LONG" else bar["low"])
            open_operation["min_roe"] = min(float(open_operation["min_roe"]), _point_roe(side, entry, low_or_high, leverage))
            open_operation["max_roe"] = max(float(open_operation["max_roe"]), _point_roe(side, entry, favorable, leverage))
            raw_reason = tracker_close_reason(side, entry, close, stop_percent, target_percent)
            opposite_signal = signal is not None and ((side == "LONG" and signal[0] == "SHORT") or (side == "SHORT" and signal[0] == "LONG"))
            reason = raw_reason if raw_reason != "TP" or opposite_signal else None
            if reason is not None:
                direction = 1 if side == "LONG" else -1
                roe = (close - entry) / entry * direction if entry else 0.0
                fees = notional * config.fee_rate
                pnl = roe * notional - fees
                balance = max(0.0, balance + pnl)
                operations.append({
                    "side": side,
                    "entry_time": int(open_operation["entry_time"]),
                    "exit_time": int(bar["time"]),
                    "duration_minutes": max(0.0, (int(bar["time"]) - int(open_operation["entry_time"])) / 60),
                    "min_roe": float(open_operation["min_roe"]),
                    "max_roe": float(open_operation["max_roe"]),
                    "pnl": pnl,
                    "notional": notional,
                    "leverage": leverage,
                    "status": "WIN" if reason == "TP" else "FAIL",
                    "balance_after": balance,
                })
                open_operation = None
                if reason == "TP":
                    # The visual and production Tracker reverse at the same close.
                    reverse_side = "SHORT" if side == "LONG" else "LONG"
                    risk_amount = balance * max(0.0, config.risk_percent) / 100
                    reverse_notional = min(risk_amount / stop_distance, balance * leverage)
                    if reverse_notional > 0 and close > 0:
                        open_operation = {"side": reverse_side, "entry": close, "entry_time": int(bar["time"]), "notional": reverse_notional, "min_roe": 0.0, "max_roe": 0.0}
                elif signal is not None:
                    # A failed trade retries from the same closed candle using Tracker.
                    retry_side = signal[0]
                    risk_amount = balance * max(0.0, config.risk_percent) / 100
                    retry_notional = min(risk_amount / stop_distance, balance * leverage)
                    if retry_notional > 0 and close > 0:
                        open_operation = {"side": retry_side, "entry": close, "entry_time": int(bar["time"]), "notional": retry_notional, "min_roe": 0.0, "max_roe": 0.0}
                continue

        if open_operation is None and signal is not None and close > 0:
            side = signal[0]
            risk_amount = balance * max(0.0, config.risk_percent) / 100
            notional = min(risk_amount / stop_distance, balance * leverage)
            if notional > 0:
                open_operation = {"side": side, "entry": close, "entry_time": int(bar["time"]), "notional": notional, "min_roe": 0.0, "max_roe": 0.0}

    return operations


def _loss_limit(operations: list[dict[str, float | int | str]]) -> float:
    wins = [operation for operation in operations if operation["status"] == "WIN"]
    losses = [operation for operation in operations if operation["status"] == "FAIL"]
    candidates = sorted({0.0, *[max(0.0, -float(operation["min_roe"])) for operation in operations]})
    if not candidates:
        return 0.0
    evaluated = []
    for limit in candidates:
        win_coverage = sum(float(operation["min_roe"]) >= -limit for operation in wins) / len(wins) if wins else 0.0
        loss_coverage = sum(float(operation["min_roe"]) <= -limit for operation in losses) / len(losses) if losses else 0.0
        evaluated.append((win_coverage >= .8 and loss_coverage >= .8, abs(win_coverage - .8) + abs(loss_coverage - .8), limit))
    feasible = [item for item in evaluated if item[0]]
    return min(feasible or evaluated, key=lambda item: (item[1], item[2]))[2]


def _limited_equity(operations: list[dict[str, float | int | str]], config: ScannerAnalysisConfig) -> float:
    limit = _loss_limit(operations)
    equity = float(config.initial_balance)
    for operation in operations:
        pnl = float(operation["pnl"])
        if float(operation["min_roe"]) <= -limit:
            limited = -(limit / 100 / max(1.0, float(operation["leverage"]))) * float(operation["notional"])
            pnl = max(pnl, limited - float(operation["notional"]) * config.fee_rate)
        equity += pnl
    return equity


def analyze_tracker(bars: Iterable[dict[str, Any]], config: ScannerAnalysisConfig | None = None) -> dict[str, Any]:
    config = config or ScannerAnalysisConfig()
    clean = []
    for bar in bars:
        try:
            clean.append({"time": int(bar["time"]), "open": float(bar["open"]), "high": float(bar["high"]), "low": float(bar["low"]), "close": float(bar["close"])})
        except (KeyError, TypeError, ValueError):
            continue
    clean.sort(key=lambda bar: bar["time"])
    best: tuple[float, float, list[dict[str, float | int | str]]] | None = None
    step = max(0.01, float(config.tp_step_percent))
    target = float(config.min_tp_percent)
    while target <= float(config.max_tp_percent) + step / 2:
        operations = _simulate(clean, config, round(target, 4))
        equity = _limited_equity(operations, config)
        if best is None or equity > best[0] or (equity == best[0] and target < best[1]):
            best = (equity, round(target, 4), operations)
        target += step
    equity, optimal_tp, operations = best or (float(config.initial_balance), float(config.min_tp_percent), [])
    durations = [float(operation["duration_minutes"]) for operation in operations]
    average_duration = sum(durations) / len(durations) if durations else None
    return {"tp_optimal_percent": optimal_tp, "average_duration_minutes": average_duration, "operations": len(operations), "wins": sum(operation["status"] == "WIN" for operation in operations), "losses": sum(operation["status"] == "FAIL" for operation in operations), "equity_final": equity, "final_result_usdt": equity - float(config.initial_balance), "last_bar_time": clean[-1]["time"] if clean else None, "bars": len(clean)}


def activity_state(variation_average_pct: float, *, waking_threshold: float = 0.25, active_threshold: float = 0.60) -> str:
    movement = abs(float(variation_average_pct))
    if movement >= active_threshold:
        return "ACTIVA"
    if movement >= waking_threshold:
        return "DESPERTANDO"
    return "DORMIDA"
