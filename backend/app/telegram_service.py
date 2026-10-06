"""Non-blocking Telegram event delivery for backend workers."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable
from typing import Callable

import httpx

logger = logging.getLogger(__name__)


class TelegramSink:
    """Bounded, rate-limited Telegram sink; silently becomes a no-op when unset."""

    def __init__(self, bot_token: str, chat_id: str, min_delay: float = 0.25) -> None:
        self.bot_token = bot_token.strip()
        self.chat_id = chat_id.strip()
        self.min_delay = max(0.05, float(min_delay))
        self._queue: asyncio.Queue[str] = asyncio.Queue(maxsize=500)
        self._task: asyncio.Task[None] | None = None
        self._client: httpx.AsyncClient | None = None
        self._lock = asyncio.Lock()

    @property
    def configured(self) -> bool:
        return bool(self.bot_token and self.chat_id)

    async def start(self) -> None:
        if self._task is not None:
            return
        self._client = httpx.AsyncClient(timeout=10)
        self._task = asyncio.create_task(self._run(), name="telegram-sink")

    async def stop(self) -> None:
        task = self._task
        self._task = None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def send(self, message: str) -> None:
        if not self.configured:
            return
        if self._task is None:
            async with self._lock:
                if self._task is None:
                    await self.start()
        try:
            self._queue.put_nowait(str(message)[:4096])
        except asyncio.QueueFull:
            logger.warning("telegram_queue_full")

    async def _run(self) -> None:
        while True:
            message = await self._queue.get()
            try:
                if self._client is not None:
                    response = await self._client.post(
                        f"https://api.telegram.org/bot{self.bot_token}/sendMessage",
                        data={"chat_id": self.chat_id, "text": message},
                    )
                    response.raise_for_status()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("telegram_delivery_failed")
            await asyncio.sleep(self.min_delay)


class BackendEventBus:
    """Fan-out event bus used by production workers and notification sinks."""

    def __init__(self) -> None:
        self._sinks: list[Callable[[dict[str, object]], Awaitable[None]]] = []

    def add_sink(self, sink: Callable[[dict[str, object]], Awaitable[None]]) -> None:
        self._sinks.append(sink)

    async def publish(self, event: dict[str, object]) -> None:
        if not self._sinks:
            return
        await asyncio.gather(*(sink(event) for sink in self._sinks), return_exceptions=True)


def telegram_event_sink(telegram: TelegramSink) -> Callable[[dict[str, object]], Awaitable[None]]:
    async def consume(event: dict[str, object]) -> None:
        kind = str(event.get("type", "EVENT")).upper()
        symbol = str(event.get("symbol", ""))
        details = " · ".join(f"{key}={value}" for key, value in event.items() if key not in {"type", "symbol"})
        await telegram.send(f"{kind} {symbol}" + (f" · {details}" if details else ""))

    return consume
