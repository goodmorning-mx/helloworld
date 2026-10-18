"""Paper-only Telegram controls shared by the bot and authenticated API."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any

ScanProvider = Callable[[str, int], Awaitable[dict[str, object]]]
SYMBOL_RE = re.compile(r"^[A-Z0-9]{3,32}USDT$")


def format_scanner_message(rows: list[dict[str, object]], *, updated_at: object = None) -> str:
    """Format the same bounded scanner snapshot returned by the REST API."""
    try:
        timestamp = datetime.fromtimestamp(float(updated_at), timezone.utc).strftime("%H:%M UTC")
    except (TypeError, ValueError, OverflowError, OSError):
        timestamp = "hora desconocida"
    lines = [f"📊 Scanner Tracker · 1m · 8h · {timestamp}"]
    if not rows:
        lines.append("No hay resultados disponibles en este ciclo.")
    for index, row in enumerate(rows[:24], start=1):
        symbol = str(row.get("symbol", "?"))
        state = str(row.get("status", "?"))
        result = row.get("final_result_usdt")
        tp = row.get("tp_optimal_percent")
        ops = row.get("operations", 0)
        wins = row.get("wins", 0)
        losses = row.get("losses", 0)
        activity = row.get("activity_state", "—")
        if result is None:
            lines.append(f"{index}. {symbol} · {state}")
            continue
        result_value = float(result)
        sign = "+" if result_value >= 0 else ""
        tp_text = f"TP {float(tp):.2f}%" if tp is not None else "TP —"
        lines.append(
            f"{index}. {symbol} · {sign}{result_value:.2f} USDT · {tp_text} · "
            f"Ops {ops} · W {wins}/L {losses} · {activity}"
        )
    return "\n".join(lines)[:3900]


class TelegramControlService:
    """Own the command use cases so REST and Telegram share identical logic."""

    def __init__(self, worker_manager: object, scan_provider: ScanProvider) -> None:
        self.worker_manager = worker_manager
        self.scan_provider = scan_provider

    async def scan(self, user_id: str, limit: int = 20) -> dict[str, object]:
        return await self.scan_provider(user_id, max(1, min(int(limit), 30)))

    async def start(self, user_id: str, symbol: str) -> dict[str, Any]:
        normalized = self._symbol(symbol)
        return await self.worker_manager.start(
            user_id,
            normalized,
            mode="paper",
            interval="1m",
            tracker_period=5,
            stop_percent=0.2,
            target_percent=1.0,
        )

    async def stop(self, user_id: str, symbol: str) -> dict[str, Any]:
        return await self.worker_manager.stop(user_id, self._symbol(symbol))

    def status(self, user_id: str) -> dict[str, object]:
        workers = self.worker_manager.list(user_id)
        lines = ["🟢 Workers Paper"]
        if not workers:
            lines.append("No hay workers activos.")
        for worker in workers:
            latency = worker.get("p95_event_latency_ms")
            latency_text = f"p95 {float(latency):.1f} ms" if latency is not None else "p95 —"
            error = worker.get("last_error")
            line = (
                f"{worker.get('symbol', '?')} · {worker.get('status', '?')} · "
                f"cola {worker.get('queue_depth', 0)} · velas {worker.get('events_processed', 0)} · {latency_text}"
            )
            if error:
                line += f" · error: {str(error)[:120]}"
            lines.append(line)
        return {"workers": workers, "count": len(workers), "text": "\n".join(lines)[:3900]}

    @staticmethod
    def _symbol(symbol: str) -> str:
        normalized = str(symbol).strip().upper()
        if not SYMBOL_RE.fullmatch(normalized):
            raise ValueError("Símbolo inválido. Usa un contrato USDT, por ejemplo BTCUSDT.")
        return normalized
