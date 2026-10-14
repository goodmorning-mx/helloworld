import asyncio
import time

from app import main
from app.scanner_cache import ScannerCache


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
                    [latest - (19 - index) * 60_000, "100", "102", "99", str(100 + index / 10), "0", latest - (19 - index) * 60_000 + 59_999]
                    for index in range(20)
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
    monkeypatch.setattr(main.time, "time", lambda: now_seconds[0])
    monkeypatch.setattr(main, "_scanner_cache", ScannerCache(refresh_seconds=0))
    monkeypatch.setattr(main.httpx, "AsyncClient", Client)
    main._scanner_analysis_states.clear()

    async def scenario():
        first = await main.binance_scanner_analysis(symbols="BTCUSDT", tracker_period=2, limit=100, movement_averages="0.5", identity=None)
        second = await main.binance_scanner_analysis(symbols="BTCUSDT", tracker_period=2, limit=100, movement_averages="0.5", identity=None)
        now_seconds[0] += 60
        third = await main.binance_scanner_analysis(symbols="BTCUSDT", tracker_period=2, limit=100, movement_averages="0.5", identity=None)
        fourth = await main.binance_scanner_analysis(symbols="BTCUSDT", tracker_period=2, limit=100, movement_averages="0.5", identity=None)
        return first, second, third, fourth

    first, second, third, fourth = asyncio.run(scenario())
    assert len(Client.calls) == 4
    assert Client.calls[0]["limit"] == 100
    assert "startTime" not in Client.calls[0]
    assert Client.calls[1]["startTime"] == int(first["symbols"][0]["last_bar_time"]) * 1000 - 60_000
    assert first["symbols"][0]["status"] == "VALID"
    assert second["symbols"][0]["status"] == "VALID"
    assert second["symbols"][0]["bars"] == first["symbols"][0]["bars"] + 1
    assert third["symbols"][0]["status"] == "STALE"
    assert third["symbols"][0]["error"] == "temporary network failure"
    assert third["symbols"][0]["tp_optimal_percent"] == second["symbols"][0]["tp_optimal_percent"]
    assert fourth["symbols"][0]["status"] == "VALID"
    assert "error" not in fourth["symbols"][0]
