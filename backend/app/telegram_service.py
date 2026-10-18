"""Non-blocking Telegram event delivery for backend workers."""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from collections.abc import Awaitable
from datetime import datetime, timezone
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
        self._seen_signals: set[str] = set()
        self._seen_signal_order: deque[str] = deque()

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

    async def send(self, message: str) -> bool:
        if not self.configured:
            return False
        if self._task is None:
            async with self._lock:
                if self._task is None:
                    await self.start()
        try:
            self._queue.put_nowait(str(message)[:4096])
            return True
        except asyncio.QueueFull:
            logger.warning("telegram_queue_full")
            return False

    async def send_once(self, key: str, message: str) -> bool:
        if key in self._seen_signals:
            return False
        if not await self.send(message):
            return False
        self._seen_signals.add(key)
        self._seen_signal_order.append(key)
        if len(self._seen_signal_order) > 2000:
            self._seen_signals.discard(self._seen_signal_order.popleft())
        return True

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
            except Exception as exc:
                # HTTP exceptions may include the bot-token URL; never log
                # exception text or request details from Telegram delivery.
                logger.warning("telegram_delivery_failed error_type=%s", type(exc).__name__)
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
        if kind in {"PAPER_ENTRY", "LIVE_ENTRY"}:
            # The richer TRACKER_SIGNAL event below represents these entries.
            return
        if kind == "TRACKER_SIGNAL":
            signal_id = str(event.get("signal_id", ""))
            side = str(event.get("side", "?"))
            symbol = str(event.get("symbol", ""))
            level = str(event.get("level", "?"))
            interval = str(event.get("interval", "1m"))
            price = event.get("price", "?")
            bar_time = event.get("bar_time")
            mode = str(event.get("mode", "paper")).upper()
            stop = event.get("stop_percent")
            target = event.get("target_percent")
            try:
                candle_label = datetime.fromtimestamp(float(bar_time), timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
            except (TypeError, ValueError, OverflowError, OSError):
                candle_label = "hora desconocida"
            risk_label = f" · SL -{stop}% · TP +{target}%" if stop is not None and target is not None else ""
            message = (
                f"Señal Tracker {mode}: {side} {symbol} · {level} · "
                f"precio {price} · marco {interval} · {candle_label}{risk_label}"
            )
            if signal_id:
                await telegram.send_once(signal_id, message)
            else:
                await telegram.send(message)
            return
        symbol = str(event.get("symbol", ""))
        details = " · ".join(f"{key}={value}" for key, value in event.items() if key not in {"type", "symbol"})
        await telegram.send(f"{kind} {symbol}" + (f" · {details}" if details else ""))

    return consume


class TelegramCommandService:
    """Private-chat command client for the Paper engine and shared scanner API."""

    def __init__(self, bot_token: str, chat_id: str, user_id: str, control: object, sink: TelegramSink, *, sender_id: str = "") -> None:
        self.bot_token = bot_token.strip()
        self.chat_id = chat_id.strip()
        self.user_id = user_id.strip()
        self.sender_id = sender_id.strip()
        self.control = control
        self.sink = sink
        self._task: asyncio.Task[None] | None = None
        self._client: httpx.AsyncClient | None = None
        self._offset: int | None = None
        self._seen_updates: set[int] = set()
        self._seen_update_order: deque[int] = deque()
        self.commands_processed = 0
        self.last_command_at: datetime | None = None
        self.last_error: str | None = None
        self.updates_received = 0
        self.poll_errors = 0
        self.last_poll_at: datetime | None = None

    @property
    def configured(self) -> bool:
        return bool(self.bot_token and self.chat_id and self.user_id and self.sender_id)

    def status(self) -> dict[str, object]:
        return {
            "configured": self.configured,
            "running": self._task is not None and not self._task.done(),
            "commands_processed": self.commands_processed,
            "updates_received": self.updates_received,
            "poll_errors": self.poll_errors,
            "last_poll_at": self.last_poll_at.isoformat() if self.last_poll_at else None,
            "last_command_at": self.last_command_at.isoformat() if self.last_command_at else None,
            "last_error": self.last_error,
        }

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
        try:
            command_response = await self._client.post(
                f"https://api.telegram.org/bot{self.bot_token}/setMyCommands",
                json={"language_code": "es", "commands": [
                    {"command": "scan", "description": "Escanear y ordenar el mercado"},
                    {"command": "start", "description": "Iniciar Paper: start BTCUSDT"},
                    {"command": "stop", "description": "Detener Paper: stop BTCUSDT"},
                    {"command": "status", "description": "Estado de workers y bot"},
                ]},
            )
            command_response.raise_for_status()
            if not command_response.json().get("ok"):
                raise RuntimeError("Telegram rejected the command menu")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Telegram's URL contains the bot token; only log the exception type.
            self.last_error = type(exc).__name__
            logger.warning("telegram_command_menu_update_failed error_type=%s", type(exc).__name__)
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
                self.last_poll_at = datetime.now(timezone.utc)
                self.last_error = None
                for update in payload.get("result", []):
                    self.updates_received += 1
                    self._offset = int(update.get("update_id", 0)) + 1
                    await self._handle_update(update)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # The request URL contains the bot token; never log exceptions
                # or request details from Telegram polling.
                self.poll_errors += 1
                self.last_error = type(exc).__name__
                logger.warning("telegram_command_poll_failed error_type=%s", type(exc).__name__)
                await asyncio.sleep(3)

    async def _handle_update(self, update: dict[str, object]) -> None:
        try:
            update_id = int(update.get("update_id", -1))
        except (TypeError, ValueError):
            update_id = -1
        if update_id >= 0 and update_id in self._seen_updates:
            return
        message = update.get("message")
        if not isinstance(message, dict):
            return
        chat = message.get("chat")
        sender = message.get("from")
        if (
            not isinstance(chat, dict)
            or str(chat.get("id", "")) != self.chat_id
            or chat.get("type") not in {"private", "group", "supergroup"}
            or not isinstance(sender, dict)
            or str(sender.get("id", "")) != self.sender_id
        ):
            return
        text = message.get("text")
        if not isinstance(text, str):
            return
        parts = text.strip().split()
        if not parts:
            return
        command = parts[0].lstrip("/").split("@", 1)[0].lower()
        if command not in {"scan", "start", "stop", "status", "help"}:
            return
        if update_id >= 0:
            self._seen_updates.add(update_id)
            self._seen_update_order.append(update_id)
            if len(self._seen_update_order) > 2000:
                self._seen_updates.discard(self._seen_update_order.popleft())
        self.commands_processed += 1
        self.last_command_at = datetime.now(timezone.utc)
        try:
            if command == "help":
                await self.sink.send("Comandos: scan · start BTCUSDT · stop BTCUSDT · status. start siempre crea un worker Paper.")
            elif command == "scan":
                if len(parts) != 1:
                    await self.sink.send("Uso: scan")
                    return
                result = await self.control.scan(self.user_id, 20)
                await self.sink.send(str(result.get("text", "Scanner sin resultados.")))
            elif command == "status":
                if len(parts) != 1:
                    await self.sink.send("Uso: status")
                    return
                result = self.control.status(self.user_id)
                receiver = self.status()
                receiver_line = (
                    f"Bot comandos · {'EN LÍNEA' if receiver['running'] else 'DETENIDO'} · "
                    f"comandos {receiver['commands_processed']} · errores poll {receiver['poll_errors']}"
                )
                await self.sink.send(receiver_line + "\n" + str(result.get("text", "Estado no disponible.")))
            elif command in {"start", "stop"}:
                if len(parts) != 2 or len(parts[1]) > 32:
                    await self.sink.send(f"Uso: {command} BTCUSDT")
                    return
                if command == "start":
                    result = await self.control.start(self.user_id, parts[1])
                    await self.sink.send(f"Worker Paper iniciado: {result['symbol']} · {result.get('status', 'STARTING')}.")
                else:
                    result = await self.control.stop(self.user_id, parts[1])
                    await self.sink.send(f"Worker detenido: {result['symbol']}.")
        except ValueError as exc:
            await self.sink.send(str(exc)[:300])
        except Exception as exc:
            self.last_error = type(exc).__name__
            logger.warning("telegram_command_failed command=%s error_type=%s", command, type(exc).__name__)
            await self.sink.send("No se pudo ejecutar el comando. Intenta de nuevo o revisa status.")
