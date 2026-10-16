"""Lightweight, backend-owned Tracker analysis for the market scanner."""

from __future__ import annotations

from contextlib import nullcontext
from dataclasses import dataclass
from typing import Any, Iterable

from app.profiling import Profiling
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


def _simulate(
    bars: list[dict[str, Any]],
    config: ScannerAnalysisConfig,
    target_percent: float,
    signals: list[tuple[str, str] | None] | None = None,
) -> list[dict[str, float | int | str]]:
    period = max(1, int(config.tracker_period))
    leverage = max(1.0, float(config.leverage))
    stop_percent = abs(float(config.stop_percent))
    stop_distance = max(stop_percent / 100, 0.000001)
    balance = max(0.0, float(config.initial_balance))
    operations: list[dict[str, float | int | str]] = []
    open_operation: dict[str, float | int | str] | None = None

    def body_average_percent(index: int) -> float:
        sample = bars[max(0, index - 4):index + 1]
        values = [abs(float(item["close"]) - float(item["open"])) / float(item["open"]) * 100 for item in sample if float(item["open"]) > 0]
        return sum(values) / len(values) if values else 0.0

    def new_operation(side: str, entry: float, entry_time: int, notional: float, level: str, index: int) -> dict[str, float | int | str]:
        return {"side": side, "entry": entry, "entry_time": entry_time, "notional": notional, "min_roe": 0.0, "min_roe_time": entry_time, "min_roe_price": entry, "max_roe": 0.0, "max_roe_time": entry_time, "max_roe_price": entry, "real_min_roe": 0.0, "real_min_roe_time": entry_time, "real_min_roe_price": entry, "real_max_roe": 0.0, "real_max_roe_time": entry_time, "real_max_roe_price": entry, "body_average_percent_at_open": body_average_percent(index), "level": level}

    for index in range(period, len(bars)):
        bar = bars[index]
        previous = bars[index - period:index]
        close = float(bar["close"])
        signal = signals[index] if signals is not None else tracker_signal(close, tracker_levels(previous))

        if open_operation is not None:
            side = str(open_operation["side"])
            entry = float(open_operation["entry"])
            notional = float(open_operation["notional"])
            adverse = float(bar["low"] if side == "LONG" else bar["high"])
            favorable = float(bar["high"] if side == "LONG" else bar["low"])
            adverse_roe = _point_roe(side, entry, adverse, leverage)
            favorable_roe = _point_roe(side, entry, favorable, leverage)
            close_roe_percent = _point_roe(side, entry, close, leverage)
            if adverse_roe < float(open_operation["min_roe"]):
                open_operation.update({"min_roe": adverse_roe, "min_roe_time": int(bar["time"]), "min_roe_price": adverse})
            if favorable_roe > float(open_operation["max_roe"]):
                open_operation.update({"max_roe": favorable_roe, "max_roe_time": int(bar["time"]), "max_roe_price": favorable})
            if close_roe_percent < float(open_operation["real_min_roe"]):
                open_operation.update({"real_min_roe": close_roe_percent, "real_min_roe_time": int(bar["time"]), "real_min_roe_price": close})
            if close_roe_percent > float(open_operation["real_max_roe"]):
                open_operation.update({"real_max_roe": close_roe_percent, "real_max_roe_time": int(bar["time"]), "real_max_roe_price": close})
            raw_reason = tracker_close_reason(side, entry, close, stop_percent, target_percent)
            opposite_signal = signal is not None and ((side == "LONG" and signal[0] == "SHORT") or (side == "SHORT" and signal[0] == "LONG"))
            reason = raw_reason if raw_reason != "TP" or opposite_signal else None
            if reason is not None:
                direction = 1 if side == "LONG" else -1
                roe = (close - entry) / entry * direction if entry else 0.0
                fees = notional * config.fee_rate
                pnl = roe * notional - fees
                balance = max(0.0, balance + pnl)
                operations.append({"side": side, "entry_time": int(open_operation["entry_time"]), "entry_price": entry, "exit_time": int(bar["time"]), "exit_price": close, "duration_minutes": max(0.0, (int(bar["time"]) - int(open_operation["entry_time"])) / 60), "min_roe": float(open_operation["min_roe"]), "min_roe_time": int(open_operation["min_roe_time"]), "min_roe_price": float(open_operation["min_roe_price"]), "max_roe": float(open_operation["max_roe"]), "max_roe_time": int(open_operation["max_roe_time"]), "max_roe_price": float(open_operation["max_roe_price"]), "real_min_roe": float(open_operation["real_min_roe"]), "real_min_roe_time": int(open_operation["real_min_roe_time"]), "real_min_roe_price": float(open_operation["real_min_roe_price"]), "real_max_roe": float(open_operation["real_max_roe"]), "real_max_roe_time": int(open_operation["real_max_roe_time"]), "real_max_roe_price": float(open_operation["real_max_roe_price"]), "body_average_percent_at_open": float(open_operation["body_average_percent_at_open"]), "body_average_percent_at_close": body_average_percent(index), "pnl": pnl, "fees": fees, "notional": notional, "leverage": leverage, "level": str(open_operation.get("level", "H1")), "close_reason": reason, "status": "WIN" if reason == "TP" else "FAIL", "balance_after": balance})
                level = str(open_operation.get("level", "H1"))
                open_operation = None
                if reason == "TP":
                    # The visual and production Tracker reverse at the same close.
                    reverse_side = "SHORT" if side == "LONG" else "LONG"
                    risk_amount = balance * max(0.0, config.risk_percent) / 100
                    reverse_notional = min(risk_amount / stop_distance, balance * leverage)
                    if reverse_notional > 0 and close > 0:
                        open_operation = new_operation(reverse_side, close, int(bar["time"]), reverse_notional, level, index)
                elif signal is not None:
                    # A failed trade retries from the same closed candle using Tracker.
                    retry_side = signal[0]
                    risk_amount = balance * max(0.0, config.risk_percent) / 100
                    retry_notional = min(risk_amount / stop_distance, balance * leverage)
                    if retry_notional > 0 and close > 0:
                        open_operation = new_operation(retry_side, close, int(bar["time"]), retry_notional, signal[1], index)
                continue

        if open_operation is None and signal is not None and close > 0:
            side = signal[0]
            risk_amount = balance * max(0.0, config.risk_percent) / 100
            notional = min(risk_amount / stop_distance, balance * leverage)
            if notional > 0:
                open_operation = new_operation(side, close, int(bar["time"]), notional, signal[1], index)

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


