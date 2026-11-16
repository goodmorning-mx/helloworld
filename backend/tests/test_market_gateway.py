from app.market_gateway import BinanceMarketGateway, MARK_PRICE_MAX_AGE_MS, SUPPORTED_INTERVALS
import asyncio
import time


def test_binance_gateway_uses_one_trade_stream_and_all_candle_intervals() -> None:
    url = BinanceMarketGateway._stream_url("BTCUSDT")

    assert url.startswith("wss://fstream.binance.com/market/stream?")
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


def test_latest_mark_price_is_replayed_to_new_worker_listener() -> None:
    async def scenario():
        gateway = BinanceMarketGateway()
        received = []
        await gateway._publish_mark_price("BTCUSDT", 67500.25, int(time.time() * 1000), "mark-price-stream")
        gateway.add_listener("BTCUSDT", received.append)
        assert len(received) == 1
        assert received[0]["price"] == 67500.25
        assert received[0]["source"] == "mark-price-stream"
        assert gateway.latest_price("BTCUSDT")["price"] == 67500.25
        await gateway.close()

    asyncio.run(scenario())


def test_mark_price_fallback_runs_even_while_klines_are_live(monkeypatch) -> None:
    async def scenario():
        gateway = BinanceMarketGateway()
        received = []
        gateway._listeners["BTCUSDT"].add(received.append)
        # Recent market events represent a healthy kline stream. There has been
        # no mark update, so the separate mark freshness check must still poll.
        gateway._last_event_ms["BTCUSDT"] = int(time.time() * 1000)
        gateway._connected_at_ms["BTCUSDT"] = int(time.time() * 1000) - MARK_PRICE_MAX_AGE_MS - 1
        requests = []
        closed_sockets = []

        class SilentSocket:
            async def close(self, **kwargs):
                closed_sockets.append(kwargs)

        gateway._sockets["BTCUSDT"] = SilentSocket()

        class Response:
            def raise_for_status(self):
                return None

            def json(self):
                return {"markPrice": "67501.5", "time": int(time.time() * 1000)}

        class Client:
            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def get(self, url, **_kwargs):
                requests.append(url)
                return Response()

        original_sleep = asyncio.sleep
        sleeps = 0

        async def skip_wait(_seconds):
            nonlocal sleeps
            sleeps += 1
            if sleeps > 1:
                gateway._last_mark_ws_event_ms["BTCUSDT"] = int(time.time() * 1000)
                gateway._listeners["BTCUSDT"].clear()
            await original_sleep(0)

        monkeypatch.setattr("app.market_gateway.httpx.AsyncClient", Client)
        monkeypatch.setattr("app.market_gateway.asyncio.sleep", skip_wait)
        await gateway._rest_fallback("BTCUSDT")
        assert requests == ["https://fapi.binance.com/fapi/v1/premiumIndex"]
        assert received[0]["type"] == "mark_price"
        assert received[0]["source"] == "rest-fallback"
        assert received[0]["price"] == 67501.5
        assert closed_sockets and closed_sockets[0]["reason"] == "mark-price stream silent"
        await gateway.close()

    asyncio.run(scenario())
