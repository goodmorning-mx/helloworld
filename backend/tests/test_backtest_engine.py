from datetime import datetime, timezone

import asyncio
import time

from app import backtest_engine
from app.backtest_engine import run_storycard_backtest


def bars(prices: list[tuple[float, float, float, float]]) -> list[dict[str, float]]:
    start = int(datetime(2026, 9, 7, 13, 0, tzinfo=timezone.utc).timestamp())
    return [
        {"time": start + index * 300, "open": open_price, "high": high, "low": low, "close": close}
        for index, (open_price, high, low, close) in enumerate(prices)
    ]


def test_storycard_opens_and_closes_at_take_profit_with_event_context():
    result = run_storycard_backtest(
        bars=bars([(100, 100.1, 99.9, 100), (100, 101.2, 100.2, 101), (101, 101, 100.5, 100.8)]),
        symbol="BTCUSDT",
        timezone_name="America/Mexico_City",
        storycard={"events": [{"id": "monday-open", "weekday": "monday", "time": "07:00", "action": "open_long", "sl_percent": 0.2, "tp_percent": 1.0, "notional": 100}]},
        fee_rate=0,
    )
    assert result["days"] == 7
    assert result["event_count"] == 1
    assert result["events"][0]["event_id"] == "monday-open"
    assert result["trades"][0]["close_reason"] == "TP"
    assert result["statistics"]["wins"] == 1
    assert result["statistics"]["win_rate"] == 100


def test_storycard_stop_is_conservative_when_stop_and_target_share_a_bar():
    result = run_storycard_backtest(
        bars=bars([(100, 100.5, 99.5, 100), (100, 101.2, 99.7, 100.2)]),
        symbol="BTCUSDT",
        timezone_name="America/Mexico_City",
        storycard={"events": [{"weekday": "monday", "time": "07:00", "action": "open_long", "sl_percent": 0.2, "tp_percent": 1.0, "notional": 100}]},
        fee_rate=0,
    )
    assert result["trades"][0]["close_reason"] == "SL"
    assert result["statistics"]["losses"] == 1


def test_storycard_honors_close_event_and_reports_event_counter():
    result = run_storycard_backtest(
        bars=bars([(100, 100.1, 99.9, 100), (100, 100.1, 99.8, 100.1), (100.1, 100.2, 99.9, 100)]),
        symbol="BTCUSDT",
        timezone_name="America/Mexico_City",
        storycard={"events": [{"weekday": "monday", "time": "07:00", "action": "open_short", "sl_percent": 0.2, "tp_percent": 1.0, "notional": 100}, {"weekday": "monday", "time": "07:10", "action": "close_all"}]},
        fee_rate=0,
    )
    assert result["event_count"] == 2
    assert result["scheduled_event_count"] == 2
    assert result["trades"][0]["close_reason"] == "EVENT"


def test_binance_history_excludes_current_unclosed_candle(monkeypatch):
    now_ms = int(time.time() * 1000)
    closed_time = now_ms - 120_000
    open_time = now_ms - 30_000
    rows = [
        [closed_time, "100", "101", "99", "100.5", "1", closed_time + 59_999],
        [open_time, "100.5", "102", "100", "101", "1", open_time + 59_999],
    ]

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return rows

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, *args, **kwargs):
            return Response()

    monkeypatch.setattr(backtest_engine.httpx, "AsyncClient", Client)
    result = asyncio.run(backtest_engine.fetch_binance_history(symbol="BTCUSDT", interval="1m", days=1))

    assert [bar["time"] for bar in result] == [closed_time // 1000]
