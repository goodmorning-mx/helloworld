from app import main


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


def test_active_symbols_filters_and_ranks_public_binance_data(monkeypatch) -> None:
    def fake_get(url, timeout):
        assert timeout == 15
        if url.endswith("exchangeInfo"):
            return FakeResponse({"symbols": [
                {"symbol": "FASTUSDT", "status": "TRADING", "quoteAsset": "USDT", "contractType": "PERPETUAL"},
                {"symbol": "QUIETUSDT", "status": "TRADING", "quoteAsset": "USDT", "contractType": "PERPETUAL"},
                {"symbol": "OLDUSDT", "status": "BREAK", "quoteAsset": "USDT", "contractType": "PERPETUAL"},
            ]})
        return FakeResponse([
            {"symbol": "FASTUSDT", "priceChangePercent": "4.0", "highPrice": "104", "lowPrice": "96", "quoteVolume": "100000000", "count": 200000, "lastPrice": "100"},
            {"symbol": "QUIETUSDT", "priceChangePercent": "0.1", "highPrice": "101", "lowPrice": "99", "quoteVolume": "100000000", "count": 200000, "lastPrice": "100"},
            {"symbol": "OLDUSDT", "priceChangePercent": "50", "highPrice": "150", "lowPrice": "50", "quoteVolume": "100000000", "count": 200000, "lastPrice": "100"},
        ])

    monkeypatch.setattr(main.httpx, "get", fake_get)
    result = main.binance_active_symbols(limit=10, min_quote_volume=50_000_000, min_trades=100_000, min_movement_pct=0.5)

    assert [row["symbol"] for row in result["symbols"]] == ["FASTUSDT"]
    assert result["symbols"][0]["movement_pct"] == 4.0
    assert result["symbols"][0]["range_pct"] == 8 / 96 * 100


def test_active_symbols_ranks_by_accumulated_candle_variation(monkeypatch) -> None:
    candles = [[index * 300_000, "100", str(100 + (index % 4)), str(100 - (index % 2)), str(100 + (index % 3))] for index in range(30)]

    def fake_get(url, timeout):
        assert timeout == 15
        if url.endswith("exchangeInfo"):
            return FakeResponse({"symbols": [{"symbol": "VOLATILEUSDT", "status": "TRADING", "quoteAsset": "USDT", "contractType": "PERPETUAL"}]})
        if "ticker/24hr" in url:
            return FakeResponse([{"symbol": "VOLATILEUSDT", "priceChangePercent": "0.6", "highPrice": "104", "lowPrice": "96", "quoteVolume": "100000000", "count": 200000, "lastPrice": "100"}])
        assert "limit=11" in url
        return FakeResponse(candles)

    monkeypatch.setattr(main.httpx, "get", fake_get)
    result = main.binance_active_symbols(limit=1, min_movement_pct=0.5, horizon=10, interval="5m")
    row = result["symbols"][0]

    assert row["interval"] == "5m"
    assert row["horizon"] == 10
    assert row["variation_sum_pct"] > 0
    assert row["variation_average_pct"] == row["variation_sum_pct"] / 10


def test_active_symbols_reuses_recent_universe_snapshot(monkeypatch) -> None:
    main._active_symbols_cache.clear()
    calls = 0

    def fake_get(url, timeout):
        nonlocal calls
        calls += 1
        if url.endswith("exchangeInfo"):
            return FakeResponse({"symbols": []})
        return FakeResponse([])

    monkeypatch.setattr(main.httpx, "get", fake_get)
    first = main.binance_active_symbols(limit=7, min_movement_pct=0.37)
    second = main.binance_active_symbols(limit=7, min_movement_pct=0.37)

    assert first == second
    assert calls == 2