def _limited_operations(operations: list[dict[str, float | int | str]], config: ScannerAnalysisConfig) -> tuple[float, list[dict[str, float | int | str]]]:
    limit = _loss_limit(operations)
    equity = float(config.initial_balance)
    adjusted: list[dict[str, float | int | str]] = []
    for operation in operations:
        pnl = float(operation["pnl"])
        status = str(operation["status"])
        direction = 1 if str(operation["side"]) == "LONG" else -1
        result_roe = (float(operation["exit_price"]) - float(operation["entry_price"])) / float(operation["entry_price"]) * direction * max(1.0, float(operation["leverage"])) * 100
        raw_pnl = pnl
        raw_status = status
        if float(operation["min_roe"]) <= -limit:
            limited = -(limit / 100 / max(1.0, float(operation["leverage"]))) * float(operation["notional"])
            pnl = max(pnl, limited - float(operation["notional"]) * config.fee_rate)
            status = "FAIL"
            result_roe = -limit
        equity += pnl
        adjusted.append({**operation, "raw_pnl": raw_pnl, "raw_status": raw_status, "raw_result_roe": (float(operation["exit_price"]) - float(operation["entry_price"])) / float(operation["entry_price"]) * direction * max(1.0, float(operation["leverage"])) * 100, "pnl": pnl, "status": status, "result_roe": result_roe, "balance_after": equity})
    return equity, adjusted


def _limited_equity(operations: list[dict[str, float | int | str]], config: ScannerAnalysisConfig) -> float:
    return _limited_operations(operations, config)[0]


def _build_tracker_signals(bars: list[dict[str, Any]], period: int) -> list[tuple[str, str] | None]:
    """Build the target-independent Tracker signal series once per analysis."""
    signals: list[tuple[str, str] | None] = [None] * len(bars)
    for index in range(max(1, period), len(bars)):
        signals[index] = tracker_signal(float(bars[index]["close"]), tracker_levels(bars[index - period:index]))
    return signals


