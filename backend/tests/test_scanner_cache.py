import asyncio
import time

from app import main
from app.scanner_cache import SCANNER_ANALYSIS_MAX_BARS, SCANNER_ANALYSIS_WINDOW_SECONDS, ScannerCache


def _fake_walk_forward(bars, config, snapshot_hours, evaluation_hours, _profiling, target_override=None, _include_operations=False):
    split_index = max(1, len(bars) // 2)
    target = float(target_override if target_override is not None else 1.25)
    snapshot = {
        "operations": 3, "wins": 2, "losses": 1, "win_rate": 66.7,
        "average_duration_minutes": 2.0, "equity_final": config.initial_balance + 3.5,
        "final_result_usdt": 3.5, "max_balance": config.initial_balance + 4,
        "min_balance": config.initial_balance - 1, "loss_limit_percent": 4.0,
        "tp_optimal_percent": target, "tracker_period": config.tracker_period,
        "stop_percent": config.stop_percent, "start_time": bars[0]["time"],
        "last_bar_time": bars[split_index - 1]["time"], "bars": split_index,
    }
    forward = {
        "operations": 1, "wins": 1, "losses": 0, "win_rate": 100.0,
        "average_duration_minutes": 1.0, "equity_final": config.initial_balance + target,
        "final_result_usdt": target, "max_balance": config.initial_balance + target,
        "min_balance": config.initial_balance, "loss_limit_percent": 4.0,
        "tp_optimal_percent": target, "tracker_period": config.tracker_period,
        "stop_percent": config.stop_percent, "start_time": bars[split_index]["time"],
        "last_bar_time": bars[-1]["time"], "bars": len(bars) - split_index,
    }
    return {
        "snapshot": snapshot, "forward": forward, "split_time": bars[split_index]["time"],
        "snapshot_hours": snapshot_hours, "evaluation_hours": evaluation_hours,
        "parameters": {"tp_optimal_percent": target, "loss_limit_percent": 4.0,
                       "tracker_period": config.tracker_period, "stop_percent": config.stop_percent,
                       "initial_balance": config.initial_balance, "risk_percent": config.risk_percent,
                       "leverage": config.leverage, "source": "SNAPSHOT_OPTIMIZED"},
        "bars": len(bars),
    }


def _fake_forward_details(_bars, config, *, split_time, target_percent, loss_limit_percent):
    return {
        "operation_details": [{"entry_time": split_time, "pnl": target_percent, "status": "WIN"}],
        "operations": 1, "wins": 1, "losses": 0, "win_rate": 100.0,
        "average_duration_minutes": 1.0, "equity_final": config.initial_balance + target_percent,
        "final_result_usdt": target_percent, "max_balance": config.initial_balance + target_percent,
        "min_balance": config.initial_balance, "loss_limit_percent": loss_limit_percent,
        "last_bar_time": split_time + 60,
    }


def test_refresh_bars_shares_in_flight_request_and_merges_incrementally() -> None:
    async def scenario() -> None:
        cache = ScannerCache(refresh_seconds=0)
        calls = 0

        async def loader(existing):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.01)
            if not existing:
                return [{"time": 60, "close": 1.0}, {"time": 120, "close": 2.0}]
            return [{"time": 120, "close": 2.1}, {"time": 180, "close": 3.0}]

        first, second = await asyncio.gather(
            cache.refresh_bars("BTCUSDT", loader),
            cache.refresh_bars("btcusdt", loader),
        )
        assert calls == 1
        assert first[0] == second[0]
        assert [bar["time"] for bar in first[0]] == [60, 120]

        refreshed, error, changed = await cache.refresh_bars("BTCUSDT", loader)
        assert error is None
        assert changed is True
        assert refreshed == [
            {"time": 60, "close": 1.0},
            {"time": 120, "close": 2.1},
            {"time": 180, "close": 3.0},
        ]

    asyncio.run(scenario())


def test_refresh_bars_returns_cached_snapshot_after_upstream_failure() -> None:
    async def scenario() -> None:
        cache = ScannerCache(refresh_seconds=0)

        async def initial(_existing):
            return [{"time": 60, "close": 1.0}]

        async def failing(_existing):
            raise RuntimeError("upstream unavailable")

        await cache.refresh_bars("ETHUSDT", initial)
        bars, error, changed = await cache.refresh_bars("ETHUSDT", failing)
        assert bars == [{"time": 60, "close": 1.0}]
        assert error == "upstream unavailable"
        assert changed is False

    asyncio.run(scenario())


