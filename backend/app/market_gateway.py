from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import defaultdict
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect

logger = logging.getLogger("helloworld.market_gateway")
SUPPORTED_INTERVALS = ("1m", "3m", "5m", "15m")


class BinanceMarketGateway:
    """One shared Binance Futures stream per symbol with an in-memory cache."""

    def __init__(self) -> None:
        self._bars: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
        self._clients: dict[str, set[WebSocket]] = defaultdict(set)
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def _symbol(symbol: str) -> str:
        return symbol.strip().upper()

    @staticmethod
    def _stream_url(symbol: str) -> str:
        streams = "/".join(f"{symbol.lower()}@kline_{interval}" for interval in SUPPORTED_INTERVALS)
        return f"wss://fstream.binance.com/stream?streams={streams}"

    def snapshot(self, symbol: str, interval: str) -> list[dict[str, Any]]:
        return list(self._bars[self._symbol(symbol)][interval])

    def put_bars(self, symbol: str, interval: str, bars: list[dict[str, Any]]) -> None:
        if interval not in SUPPORTED_INTERVALS:
            return
        symbol = self._symbol(symbol)
        current = self._bars[symbol][interval]
        by_time = {int(bar["time"]): bar for bar in current}
        by_time.update({int(bar["time"]): bar for bar in bars if "time" in bar})
        self._bars[symbol][interval] = [by_time[key] for key in sorted(by_time)][-1500:]

    async def _broadcast(self, symbol: str, payload: dict[str, Any]) -> None:
        clients = list(self._clients[symbol])
        if not clients:
            return
        encoded = json.dumps(payload, separators=(",", ":"))
        results = await asyncio.gather(*(client.send_text(encoded) for client in clients), return_exceptions=True)
        for client, result in zip(clients, results):
            if isinstance(result, Exception):
                self._clients[symbol].discard(client)

    async def _consume(self, symbol: str) -> None:
        delay = 1.0
        while self._clients[symbol]:
            try:
                logger.info("binance_stream_connect symbol=%s", symbol)
                async with connect(self._stream_url(symbol), ping_interval=20, ping_timeout=20, close_timeout=5) as socket:
                    delay = 1.0
                    await self._broadcast(symbol, {"type": "status", "symbol": symbol, "status": "LIVE", "server_time": time.time_ns() // 1_000_000})
                    async for raw in socket:
                        message = json.loads(raw)
                        kline = (message.get("data") or {}).get("k")
                        if not kline:
                            continue
                        interval = str(kline.get("i", ""))
                        if interval not in SUPPORTED_INTERVALS:
                            continue
                        bar = {
                            "time": int(kline["t"]) // 1000,
                            "open": float(kline["o"]),
                            "high": float(kline["h"]),
                            "low": float(kline["l"]),
                            "close": float(kline["c"]),
                            "closed": bool(kline.get("x", False)),
                        }
                        self.put_bars(symbol, interval, [bar])
                        await self._broadcast(symbol, {"type": "kline", "symbol": symbol, "interval": interval, "bar": bar, "server_time": time.time_ns() // 1_000_000})
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("binance_stream_error symbol=%s error=%s retry_seconds=%.1f", symbol, exc, delay)
                await self._broadcast(symbol, {"type": "status", "symbol": symbol, "status": "RECONNECTING", "retry_seconds": delay, "server_time": time.time_ns() // 1_000_000})
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30.0)

    async def subscribe(self, symbol: str, websocket: WebSocket) -> None:
        symbol = self._symbol(symbol)
        await websocket.accept()
        self._clients[symbol].add(websocket)
        task = self._tasks.get(symbol)
        if task is None or task.done():
            task = asyncio.create_task(self._consume(symbol), name=f"binance-stream-{symbol}")
            self._tasks[symbol] = task
        await websocket.send_json({"type": "status", "symbol": symbol, "status": "CONNECTING", "server_time": time.time_ns() // 1_000_000})
        for interval in SUPPORTED_INTERVALS:
            bars = self.snapshot(symbol, interval)
            if bars:
                await websocket.send_json({"type": "snapshot", "symbol": symbol, "interval": interval, "bars": bars})
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            self._clients[symbol].discard(websocket)
            if not self._clients[symbol]:
                task = self._tasks.pop(symbol, None)
                if task and not task.done():
                    task.cancel()
            logger.info("binance_stream_client_disconnected symbol=%s clients=%d", symbol, len(self._clients[symbol]))

    async def close(self) -> None:
        tasks = list(self._tasks.values())
        self._tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

