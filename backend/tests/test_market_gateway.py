from app.market_gateway import BinanceMarketGateway


def test_gateway_cache_updates_bars_by_timestamp() -> None:
    gateway = BinanceMarketGateway()
    gateway.put_bars("btcusdt", "1m", [
        {"time": 100, "open": 1, "high": 2, "low": 1, "close": 1.5},
        {"time": 160, "open": 1.5, "high": 2.5, "low": 1.4, "close": 2},
    ])
    gateway.put_bars("BTCUSDT", "1m", [
        {"time": 160, "open": 1.5, "high": 3, "low": 1.4, "close": 2.8},
    ])

    bars = gateway.snapshot("BTCUSDT", "1m")
    assert [bar["time"] for bar in bars] == [100, 160]
    assert bars[-1]["high"] == 3
    assert bars[-1]["close"] == 2.8


def test_gateway_uses_one_multiplexed_futures_stream_per_symbol() -> None:
    assert "fstream.binance.com" in BinanceMarketGateway._stream_url("ETHUSDT")
    assert "ethusdt@kline_1m" in BinanceMarketGateway._stream_url("ETHUSDT")
    assert "ethusdt@kline_5m" in BinanceMarketGateway._stream_url("ETHUSDT")