def test_refresh_bars_skips_symbols_with_no_new_closed_bar() -> None:
    async def scenario() -> None:
        cache = ScannerCache(refresh_seconds=0)
        calls = 0

        async def loader(_existing):
            nonlocal calls
            calls += 1
            return [{"time": 120 if not _existing else 180, "close": 2.0}]

        first, error, _changed = await cache.refresh_bars("BTCUSDT", loader)
        assert error is None
        assert first[-1]["time"] == 120

        unchanged, error, changed = await cache.refresh_bars(
            "BTCUSDT", loader, refresh_if=lambda bars: not bars or bars[-1]["time"] < 120
        )
        assert error is None
        assert changed is False
        assert unchanged == first
        assert calls == 1

        refreshed, error, changed = await cache.refresh_bars(
            "BTCUSDT", loader, refresh_if=lambda bars: not bars or bars[-1]["time"] < 180
        )
        assert error is None
        assert changed is True
        assert refreshed[-1]["time"] == 180
        assert calls == 2

    asyncio.run(scenario())


def test_refresh_bars_backfills_when_requested_window_grows() -> None:
    async def scenario() -> None:
        cache = ScannerCache(refresh_seconds=60)
        calls = 0

        async def loader(existing):
            nonlocal calls
            calls += 1
            if not existing:
                return [{"time": 900, "close": 9.0}]
            return [{"time": timestamp, "close": float(timestamp)} for timestamp in range(600, 961, 60)]

        await cache.refresh_bars("BTCUSDT", loader)
        bars, error, changed = await cache.refresh_bars(
            "BTCUSDT", loader,
            refresh_if=lambda current: not current or current[0]["time"] > 600,
        )

        assert calls == 2
        assert error is None
        assert changed is True
        assert bars[0]["time"] == 600
        assert bars[-1]["time"] == 960

    asyncio.run(scenario())


def test_bar_cache_evicts_least_recently_used_symbols() -> None:
    async def scenario() -> None:
        cache = ScannerCache(max_symbols=2, refresh_seconds=0)
        requested = []

        async def loader_for(symbol):
            async def loader(existing):
                requested.append((symbol, bool(existing)))
                return [{"time": 60, "close": 1.0}]
            return loader

        for symbol in ("BTCUSDT", "ETHUSDT", "SOLUSDT"):
            await cache.refresh_bars(symbol, await loader_for(symbol))
        # BTC was the least recently used entry and has been evicted.
        await cache.refresh_bars("BTCUSDT", await loader_for("BTCUSDT"))

        assert requested[-1] == ("BTCUSDT", False)

    asyncio.run(scenario())


def test_bar_cache_expires_symbol_and_analyses_after_retention_window() -> None:
    async def scenario() -> None:
        cache = ScannerCache(refresh_seconds=0, retention_seconds=0.01)

        async def loader(existing):
            assert existing == []
            return [{"time": 120, "close": 2.0}]

        async def calculate():
            return {"tp_optimal_percent": 1.2}

        await cache.refresh_bars("BTCUSDT", loader)
        await cache.remember_analysis("BTCUSDT", (5, 0.2), 120, await calculate())
        await asyncio.sleep(0.02)

        bars, error, changed = await cache.refresh_bars("BTCUSDT", loader)

        assert error is None
        assert changed is True
        assert bars == [{"time": 120, "close": 2.0}]
        assert await cache.latest_analysis("BTCUSDT", (5, 0.2)) is None

    asyncio.run(scenario())


def test_analysis_cache_uses_closed_bar_timestamp_and_deduplicates_work() -> None:
    async def scenario() -> None:
        cache = ScannerCache()
        calls = 0

        async def calculate():
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.01)
            return {"tp_optimal_percent": 1.2}

        first, second = await asyncio.gather(
            cache.analyze_once("BTCUSDT", (5, 0.2), 120, calculate),
            cache.analyze_once("BTCUSDT", (5, 0.2), 120, calculate),
        )
        assert calls == 1
        assert first == second == {"tp_optimal_percent": 1.2}
        assert await cache.cached_analysis("BTCUSDT", (5, 0.2), 120) == first
        assert await cache.cached_analysis("BTCUSDT", (5, 0.2), 180) is None

    asyncio.run(scenario())


def test_selected_tracker_analyses_share_work_and_keep_a_bounded_detail_cache() -> None:
    async def scenario() -> None:
        cache = ScannerCache()
        cache.max_selected_analyses = 1
        calls = 0

        async def calculate():
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.01)
            return {"final_result_usdt": 2.5, "operation_details": [{"pnl": 2.5}]}

        first, second = await asyncio.gather(
            cache.selected_analysis_once("BTCUSDT", (5, 0.2, 1.5), 120, calculate),
            cache.selected_analysis_once("BTCUSDT", (5, 0.2, 1.5), 120, calculate),
        )
        assert calls == 1
        assert first[0] == second[0]
        cached, cache_hit = await cache.selected_analysis_once("BTCUSDT", (5, 0.2, 1.5), 120, calculate)
        assert cache_hit is True
        assert cached == first[0]

        async def another():
            return {"final_result_usdt": 4.0, "operation_details": []}

        await cache.selected_analysis_once("ETHUSDT", (5, 0.2, 1.5), 120, another)
        assert len(cache._selected_analyses) == 1
        assert len(cache._selected_analysis_saved_at) == 1

    asyncio.run(scenario())


