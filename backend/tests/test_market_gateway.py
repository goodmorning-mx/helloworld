from app.market_gateway import BinanceMarketGateway, SUPPORTED_INTERVALS


def test_binance_gateway_uses_one_trade_stream_and_all_candle_intervals() -> None:
    url = BinanceMarketGateway._stream_url("BTCUSDT")

    assert "btcusdt@aggTrade" in url
    assert "btcusdt@markPrice@1s" in url
    for interval in SUPPORTED_INTERVALS:
        assert f"btcusdt@kline_{interval}" in url
