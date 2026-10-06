"""Canonical Tracker decision rules used by production workers.

The frontend replay mirrors this contract in ``calculateTrackerLevels`` and
``runTrackerVisualSimulation``: levels use only the completed bars before the
current bar, signals are mutually exclusive, and exits are decided from the
current candle close.
"""

from __future__ import annotations

from typing import Any


def tracker_levels(previous: list[dict[str, Any]]) -> dict[str, float] | None:
    if not previous:
        return None
    return {
        "h2": max(float(bar["high"]) for bar in previous),
        "h1": max(max(float(bar["open"]), float(bar["close"])) for bar in previous),
        "l1": min(min(float(bar["open"]), float(bar["close"])) for bar in previous),
        "l2": min(float(bar["low"]) for bar in previous),
    }


def tracker_signal(close: float, levels: dict[str, float] | None) -> tuple[str, str] | None:
    """Return ``(side, level)`` using the exclusive H2/H1/L1/L2 ladder."""
    if levels is None:
        return None
    if close >= levels["h1"] and close >= levels["h2"]:
        return "SHORT", "H2"
    if close >= levels["h1"] and close < levels["h2"]:
        return "SHORT", "H1"
    if close <= levels["l1"] and close > levels["l2"]:
        return "LONG", "L1"
    if close <= levels["l2"] and close <= levels["l1"]:
        return "LONG", "L2"
    return None


def tracker_close_reason(side: str, entry_price: float, close: float, stop_percent: float, target_percent: float) -> str | None:
    """Decide SL/TP from the completed candle close.

    SL has precedence if a close could satisfy both thresholds, matching the
    existing visual simulator's conservative ordering. A candle close is
    never treated as an intrabar fill.
    """
    direction = 1 if side == "LONG" else -1
    close_roe = ((close - entry_price) / entry_price) * direction if entry_price else 0.0
    if close_roe <= -abs(stop_percent) / 100:
        return "SL"
    if close_roe >= abs(target_percent) / 100:
        return "TP"
    return None
