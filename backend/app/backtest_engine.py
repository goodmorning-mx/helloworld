"""Deterministic seven-day storycard backtesting for Binance Futures data."""

from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx


MAX_BACKTEST_DAYS = 7
BINANCE_KLINE_LIMIT = 1500
WEEKDAYS = {name: index for index, name in enumerate(("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"))}


def _number(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if result == result else default


def _event_timestamp(event: dict[str, Any], day: datetime, timezone_name: str) -> datetime | None:
    if event.get("timestamp"):
        raw = str(event["timestamp"]).replace("Z", "+00:00")
        parsed = datetime.fromisoformat(raw)
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    weekday = event.get("weekday")
    if weekday is not None:
        weekday_value = WEEKDAYS.get(str(weekday).lower()) if isinstance(weekday, str) else int(weekday)
        if weekday_value != day.weekday():
            return None
    hour, minute = (int(value) for value in str(event.get("time", "00:00")).split(":")[:2])
    local = datetime.combine(day.date(), time(hour, minute), tzinfo=ZoneInfo(timezone_name))
    return local.astimezone(timezone.utc)


def _scheduled_events(events: list[dict[str, Any]], start: datetime, end: datetime, timezone_name: str) -> list[dict[str, Any]]:
    local_start = start.astimezone(ZoneInfo(timezone_name)).date()
    local_end = end.astimezone(ZoneInfo(timezone_name)).date()
    scheduled: list[dict[str, Any]] = []
    day = datetime.combine(local_start, time.min, tzinfo=ZoneInfo(timezone_name))
    while day.date() <= local_end:
        for event in events:
            timestamp = _event_timestamp(event, day, timezone_name)
            if timestamp is not None and start <= timestamp <= end:
                scheduled.append({**event, "timestamp": timestamp})
        day += timedelta(days=1)
    return sorted(scheduled, key=lambda event: event["timestamp"])


def _ssl_snapshot(bars: list[dict[str, Any]], index: int, period: int = 9) -> dict[str, Any]:
    if index < period - 1:
        return {"up": None, "down": None, "bullish": None}
    direction = 1
    high = low = 0.0
    for current_index in range(period - 1, index + 1):
        window = bars[current_index - period + 1 : current_index + 1]
        high = sum(_number(bar.get("high")) for bar in window) / period
        low = sum(_number(bar.get("low")) for bar in window) / period
        close = _number(bars[current_index].get("close"))
        if close > high:
            direction = 1
        elif close < low:
            direction = -1
    return {"up": high if direction >= 0 else low, "down": low if direction >= 0 else high, "bullish": direction >= 0}


def _rsi_snapshot(bars: list[dict[str, Any]], index: int, period: int = 14) -> float | None:
    if index < period:
        return None
    changes = [_number(bars[position].get("close")) - _number(bars[position - 1].get("close")) for position in range(1, index + 1)]
    window = changes[index - period : index]
    gains = sum(max(change, 0) for change in window) / period
    losses = sum(max(-change, 0) for change in window) / period
    return 100.0 if losses == 0 else 100.0 - (100.0 / (1.0 + gains / losses))


def _tracker_snapshot(bars: list[dict[str, Any]], index: int, lookback: int = 5) -> dict[str, float] | None:
    if index < lookback:
        return None
    window = bars[index - lookback : index]
    return {"h2": max(_number(bar.get("high")) for bar in window), "h1": max(max(_number(bar.get("open")), _number(bar.get("close"))) for bar in window), "l1": min(min(_number(bar.get("open")), _number(bar.get("close"))) for bar in window), "l2": min(_number(bar.get("low")) for bar in window)}


def _bar_context(bars: list[dict[str, Any]], index: int, ssl_period: int) -> dict[str, Any]:
    bar = bars[index]
    ssl = _ssl_snapshot(bars, index, ssl_period)
    return {
        "index": index,
        "time": int(_number(bar.get("time"))),
        "open": _number(bar.get("open")),
        "high": _number(bar.get("high")),
        "low": _number(bar.get("low")),
        "close": _number(bar.get("close")),
        "ssl": ssl,
        "rsi": _rsi_snapshot(bars, index),
        "tracker": _tracker_snapshot(bars, index),
    }


def run_storycard_backtest(
    *,
    bars: list[dict[str, Any]],
    symbol: str,
    storycard: dict[str, Any],
    timezone_name: str = "UTC",
    fee_rate: float = 0.0014,
    ssl_period: int = 9,
) -> dict[str, Any]:
    """Run scheduled events against OHLC bars using conservative stop-first fills."""
    ordered = sorted(bars, key=lambda bar: int(_number(bar.get("time"))))
    if not ordered:
        raise ValueError("No hay velas históricas para ejecutar el backtest.")
    start = datetime.fromtimestamp(_number(ordered[0].get("time")), tz=timezone.utc)
    end = datetime.fromtimestamp(_number(ordered[-1].get("time")), tz=timezone.utc)
    events = storycard.get("events", []) if isinstance(storycard.get("events", []), list) else []
    scheduled = _scheduled_events([event for event in events if isinstance(event, dict)], start, end, timezone_name)
    event_index = 0
    event_log: list[dict[str, Any]] = []
    trades: list[dict[str, Any]] = []
    position: dict[str, Any] | None = None
    trade_sequence = 0

    def close_position(close_time: int, close_price: float, reason: str, context: dict[str, Any]) -> None:
        nonlocal position
        if position is None:
            return
        direction = 1 if position["side"] == "LONG" else -1
        gross = (close_price - position["entry_price"]) * direction * position["quantity"]
        fees = position["notional"] * fee_rate
        position.update({"exit_time": close_time, "exit_price": close_price, "close_reason": reason, "gross_pnl": gross, "fees": fees, "net_pnl": gross - fees, "exit_context": context})
        trades.append(position)
        position = None

    for index, bar in enumerate(ordered):
        bar_context = _bar_context(ordered, index, ssl_period)
        bar_time = int(bar_context["time"])
        while event_index < len(scheduled) and int(scheduled[event_index]["timestamp"].timestamp()) <= bar_time:
            event = scheduled[event_index]
            event_index += 1
            action = str(event.get("action", "observe")).lower()
            event_context = {"event_id": event.get("id", f"event-{event_index}"), "action": action, "timestamp": bar_time, "price": bar_context["open"], "market": bar_context}
            if action in {"open_long", "open_short"} and position is None:
                side = "LONG" if action == "open_long" else "SHORT"
                direction = 1 if side == "LONG" else -1
                entry_price = bar_context["open"]
                stop_percent = abs(_number(event.get("sl_percent"), 0.2))
                target_percent = abs(_number(event.get("tp_percent"), 1.0))
                risk_usdt = _number(event.get("risk_usdt"), 1.0)
                notional = _number(event.get("notional"), risk_usdt / (stop_percent / 100) if stop_percent > 0 else 0)
                leverage = _number(event.get("leverage"), 1.0)
                trade_sequence += 1
                position = {"id": f"bt-{trade_sequence}", "symbol": symbol.upper(), "side": side, "entry_time": bar_time, "entry_price": entry_price, "stop_price": entry_price * (1 - direction * stop_percent / 100), "target_price": entry_price * (1 + direction * target_percent / 100), "stop_percent": stop_percent, "target_percent": target_percent, "risk_usdt": risk_usdt, "notional": notional, "margin": notional / leverage if leverage > 0 else notional, "leverage": leverage, "quantity": notional / entry_price if entry_price > 0 else 0}
                event_context["position_id"] = position["id"]
            elif action in {"close", "close_all", "close_position"} and position is not None:
                close_position(bar_time, bar_context["open"], "EVENT", bar_context)
            event_log.append(event_context)
        if position is not None:
            stop_hit = bar_context["low"] <= position["stop_price"] if position["side"] == "LONG" else bar_context["high"] >= position["stop_price"]
            target_hit = bar_context["high"] >= position["target_price"] if position["side"] == "LONG" else bar_context["low"] <= position["target_price"]
            if stop_hit:
                close_position(bar_time, position["stop_price"], "SL", bar_context)
            elif target_hit:
                close_position(bar_time, position["target_price"], "TP", bar_context)
    if position is not None:
        close_position(int(_number(ordered[-1].get("time"))), _number(ordered[-1].get("close")), "END_OF_TEST", _bar_context(ordered, len(ordered) - 1, ssl_period))

    net_pnl = sum(_number(trade.get("net_pnl")) for trade in trades)
    wins = [trade for trade in trades if _number(trade.get("net_pnl")) > 0]
    losses = [trade for trade in trades if _number(trade.get("net_pnl")) < 0]
    equity = peak = drawdown = 0.0
    for trade in sorted(trades, key=lambda item: int(item["entry_time"])):
        equity += _number(trade.get("net_pnl"))
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
    return {"mode": "paper", "symbol": symbol.upper(), "days": MAX_BACKTEST_DAYS, "timezone": timezone_name, "bars": len(ordered), "event_count": len(event_log), "scheduled_event_count": len(scheduled), "events": event_log, "trades": trades, "statistics": {"operations": len(trades), "wins": len(wins), "losses": len(losses), "win_rate": len(wins) / len(trades) * 100 if trades else 0.0, "net_pnl": net_pnl, "profit_factor": sum(_number(trade.get("net_pnl")) for trade in wins) / abs(sum(_number(trade.get("net_pnl")) for trade in losses)) if losses else (float("inf") if wins else 0.0), "average_win": sum(_number(trade.get("net_pnl")) for trade in wins) / len(wins) if wins else 0.0, "average_loss": sum(_number(trade.get("net_pnl")) for trade in losses) / len(losses) if losses else 0.0, "max_drawdown": -drawdown}, "context": {"first_bar": _bar_context(ordered, 0, ssl_period), "last_bar": _bar_context(ordered, len(ordered) - 1, ssl_period), "ssl_period": ssl_period, "fee_rate": fee_rate}}


async def fetch_binance_history(*, symbol: str, interval: str, days: int = MAX_BACKTEST_DAYS, base_url: str = "https://fapi.binance.com") -> list[dict[str, Any]]:
    """Fetch a complete bounded range, paginating Binance's 1,500-kline limit."""
    days = max(1, min(int(days), MAX_BACKTEST_DAYS))
    interval_ms = {"1m": 60_000, "5m": 300_000, "15m": 900_000}.get(interval)
    if interval_ms is None:
        raise ValueError("Intervalo no soportado para backtest.")
    end_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    start_ms = end_ms - days * 86_400_000
    rows: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=20) as client:
        cursor = start_ms
        while cursor < end_ms:
            response = await client.get(f"{base_url}/fapi/v1/klines", params={"symbol": symbol.upper(), "interval": interval, "startTime": cursor, "endTime": end_ms, "limit": BINANCE_KLINE_LIMIT})
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list) or not payload:
                break
            for row in payload:
                if isinstance(row, list) and len(row) >= 5:
                    rows.append({"time": int(_number(row[0]) / 1000), "open": _number(row[1]), "high": _number(row[2]), "low": _number(row[3]), "close": _number(row[4]), "closed": True})
            last_time = int(_number(payload[-1][0]))
            next_cursor = last_time + interval_ms
            if next_cursor <= cursor:
                break
            cursor = next_cursor
    unique = {int(row["time"]): row for row in rows}
    return [unique[key] for key in sorted(unique)]