def test_scanner_endpoint_fetches_only_new_closed_candles(monkeypatch) -> None:
    class Response:
        def __init__(self, rows):
            self.rows = rows

        def raise_for_status(self):
            return None

        def json(self):
            return self.rows

    class Client:
        calls = []
        second_rows = []

        def __init__(self, timeout):
            assert timeout == 15

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, params):
            self.calls.append(dict(params))
            if len(self.calls) == 3:
                raise RuntimeError("temporary network failure")
            now_ms = int(now_seconds[0] * 1000)
            if len(self.calls) == 1:
                latest = (now_ms // 60_000 - 2) * 60_000
                rows = [
                    [latest - (119 - index) * 60_000, "100", "102", "99", str(100 + index / 10), "0", latest - (119 - index) * 60_000 + 59_999]
                    for index in range(120)
                ]
                # Include the currently forming candle; the scanner must ignore it.
                rows.append([latest + 120_000, "102", "103", "101", "102", "0", latest + 179_999])
                return Response(rows)
            base = self.calls[-1]["startTime"]
            self.second_rows = [
                [base + 60_000, "101", "103", "100", "102", "0", base + 119_999],
                [base + 120_000, "102", "104", "101", "103", "0", base + 179_999],
            ]
            return Response(self.second_rows)

    now_seconds = [int(time.time() // 60 * 60) + 5]
    expected_window_start = ((now_seconds[0] - 2 * 60 * 60) // 60 * 60) * 1000
    monkeypatch.setattr(main.time, "time", lambda: now_seconds[0])
    monkeypatch.setattr(main, "_scanner_cache", ScannerCache(max_bars=SCANNER_ANALYSIS_MAX_BARS, refresh_seconds=0))
    monkeypatch.setattr(main.httpx, "AsyncClient", Client)
    monkeypatch.setattr(main, "analyze_walk_forward", _fake_walk_forward)
    monkeypatch.setattr(main, "analyze_tracker_forward_operations", _fake_forward_details)
    main._scanner_analysis_states.clear()

    async def scenario():
        first = await main.binance_scanner_analysis(symbols="BTCUSDT", tracker_period=2, hours=1, limit=100, movement_averages="0.5", identity=None)
        second = await main.binance_scanner_analysis(symbols="BTCUSDT", tracker_period=2, hours=1, limit=100, movement_averages="0.5", identity=None)
        now_seconds[0] += 60
        third = await main.binance_scanner_analysis(symbols="BTCUSDT", tracker_period=2, hours=1, limit=100, movement_averages="0.5", identity=None)
        fourth = await main.binance_scanner_analysis(symbols="BTCUSDT", tracker_period=2, hours=1, limit=100, movement_averages="0.5", identity=None)
        return first, second, third, fourth

    first, second, third, fourth = asyncio.run(scenario())
    assert len(Client.calls) == 4
    assert Client.calls[0]["limit"] == 120
    assert Client.calls[0]["startTime"] == expected_window_start
    assert Client.calls[1]["startTime"] == int(first["symbols"][0]["last_bar_time"]) * 1000 - 60_000
    assert first["symbols"][0]["status"] == "VALID"
    assert second["symbols"][0]["status"] == "VALID"
    assert second["symbols"][0]["bars"] == first["symbols"][0]["bars"] + 1
    assert third["symbols"][0]["status"] == "STALE"
    assert third["symbols"][0]["error"] == "temporary network failure"
    assert third["symbols"][0]["tp_optimal_percent"] == second["symbols"][0]["tp_optimal_percent"]
    assert fourth["symbols"][0]["status"] == "VALID"
    assert "error" not in fourth["symbols"][0]

    detail = asyncio.run(main.binance_scanner_analysis(
        symbols="BTCUSDT", tracker_period=2, hours=1, limit=100, movement_averages="0.5",
        leverage=10, include_operations=True, target_percent=2.75, identity=None,
    ))
    assert detail["config"]["leverage"] == 10
    assert detail["window_seconds"] == 2 * 60 * 60
    assert detail["symbols"][0]["operations"] == len(detail["symbols"][0]["operation_details"])
    assert detail["symbols"][0]["tp_optimal_percent"] == 2.75
    detail_row = detail["symbols"][0]
    assert abs(sum(operation["pnl"] for operation in detail_row["operation_details"]) - detail_row["final_result_usdt"]) < 1e-8

    summary = asyncio.run(main.binance_scanner_analysis(
        symbols="BTCUSDT", tracker_period=2, hours=1, limit=100, movement_averages="0.5",
        leverage=10, include_operations=False, target_percent=2.75, identity=None,
    ))["symbols"][0]
    assert summary["tp_optimal_percent"] == detail_row["tp_optimal_percent"]
    assert summary["operations"] == detail_row["operations"]
    assert summary["wins"] == detail_row["wins"]
    assert summary["losses"] == detail_row["losses"]
    assert summary["equity_final"] == detail_row["equity_final"]
    assert summary["final_result_usdt"] == detail_row["final_result_usdt"]
    assert summary["max_balance"] == detail_row["max_balance"]
    assert summary["min_balance"] == detail_row["min_balance"]
    assert "operation_details" not in summary


def test_scanner_cold_loads_snapshot_and_forward_window_in_one_page(monkeypatch) -> None:
    class Response:
        def __init__(self, rows):
            self.rows = rows

        def raise_for_status(self):
            return None

        def json(self):
            return self.rows

    now_seconds = int(time.time() // 60 * 60) + 5
    window_start = (now_seconds - SCANNER_ANALYSIS_WINDOW_SECONDS) // 60 * 60

    class Client:
        calls = []

        def __init__(self, timeout):
            assert timeout == 15

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, _url, params):
            self.calls.append(dict(params))
            start = int(params["startTime"] / 1000)
            count = int(params["limit"])
            rows = [[(start + index * 60) * 1000, "100", "101", "99", "100", "0", (start + index * 60) * 1000 + 59_999] for index in range(count)]
            return Response(rows)

    monkeypatch.setattr(main.time, "time", lambda: now_seconds)
    monkeypatch.setattr(main, "_scanner_cache", ScannerCache(max_bars=SCANNER_ANALYSIS_MAX_BARS, refresh_seconds=0))
    monkeypatch.setattr(main.httpx, "AsyncClient", Client)
    monkeypatch.setattr(main, "analyze_walk_forward", _fake_walk_forward)

    payload = asyncio.run(main.binance_scanner_analysis(symbols="BTCUSDT", limit=480, movement_averages="", identity=None))
    assert len(Client.calls) == 1
    assert Client.calls[0]["startTime"] == window_start * 1000
    assert Client.calls[0]["limit"] == SCANNER_ANALYSIS_MAX_BARS
    assert payload["symbols"][0]["bars"] == SCANNER_ANALYSIS_MAX_BARS
    assert payload["symbols"][0]["snapshot_final_result_usdt"] == 3.5
    assert payload["symbols"][0]["forward_final_result_usdt"] == 1.25
    assert payload["window_seconds"] == SCANNER_ANALYSIS_WINDOW_SECONDS


def test_scanner_window_is_selectable_and_cache_backfills_when_hours_increase(monkeypatch) -> None:
    now_seconds = int(time.time() // 60 * 60) + 5
    calls = []

    class Response:
        def __init__(self, rows):
            self.rows = rows

        def raise_for_status(self):
            return None

        def json(self):
            return self.rows

    class Client:
        def __init__(self, timeout):
            assert timeout == 15

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, _url, params):
            calls.append(dict(params))
            start_ms = int(params["startTime"])
            count = int(params["limit"])
            rows = [
                [start_ms + index * 60_000, "100", "101", "99", "100", "0", start_ms + index * 60_000 + 59_999]
                for index in range(count)
            ]
            return Response(rows)

    monkeypatch.setattr(main.time, "time", lambda: now_seconds)
    monkeypatch.setattr(main, "_scanner_cache", ScannerCache(max_bars=SCANNER_ANALYSIS_MAX_BARS, refresh_seconds=60))
    monkeypatch.setattr(main.httpx, "AsyncClient", Client)
    monkeypatch.setattr(main, "analyze_walk_forward", _fake_walk_forward)

    async def scenario():
        short = await main.binance_scanner_analysis(symbols="BTCUSDT", hours=1, movement_averages="", identity=None)
        wide = await main.binance_scanner_analysis(symbols="BTCUSDT", hours=2, movement_averages="", identity=None)
        return short, wide

    short, wide = asyncio.run(scenario())
    assert len(calls) == 2
    assert calls[0]["limit"] == 120
    assert calls[1]["limit"] == 240
    assert calls[1]["startTime"] == ((now_seconds - 4 * 60 * 60) // 60 * 60) * 1000
    assert short["snapshot_hours"] == short["evaluation_hours"] == 1
    assert short["window_seconds"] == 2 * 60 * 60
    assert wide["snapshot_hours"] == wide["evaluation_hours"] == 2
    assert wide["window_seconds"] == 4 * 60 * 60
