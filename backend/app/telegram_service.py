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

    def __init__(self, bot_token: str, chat_id: str, min_delay: float = 0.25, *, enabled: bool = True) -> None:
        self.bot_token = bot_token.strip()
        self.chat_id = chat_id.strip()
        self.min_delay = max(0.05, float(min_delay))
        self.enabled = enabled
        self._queue: asyncio.Queue[str] = asyncio.Queue(maxsize=500)
        self._task: asyncio.Task[None] | None = None
        self._client: httpx.AsyncClient | None = None
        self._lock = asyncio.Lock()

    @property
    def configured(self) -> bool:
        return self.enabled and bool(self.bot_token and self.chat_id)

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


class TelegramCommandService:
    """Allowlisted, Paper-only Telegram controls for the realtime engine."""

    def __init__(self, bot_token: str, chat_id: str, user_id: str, worker_manager: object, sink: TelegramSink) -> None:
        self.bot_token = bot_token.strip()
        self.chat_id = chat_id.strip()
        self.user_id = user_id.strip()
        self.worker_manager = worker_manager
        self.sink = sink
        self._task: asyncio.Task[None] | None = None
        self._client: httpx.AsyncClient | None = None
        self._offset: int | None = None

    @property
    def configured(self) -> bool:
        return bool(self.bot_token and self.chat_id and self.user_id)

    async def start(self) -> None:
        if not self.configured or self._task is not None:
            return
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(35, connect=5))
        self._task = asyncio.create_task(self._run(), name="telegram-paper-commands")

    async def stop(self) -> None:
        task = self._task
        self._task = None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _run(self) -> None:
        assert self._client is not None
        url = f"https://api.telegram.org/bot{self.bot_token}/getUpdates"
        while True:
            try:
                params = {"timeout": 25, "allowed_updates": '["message"]'}
                if self._offset is not None:
                    params["offset"] = self._offset
                response = await self._client.get(url, params=params)
                response.raise_for_status()
                payload = response.json()
                if not payload.get("ok"):
                    raise RuntimeError("Telegram getUpdates returned an unsuccessful response")
                for update in payload.get("result", []):
                    self._offset = int(update.get("update_id", 0)) + 1
                    await self._handle_update(update)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("telegram_command_poll_failed")
                await asyncio.sleep(3)

    async def _handle_update(self, update: dict[str, object]) -> None:
        message = update.get("message")
        if not isinstance(message, dict):
            return
        chat = message.get("chat")
        if not isinstance(chat, dict) or str(chat.get("id", "")) != self.chat_id:
            return
        text = message.get("text")
        if not isinstance(text, str) or not text.startswith("/"):
            return
        parts = text.strip().split()
        command = parts[0].split("@", 1)[0].lower()
        if command in {"/startpaper", "/stoppaper"} and (len(parts) != 2 or len(parts[1]) > 32):
            await self.sink.send("Uso: /startpaper BTCUSDT o /stoppaper BTCUSDT")
            return
        try:
            if command == "/help":
                await self.sink.send("Paper realtime: /workers, /startpaper BTCUSDT, /stoppaper BTCUSDT. Los comandos Live no están disponibles.")
            elif command == "/workers":
                workers = self.worker_manager.list(self.user_id)
                summary = [f"{worker['symbol']} {worker['status']} · cola {worker['queue_depth']}" for worker in workers]
                await self.sink.send("Workers Paper: " + ("; ".join(summary) if summary else "ninguno activo"))
            elif command == "/startpaper":
                result = await self.worker_manager.start(self.user_id, parts[1].upper(), mode="paper")
                await self.sink.send(f"Paper realtime iniciado: {result['symbol']} ({result['status']}).")
            elif command == "/stoppaper":
                result = await self.worker_manager.stop(self.user_id, parts[1].upper())
                await self.sink.send(f"Paper realtime detenido: {result['symbol']}.")
        except Exception as exc:
            await self.sink.send(f"No se pudo ejecutar {command}: {str(exc)[:300]}")