def analyze_tracker(bars: Iterable[dict[str, Any]], config: ScannerAnalysisConfig | None = None, profiling: Profiling | None = None) -> dict[str, Any]:
    config = config or ScannerAnalysisConfig()
    clean = []
    profiling.mark("bars_parse_start") if profiling else None
    with profiling.measure("parse_bars") if profiling else nullcontext():
        for bar in bars:
            try:
                clean.append({"time": int(bar["time"]), "open": float(bar["open"]), "high": float(bar["high"]), "low": float(bar["low"]), "close": float(bar["close"])})
            except (KeyError, TypeError, ValueError):
                continue
    clean.sort(key=lambda bar: bar["time"])
    if profiling:
        profiling.mark("bars_parse_end", bars=len(clean))
    with profiling.measure("build_tracker_signals") if profiling else nullcontext():
        signals = _build_tracker_signals(clean, max(1, int(config.tracker_period)))
    if profiling:
        profiling.mark("tracker_signals_ready", signals=sum(signal is not None for signal in signals))
    best: tuple[float, float, list[dict[str, float | int | str]]] | None = None
    step = max(0.01, float(config.tp_step_percent))
    target = float(config.min_tp_percent)
    target_count = 0
    with profiling.measure("tp_optimization") if profiling else nullcontext():
        while target <= float(config.max_tp_percent) + step / 2:
            target_count += 1
            target_value = round(target, 4)
            if profiling:
                profiling.mark("tp_target_start", target_percent=target_value, iteration=target_count)
            with profiling.measure("simulate_target") if profiling else nullcontext():
                operations = _simulate(clean, config, target_value, signals)
            with profiling.measure("limited_equity") if profiling else nullcontext():
                equity = _limited_equity(operations, config)
            if best is None or equity > best[0] or (equity == best[0] and target < best[1]):
                best = (equity, target_value, operations)
                if profiling:
                    profiling.mark("tp_best_updated", target_percent=target_value, equity=round(equity, 6), operations=len(operations))
            target += step
    if profiling:
        profiling.mark("tp_optimization_end", candidates=target_count, best_tp=best[1] if best else None)
    _raw_equity, optimal_tp, raw_operations = best or (float(config.initial_balance), float(config.min_tp_percent), [])
    equity, operations = _limited_operations(raw_operations, config)
    loss_limit_percent = _loss_limit(raw_operations)
    with profiling.measure("aggregate_metrics") if profiling else nullcontext():
        durations = [float(operation["duration_minutes"]) for operation in operations]
        average_duration = sum(durations) / len(durations) if durations else None
    if profiling:
        profiling.mark("aggregate_metrics_end", operations=len(operations))
    wins = sum(operation["status"] == "WIN" for operation in operations)
    losses = sum(operation["status"] == "FAIL" for operation in operations)
    return {"tp_optimal_percent": optimal_tp, "average_duration_minutes": average_duration, "operations": len(operations), "wins": wins, "losses": losses, "win_rate": wins / (wins + losses) * 100 if wins + losses else 0.0, "equity_final": equity, "final_result_usdt": equity - float(config.initial_balance), "loss_limit_percent": loss_limit_percent, "last_bar_time": clean[-1]["time"] if clean else None, "bars": len(clean), "operation_details": operations}


def analyze_tracker_operations(
    bars: Iterable[dict[str, Any]],
    config: ScannerAnalysisConfig,
    target_percent: float,
    profiling: Profiling | None = None,
) -> dict[str, Any]:
    """Rebuild only the chosen TP's trade list for the selected-symbol panel."""
    clean = []
    with profiling.measure("parse_detail_bars") if profiling else nullcontext():
        for bar in bars:
            try:
                clean.append({"time": int(bar["time"]), "open": float(bar["open"]), "high": float(bar["high"]), "low": float(bar["low"]), "close": float(bar["close"])})
            except (KeyError, TypeError, ValueError):
                continue
    clean.sort(key=lambda bar: bar["time"])
    signals = _build_tracker_signals(clean, max(1, int(config.tracker_period)))
    with profiling.measure("selected_tp_simulation") if profiling else nullcontext():
        raw_operations = _simulate(clean, config, target_percent, signals)
    _equity, operations = _limited_operations(raw_operations, config)
    return {"operation_details": operations, "loss_limit_percent": _loss_limit(raw_operations)}


def activity_state(variation_average_pct: float, *, waking_threshold: float = 0.25, active_threshold: float = 0.60) -> str:
    movement = abs(float(variation_average_pct))
    if movement >= active_threshold:
        return "ACTIVA"
    if movement >= waking_threshold:
        return "DESPERTANDO"
    return "DORMIDA"
