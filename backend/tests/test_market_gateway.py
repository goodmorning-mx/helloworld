from app.market_gateway import BinanceMarketGateway, SUPPORTED_INTERVALS
import asyncio


def test_binance_gateway_uses_one_trade_stream_and_all_candle_intervals() -> None:
    url = BinanceMarketGateway._stream_url("BTCUSDT")

    assert "btcusdt@aggTrade" in url
    assert "btcusdt@markPrice@1s" in url
    for interval in SUPPORTED_INTERVALS:
        assert f"btcusdt@kline_{interval}" in url


def test_slow_async_market_listener_does_not_block_websocket_fanout() -> None:
    class Client:
        def __init__(self):
            self.messages = []

        async def send_text(self, value):
            self.messages.append(value)

    async def scenario():
        gateway = BinanceMarketGateway()
        client = Client()
        gateway._clients["BTCUSDT"].add(client)
        finished = asyncio.Event()

        async def slow_listener(_payload):
            await asyncio.sleep(0.15)
            finished.set()

        gateway.add_listener("BTCUSDT", slow_listener)
        started = asyncio.get_running_loop().time()
        await gateway._broadcast("BTCUSDT", {"type": "trade", "symbol": "BTCUSDT"})
        elapsed = asyncio.get_running_loop().time() - started
        assert elapsed < 0.1
        assert len(client.messages) == 1
        await asyncio.wait_for(finished.wait(), timeout=0.5)

    asyncio.run(scenario())
