from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import defaultdict
from typing import Any, Awaitable, Callable

from fastapi import WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect
import httpx

logger = logging.getLogger("helloworld.market_gateway")
SUPPORTED_INTERVALS = ("1m", "3m", "5m", "15m")


class BinanceMarketGateway:
    """One shared Binance Futures stream per symbol with an in-memory cache."""

    def __init__(self) -> None:
        self._bars: dict[str, dict[str, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
        self._clients: dict[str, set[WebSocket]] = defaultdict(set)
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._last_event_ms: dict[str, int] = {}
        self._listeners: dict[str, set[Callable[[dict[str, Any]], Awaitable[None]]]] = defaultdict(set)
        self._lock = asyncio.Lock()

    @staticmethod
    def _symbol(symbol: str) -> str:
        return symbol.strip().upper()

    @staticmethod
    def _stream_url(symbol: str) -> str:
        streams = "/".join([f"{symbol.lower()}@aggTrade", f"{symbol.lower()}@markPrice@1s", *(f"{symbol.lower()}@kline_{interval}" for interval in SUPPORTED_INTERVALS)])
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
        listeners = list(self._listeners[symbol])
        if listeners:
            await asyncio.gather(*(listener(payload) for listener in listeners), return_exceptions=True)
        clients = list(self._clients[symbol])
        if not clients:
            return
        encoded = json.dumps(payload, separators=(",", ":"))
        results = await asyncio.gather(*(client.send_text(encoded) for client in clients), return_exceptions=True)
        for client, result in zip(clients, results):
            if isinstance(result, Exception):
                self._clients[symbol].discard(client)

    async def _rest_fallback(self, symbol: str) -> None:
        """Recover a silent upstream socket without polling while it is live."""
        async with httpx.AsyncClient(timeout=5) as client:
            while self._clients[symbol] or self._listeners[symbol]:
                await asyncio.sleep(3)
                last_event = self._last_event_ms.get(symbol, 0)
                if last_event and int(time.time() * 1000) - last_event < 8_000:
                    continue
                for interval in SUPPORTED_INTERVALS:
                    try:
                        response = await client.get(f"https://fapi.binance.com/fapi/v1/klines?symbol={symbol}&interval={interval}&limit=1")
                        response.raise_for_status()
                        rows = response.json()
                        row = rows[-1] if isinstance(rows, list) and rows else None
                        if not isinstance(row, list) or len(row) < 5:
                            continue
                        bar = {"time": int(float(row[0]) / 1000), "open": float(row[1]), "high": float(row[2]), "low": float(row[3]), "close": float(row[4]), "closed": False}
                        previous = self._bars[symbol][interval][-1] if self._bars[symbol][interval] else None
                        self.put_bars(symbol, interval, [bar])
                        if previous != bar:
                            await self._broadcast(symbol, {"type": "kline", "symbol": symbol, "interval": interval, "bar": bar, "source": "rest-fallback", "server_time": time.time_ns() // 1_000_000})
                    except (httpx.HTTPError, ValueError, TypeError):
                        logger.warning("binance_rest_fallback_error symbol=%s interval=%s", symbol, interval)

    async def _consume(self, symbol: str) -> None:
        delay = 1.0
        fallback_task = asyncio.create_task(self._rest_fallback(symbol), name=f"binance-fallback-{symbol}")
        try:
            while self._clients[symbol] or self._listeners[symbol]:
                try:
                    logger.info("binance_stream_connect symbol=%s", symbol)
                    async with connect(self._stream_url(symbol), ping_interval=20, ping_timeout=20, close_timeout=5) as socket:
                        delay = 1.0
                        await self._broadcast(symbol, {"type": "status", "symbol": symbol, "status": "LIVE", "server_time": time.time_ns() // 1_000_000})
                        async for raw in socket:
                            message = json.loads(raw)
                            data = message.get("data") or {}
                            if data.get("e") == "markPriceUpdate" and data.get("p") is not None:
                                self._last_event_ms[symbol] = int(time.time() * 1000)
                                await self._broadcast(symbol, {"type": "mark_price", "symbol": symbol, "price": float(data["p"]), "time": int(data.get("E", time.time() * 1000)) // 1000, "source": "mark-price-stream", "server_time": time.time_ns() // 1_000_000})
                                continue
                            aggregate_trade = data.get("p")
                            if aggregate_trade is not None and data.get("T") is not None:
                                self._last_event_ms[symbol] = int(time.time() * 1000)
                                await self._broadcast(symbol, {"type": "trade", "symbol": symbol, "price": float(aggregate_trade), "time": int(data["T"]) // 1000, "source": "websocket", "server_time": time.time_ns() // 1_000_000})
                                continue
                            kline = data.get("k")
                            if not kline:
                                continue
                            interval = str(kline.get("i", ""))
                            if interval not in SUPPORTED_INTERVALS:
                                continue
                            bar = {"time": int(kline["t"]) // 1000, "open": float(kline["o"]), "high": float(kline["h"]), "low": float(kline["l"]), "close": float(kline["c"]), "closed": bool(kline.get("x", False))}
                            self._last_event_ms[symbol] = int(time.time() * 1000)
                            self.put_bars(symbol, interval, [bar])
                            await self._broadcast(symbol, {"type": "kline", "symbol": symbol, "interval": interval, "bar": bar, "source": "websocket", "server_time": time.time_ns() // 1_000_000})
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning("binance_stream_error symbol=%s error=%s retry_seconds=%.1f", symbol, exc, delay)
                    await self._broadcast(symbol, {"type": "status", "symbol": symbol, "status": "RECONNECTING", "retry_seconds": delay, "server_time": time.time_ns() // 1_000_000})
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 30.0)
        finally:
            fallback_task.cancel()
            await asyncio.gather(fallback_task, return_exceptions=True)

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
            if not self._clients[symbol] and not self._listeners[symbol]:
                task = self._tasks.pop(symbol, None)
                if task and not task.done():
                    task.cancel()
            logger.info("binance_stream_client_disconnected symbol=%s clients=%d", symbol, len(self._clients[symbol]))

    def add_listener(self, symbol: str, listener: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        symbol = self._symbol(symbol)
        self._listeners[symbol].add(listener)
        task = self._tasks.get(symbol)
        if task is None or task.done():
            self._tasks[symbol] = asyncio.create_task(self._consume(symbol), name=f"binance-worker-stream-{symbol}")

    def remove_listener(self, symbol: str, listener: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        symbol = self._symbol(symbol)
        self._listeners[symbol].discard(listener)
        if not self._clients[symbol] and not self._listeners[symbol]:
            task = self._tasks.pop(symbol, None)
            if task and not task.done():
                task.cancel()

    async def close(self) -> None:
        self._listeners.clear()
        tasks = list(self._tasks.values())
        self._tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
