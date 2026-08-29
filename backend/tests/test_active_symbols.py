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
