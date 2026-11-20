"""Leakage-safe retrospective evaluation of adaptive Tracker parameters.

Each parameter snapshot is calibrated only from candles before its effective
time. Operations retain the snapshot from their entry, even when later folds
choose different values. This module is research-only and does not control the
production worker.
"""

from __future__ import annotations

from collections.abc import Iterable
from hashlib import sha256
import json
from typing import Any, Literal

from app.adaptive_tracker import MIN_CALIBRATION_BARS, calibrate_tracker_parameters
from app.tracker_strategy import tracker_close_reason, tracker_levels, tracker_signal


DEFAULT_WINDOW_CANDIDATES = (120, 240, 360, 480)
COARSE_PERIOD_CANDIDATES = (4, 8, 12, 16, 20)


def _clean_bars(bars: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    clean: dict[int, dict[str, Any]] = {}
    for bar in bars:
        try:
            if bar.get("closed", True) is False:
                continue
            row = {
                "time": int(bar["time"]),
                "open": float(bar["open"]),
                "high": float(bar["high"]),
                "low": float(bar["low"]),
                "close": float(bar["close"]),
                "closed": True,
            }
            if row["time"] >= 0 and min(row["open"], row["high"], row["low"], row["close"]) > 0:
                clean[row["time"]] = row
        except (KeyError, TypeError, ValueError):
            continue
    return [clean[timestamp] for timestamp in sorted(clean)]


def _snapshot(
    history: list[dict[str, Any]],
    *,
    current_balance: float,
    risk_percent: float,
    leverage: float,
    current_period: int,
    coarse: bool,
    fee_rate: float,
    loss_limit_selection: Literal["coverage", "equity"],
) -> dict[str, Any]:
    return calibrate_tracker_parameters(
        history,
        risk_percent=risk_percent,
        leverage=leverage,
        initial_balance=max(1.0, current_balance),
        current_tracker_period=current_period,
        tracker_period_candidates=COARSE_PERIOD_CANDIDATES if coarse else None,
        tp_step_percent=1.0 if coarse else 0.5,
        fee_rate=fee_rate,
        loss_limit_selection=loss_limit_selection,
    )


def run_walk_forward(
    bars: Iterable[dict[str, Any]],
    *,
    symbol: str,
    window_bars: int = 480,
    recalibration_bars: int = 60,
    initial_balance: float = 100.0,
    risk_percent: float = 1.0,
    leverage: float = 1.0,
    fee_rate: float = 0.0014,
    evaluation_start_index: int | None = None,
    coarse_search: bool = False,
    loss_limit_selection: Literal["coverage", "equity"] = "coverage",
    window_schedule: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Run one rolling-window walk-forward pass over already closed 1m bars.

    `evaluation_start_index` permits a final untouched holdout while preserving
    its preceding candles as calibration context. Default starts immediately
    after the first complete training window.
    """
    ordered = _clean_bars(bars)
    window = max(MIN_CALIBRATION_BARS, min(480, int(window_bars)))
    step = max(1, min(240, int(recalibration_bars)))
    start = max(window, int(evaluation_start_index or window))
    if len(ordered) <= start:
        return {
            "symbol": symbol.upper(), "status": "INSUFFICIENT_HISTORY", "bars": len(ordered),
            "window_bars": window, "recalibration_bars": step, "evaluation_bars": 0,
            "operations": [], "folds": [], "statistics": _empty_stats(initial_balance),
        }

    raw_balance = max(1.0, float(initial_balance))
    displayed_balance = raw_balance
    current: dict[str, Any] | None = None
    current_parameters: dict[str, Any] | None = None
    current_period = 5
    folds: list[dict[str, Any]] = []
    operations: list[dict[str, Any]] = []
    fold_operations_start = 0
    fold_balance_start = displayed_balance
    version = 0
    next_recalibration_time = 0
    cadence_seconds = step * 60
    active_window = window
    schedule_by_time = {
        int(item["effective_from"]): item
        for item in (window_schedule or [])
        if isinstance(item, dict) and item.get("effective_from") is not None
    }
    used_window_schedule: list[dict[str, Any]] = []

    for index in range(start, len(ordered)):
        bar_time = int(ordered[index]["time"])
        if current_parameters is None or bar_time >= next_recalibration_time:
            window_choice = schedule_by_time.get(bar_time)
            if window_choice is not None:
                active_window = max(MIN_CALIBRATION_BARS, min(480, int(window_choice.get("window_bars", active_window))))
                used_window_schedule.append(dict(window_choice))
            training = ordered[max(0, index - active_window):index]
            if len(training) < MIN_CALIBRATION_BARS:
                continue
            # Finalize the preceding fold's realized metrics before selecting
            # a new snapshot. Existing operations below retain their entry data.
            if current_parameters is not None:
                fold_ops = operations[fold_operations_start:]
                folds.append(_fold_summary(
                    current_parameters, fold_ops, fold_balance_start, displayed_balance,
                    int(ordered[index - 1]["time"]), int(ordered[index]["time"]),
                ))
            current_parameters = _snapshot(
                training,
                current_balance=raw_balance,
                risk_percent=risk_percent,
                leverage=leverage,
                current_period=current_period,
                coarse=coarse_search,
                fee_rate=fee_rate,
                loss_limit_selection=loss_limit_selection,
            )
            version += 1
            current_parameters = {
                **current_parameters,
                "parameter_version": version,
                "effective_from": int(ordered[index]["time"]),
                "training_from": int(training[0]["time"]),
                "training_through": int(training[-1]["time"]),
                "training_bars": len(training),
                "window_bars": active_window,
            }
            current_period = int(current_parameters["tracker_period"])
            # Align recalibration ticks to absolute candle time so shifting the
            # dataset's first bar by one minute cannot change the cadence phase.
            next_recalibration_time = (bar_time // cadence_seconds + 1) * cadence_seconds
            fold_operations_start = len(operations)
            fold_balance_start = displayed_balance

        bar = ordered[index]
        parameters = current_parameters
        if parameters is None:
            continue
        period = max(1, int(parameters["tracker_period"]))
        signal: tuple[str, str] | None = None
        if index >= period:
            previous = ordered[index - period:index]
            signal = tracker_signal(float(bar["close"]), tracker_levels(previous))

        closed_operation = False
        if current is not None:
            side = str(current["side"])
            entry = float(current["entry_price"])
            leverage_value = max(1.0, float(current["leverage"]))
            direction = 1 if side == "LONG" else -1
            adverse = float(bar["low"] if side == "LONG" else bar["high"])
            favorable = float(bar["high"] if side == "LONG" else bar["low"])
            adverse_roe = (adverse - entry) / entry * direction * leverage_value * 100
            favorable_roe = (favorable - entry) / entry * direction * leverage_value * 100
            close_roe = (float(bar["close"]) - entry) / entry * direction * leverage_value * 100
            current["min_roe"] = min(float(current["min_roe"]), adverse_roe)
            current["max_roe"] = max(float(current["max_roe"]), favorable_roe)
            current["real_min_roe"] = min(float(current["real_min_roe"]), close_roe)
            current["real_max_roe"] = max(float(current["real_max_roe"]), close_roe)
            raw_reason = tracker_close_reason(
                side, entry, float(bar["close"]),
                float(current["stop_percent"]), float(current["target_percent"]),
            )
            opposite = signal is not None and signal[0] != side
            reason = raw_reason if raw_reason != "TP" or opposite else None
            if reason is not None:
                notional = float(current["notional"])
                raw_return = (float(bar["close"]) - entry) / entry * direction
                fees = notional * fee_rate
                raw_pnl = raw_return * notional - fees
                limited_threshold = abs(float(current["minroe_limit_percent"]))
                limited = float(current["min_roe"]) <= -limited_threshold
                pnl = raw_pnl
                if limited:
                    pnl = -(limited_threshold / (100 * leverage_value)) * notional - fees
                raw_balance = max(0.0, raw_balance + raw_pnl)
                displayed_balance += pnl
                operations.append({
                    "symbol": symbol.upper(), "side": side,
                    "entry_time": int(current["entry_time"]), "entry_price": entry,
                    "exit_time": int(bar["time"]), "exit_price": float(bar["close"]),
                    "duration_minutes": (int(bar["time"]) - int(current["entry_time"])) / 60,
                    "status": "WIN" if reason == "TP" else "FAIL", "close_reason": reason,
                    "limited": limited, "limit_roe_percent": -limited_threshold if limited else None,
                    "raw_pnl": raw_pnl, "pnl": pnl, "fees": fees,
                    "min_roe": float(current["min_roe"]), "max_roe": float(current["max_roe"]),
                    "notional": notional, "margin": notional / leverage_value,
                    "leverage": leverage_value, "balance_after": displayed_balance,
                    "sizing_balance_after": raw_balance,
                    "tracker_period": int(current["tracker_period"]),
                    "target_percent": float(current["target_percent"]),
                    "stop_percent": float(current["stop_percent"]),
                    "minroe_limit_percent": limited_threshold,
                    "parameter_version": int(current["parameter_version"]),
                })
                level = str(current["level"])
                current = None
                closed_operation = True
                if reason == "TP":
                    reverse = "SHORT" if side == "LONG" else "LONG"
                    signal = (reverse, level)

        if current is None and signal is not None:
            # On the candle that closes an SL/failed operation, preserve the
            # Tracker's same-candle retry rule. TP reversals are marked above.
            if not closed_operation or (operations and operations[-1]["close_reason"] in {"SL", "TP"}):
                target = float(parameters["target_percent"])
                stop = max(0.000001, float(parameters["stop_percent"]))
                risk_amount = raw_balance * max(0.0, float(risk_percent)) / 100
                notional = min(risk_amount / (stop / 100), raw_balance * max(1.0, float(leverage)))
                if notional > 0 and float(bar["close"]) > 0:
                    current = {
                        "side": signal[0], "level": signal[1], "entry_time": int(bar["time"]),
                        "entry_price": float(bar["close"]), "notional": notional,
                        "leverage": max(1.0, float(leverage)), "tracker_period": period,
                        "target_percent": target, "stop_percent": stop,
                        "minroe_limit_percent": abs(float(parameters.get("minroe_limit_percent", 0.0))),
                        "min_roe": 0.0, "max_roe": 0.0, "real_min_roe": 0.0, "real_max_roe": 0.0,
                        "parameter_version": int(parameters["parameter_version"]),
                    }

    if current_parameters is not None:
        fold_ops = operations[fold_operations_start:]
        folds.append(_fold_summary(
            current_parameters, fold_ops, fold_balance_start, displayed_balance,
            int(ordered[-1]["time"]), None,
        ))
    unrealized_pnl = 0.0
    if current is not None and ordered:
        direction = 1 if str(current["side"]) == "LONG" else -1
        mark_return = (float(ordered[-1]["close"]) - float(current["entry_price"])) / float(current["entry_price"]) * direction
        unrealized_pnl = mark_return * float(current["notional"]) - float(current["notional"]) * fee_rate
    return {
        "symbol": symbol.upper(), "status": "COMPLETE", "bars": len(ordered),
        "window_bars": window, "recalibration_bars": step,
        "evaluation_start": int(ordered[start]["time"]), "evaluation_end": int(ordered[-1]["time"]),
        "evaluation_bars": len(ordered) - start, "calibration_search": "coarse" if coarse_search else "full",
        "loss_limit_selection": loss_limit_selection,
        "initial_balance": float(initial_balance), "final_balance": displayed_balance,
        "final_sizing_balance": raw_balance, "operations": operations, "folds": folds,
        "window_schedule": used_window_schedule,
        "open_unrealized_pnl_estimate": unrealized_pnl,
        "mark_to_market_balance_estimate": displayed_balance + unrealized_pnl,
        "open_operation": _public_open_operation(current),
        "statistics": _stats(operations, initial_balance, displayed_balance, unrealized_pnl),
    }


def _calibration_tick_indices(bars: list[dict[str, Any]], start: int, recalibration_bars: int) -> list[int]:
    if start >= len(bars):
        return []
    interval = max(1, int(recalibration_bars)) * 60
    ticks = [start]
    next_time = (int(bars[start]["time"]) // interval + 1) * interval
    for index in range(start + 1, len(bars)):
        bar_time = int(bars[index]["time"])
        if bar_time >= next_time:
            ticks.append(index)
            next_time = (bar_time // interval + 1) * interval
    return ticks


def run_adaptive_window_walk_forward(
    bars: Iterable[dict[str, Any]],
    *,
    symbol: str,
    window_candidates: Iterable[int] = DEFAULT_WINDOW_CANDIDATES,
    recalibration_bars: int = 15,
    initial_balance: float = 100.0,
    risk_percent: float = 1.0,
    leverage: float = 1.0,
    fee_rate: float = 0.0014,
    evaluation_start_index: int | None = None,
    coarse_search: bool = True,
    loss_limit_selection: Literal["coverage", "equity"] = "coverage",
    meta_lookback_segments: int = 4,
) -> dict[str, Any]:
    """Choose W online from only the previous forward results of shadow windows.

    Each candidate W runs as an independent shadow model for the segment that
    just ended. At a recalibration boundary, the best recent shadow is selected
    for the next segment. The selected portfolio keeps its open operation's
    entry parameters unchanged.
    """
    ordered = _clean_bars(bars)
    candidates = sorted({max(MIN_CALIBRATION_BARS, min(480, int(value))) for value in window_candidates})
    if not candidates:
        raise ValueError("Se requiere al menos una ventana entre 120 y 480 velas.")
    step = max(15, min(240, int(recalibration_bars)))
    max_window = max(candidates)
    start = max(max_window, int(evaluation_start_index or max_window))
    if len(ordered) <= start:
        return {
            "symbol": symbol.upper(), "status": "INSUFFICIENT_HISTORY", "bars": len(ordered),
            "required_bars": max_window + 1, "window_candidates": candidates,
            "recalibration_bars": step, "window_selection_history": [],
            "result": run_walk_forward(ordered, symbol=symbol, window_bars=max_window, evaluation_start_index=start),
        }

    ticks = _calibration_tick_indices(ordered, start, step)
    score_history: dict[int, list[float]] = {candidate: [] for candidate in candidates}
    selected_window = max_window
    schedule: list[dict[str, Any]] = []
    selection_history: list[dict[str, Any]] = []
    lookback = max(1, min(24, int(meta_lookback_segments)))

    for tick_number, effective_index in enumerate(ticks):
        effective_time = int(ordered[effective_index]["time"])
        scores: dict[str, dict[str, Any]] = {}
        if tick_number > 0:
            segment_start = ticks[tick_number - 1]
            observed_bars = ordered[:effective_index]
            for candidate in candidates:
                shadow = run_walk_forward(
                    observed_bars,
                    symbol=symbol,
                    window_bars=candidate,
                    recalibration_bars=step,
                    initial_balance=initial_balance,
                    risk_percent=risk_percent,
                    leverage=leverage,
                    fee_rate=fee_rate,
                    evaluation_start_index=segment_start,
                    coarse_search=coarse_search,
                    loss_limit_selection=loss_limit_selection,
                )
                statistics = shadow["statistics"]
                score = float(statistics.get("mark_to_market_return_percent_estimate", statistics.get("return_percent", 0.0)))
                score_history[candidate].append(score)
                scores[str(candidate)] = {
                    "segment_return_percent": score,
                    "segment_net_pnl": statistics.get("net_pnl", 0.0),
                    "operations": statistics.get("operations", 0),
                    "score_history_segments": min(lookback, len(score_history[candidate])),
                    "recent_score_percent": sum(score_history[candidate][-lookback:]),
                }
            selected_window = max(
                candidates,
                key=lambda candidate: (
                    sum(score_history[candidate][-lookback:]),
                    candidate == selected_window,
                    candidate,
                ),
            )
            selection_history.append({
                "effective_from": effective_time,
                "score_segment_from": int(ordered[segment_start]["time"]),
                "score_segment_through": int(ordered[effective_index - 1]["time"]),
                "selected_window_bars": selected_window,
                "scores": scores,
            })
        else:
            selection_history.append({
                "effective_from": effective_time,
                "score_segment_from": None, "score_segment_through": None,
                "selected_window_bars": selected_window, "scores": {},
            })
        schedule.append({
            "effective_from": effective_time,
            "window_bars": selected_window,
            "selection_scores": scores,
        })

    result = run_walk_forward(
        ordered,
        symbol=symbol,
        window_bars=max_window,
        recalibration_bars=step,
        initial_balance=initial_balance,
        risk_percent=risk_percent,
        leverage=leverage,
        fee_rate=fee_rate,
        evaluation_start_index=start,
        coarse_search=coarse_search,
        loss_limit_selection=loss_limit_selection,
        window_schedule=schedule,
    )
    return {
        "symbol": symbol.upper(), "status": result["status"], "mode": "ADAPTIVE_WINDOW_WALK_FORWARD",
        "bars": len(ordered), "window_candidates": candidates, "recalibration_bars": step,
        "meta_lookback_segments": lookback, "window_selection_metric": "sum of previous shadow-segment mark-to-market returns",
        "selection_history": selection_history,
        "result": result,
    }


def run_walk_forward_study(
    bars: Iterable[dict[str, Any]],
    *,
    symbol: str,
    window_candidates: Iterable[int] = DEFAULT_WINDOW_CANDIDATES,
    recalibration_bars: int = 60,
    recalibration_candidates: Iterable[int] | None = None,
    holdout_fraction: float = 0.30,
    initial_balance: float = 100.0,
    risk_percent: float = 1.0,
    leverage: float = 1.0,
    fee_rate: float = 0.0014,
    coarse_search: bool = True,
    loss_limit_selection: Literal["coverage", "equity"] = "coverage",
) -> dict[str, Any]:
    """Select a context window on a tuning period, then test it on untouched data."""
    ordered = _clean_bars(bars)
    candidates = sorted({max(MIN_CALIBRATION_BARS, min(480, int(item))) for item in window_candidates})
    if not candidates:
        raise ValueError("Se requiere al menos una ventana entre 120 y 480 velas.")
    cadences = sorted({max(15, min(240, int(item))) for item in (recalibration_candidates or (recalibration_bars,))})
    fraction = max(0.15, min(0.45, float(holdout_fraction)))
    holdout_bars = max(max(candidates), int(len(ordered) * fraction))
    split_index = len(ordered) - holdout_bars
    if split_index <= max(candidates) or len(ordered) - split_index < 60:
        return {
            "symbol": symbol.upper(), "status": "INSUFFICIENT_HISTORY", "bars": len(ordered),
            "required_bars": max(candidates) + 60, "window_candidates": candidates,
            "selection": [], "selected_window_bars": None, "holdout": None,
        }

    selection: list[dict[str, Any]] = []
    for window in candidates:
        for cadence in cadences:
            result = run_walk_forward(
                ordered[:split_index], symbol=symbol, window_bars=window,
                recalibration_bars=cadence, initial_balance=initial_balance,
                risk_percent=risk_percent, leverage=leverage, fee_rate=fee_rate,
                coarse_search=coarse_search,
                loss_limit_selection=loss_limit_selection,
            )
            selection.append({
                "window_bars": window, "window_hours": window / 60,
                "recalibration_bars": cadence, "recalibration_minutes": cadence,
                "net_pnl": result["statistics"]["net_pnl"],
                "return_percent": result["statistics"]["return_percent"],
                "max_drawdown": result["statistics"]["max_drawdown"],
                "operations": result["statistics"]["operations"],
                "wins": result["statistics"]["wins"], "losses": result["statistics"]["losses"],
            })
    # Net profit is ranked only on the tuning period; tie-break on drawdown and
    # then prefer the shorter window to make the adaptive choice responsive.
    selected = max(selection, key=lambda item: (item["net_pnl"], -item["max_drawdown"], -item["window_bars"], -item["recalibration_bars"]))
    chosen_window = int(selected["window_bars"])
    chosen_cadence = int(selected["recalibration_bars"])
    holdout = run_walk_forward(
        ordered, symbol=symbol, window_bars=chosen_window,
        recalibration_bars=chosen_cadence, initial_balance=initial_balance,
        risk_percent=risk_percent, leverage=leverage, fee_rate=fee_rate,
        evaluation_start_index=split_index, coarse_search=coarse_search,
        loss_limit_selection=loss_limit_selection,
    )
    return {
        "symbol": symbol.upper(), "status": "COMPLETE", "bars": len(ordered),
        "data_signature": {
            "sha256": sha256(json.dumps(ordered, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
            "first_bar_time": int(ordered[0]["time"]), "last_bar_time": int(ordered[-1]["time"]),
        },
        "tuning_bars": split_index, "holdout_bars": len(ordered) - split_index,
        "tuning_end": int(ordered[split_index - 1]["time"]),
        "holdout_start": int(ordered[split_index]["time"]),
        "recalibration_candidates": cadences, "selected_recalibration_bars": chosen_cadence,
        "calibration_search": "coarse" if coarse_search else "full",
        "loss_limit_selection": loss_limit_selection,
        "window_candidates": candidates, "selection": selection,
        "selected_window_bars": chosen_window, "selected_window_hours": chosen_window / 60,
        "holdout": holdout,
    }


def _fold_summary(parameters: dict[str, Any], operations: list[dict[str, Any]], start_balance: float, end_balance: float, trained_through: int, next_effective: int | None) -> dict[str, Any]:
    return {
        "parameter_version": parameters["parameter_version"],
        "training_from": parameters["training_from"], "training_through": parameters["training_through"],
        "effective_from": parameters["effective_from"], "next_effective": next_effective,
        "window_bars": parameters.get("window_bars"),
        "tracker_period": parameters["tracker_period"], "target_percent": parameters["target_percent"],
        "stop_percent": parameters["stop_percent"], "minroe_limit_percent": parameters["minroe_limit_percent"],
        "operations_closed": len(operations), "net_pnl": sum(float(item["pnl"]) for item in operations),
        "wins": sum(item["status"] == "WIN" for item in operations),
        "losses": sum(item["status"] == "FAIL" for item in operations),
        "limited": sum(bool(item["limited"]) for item in operations),
        "balance_start": start_balance, "balance_end": end_balance,
        "measurement_through": trained_through,
    }


def _stats(operations: list[dict[str, Any]], initial_balance: float, final_balance: float, open_unrealized_pnl: float = 0.0) -> dict[str, Any]:
    wins = sum(item["status"] == "WIN" for item in operations)
    losses = sum(item["status"] == "FAIL" for item in operations)
    negative_wins = sum(item["status"] == "WIN" and float(item["pnl"]) < 0 for item in operations)
    equity = float(initial_balance)
    peak = equity
    drawdown = 0.0
    for item in operations:
        equity += float(item["pnl"])
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
    net = final_balance - initial_balance
    raw_net = sum(float(item["raw_pnl"]) for item in operations)
    limited_adjustment = sum(float(item["pnl"]) - float(item["raw_pnl"]) for item in operations)
    fees = sum(float(item["fees"]) for item in operations)
    durations = [float(item["duration_minutes"]) for item in operations]
    return {
        "operations": len(operations), "wins": wins, "losses": losses,
        "win_rate": wins / len(operations) * 100 if operations else 0.0,
        "limited": sum(bool(item["limited"]) for item in operations),
        "limited_wins_with_negative_pnl": negative_wins,
        "net_pnl": net, "return_percent": net / initial_balance * 100 if initial_balance else 0.0,
        "raw_net_pnl": raw_net, "limited_adjustment": limited_adjustment,
        "fees": fees, "average_duration_minutes": sum(durations) / len(durations) if durations else None,
        "open_unrealized_pnl_estimate": open_unrealized_pnl,
        "mark_to_market_net_pnl_estimate": net + open_unrealized_pnl,
        "mark_to_market_return_percent_estimate": (net + open_unrealized_pnl) / initial_balance * 100 if initial_balance else 0.0,
        "max_drawdown": drawdown, "final_balance": final_balance,
        "closed_operations_with_balance": len(operations),
    }


def _empty_stats(initial_balance: float) -> dict[str, Any]:
    return {"operations": 0, "wins": 0, "losses": 0, "win_rate": 0.0, "limited": 0, "limited_wins_with_negative_pnl": 0, "net_pnl": 0.0, "return_percent": 0.0, "raw_net_pnl": 0.0, "limited_adjustment": 0.0, "fees": 0.0, "average_duration_minutes": None, "open_unrealized_pnl_estimate": 0.0, "mark_to_market_net_pnl_estimate": 0.0, "mark_to_market_return_percent_estimate": 0.0, "max_drawdown": 0.0, "final_balance": initial_balance, "closed_operations_with_balance": 0}


def _public_open_operation(operation: dict[str, Any] | None) -> dict[str, Any] | None:
    if operation is None:
        return None
    return {key: operation[key] for key in (
        "side", "entry_time", "entry_price", "tracker_period", "target_percent",
        "stop_percent", "minroe_limit_percent", "parameter_version",
    )}
