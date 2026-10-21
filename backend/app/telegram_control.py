"""Telegram controls shared by the realtime Tracker and authenticated API."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any

ScanProvider = Callable[[str, int], Awaitable[dict[str, object]]]
SYMBOL_RE = re.compile(r"^[A-Z0-9]{3,32}USDT$")


def format_scanner_message(rows: list[dict[str, object]], *, updated_at: object = None, freshness: str = "FRESH") -> str:
    """Format the same bounded scanner snapshot returned by the REST API."""
    try:
        timestamp = datetime.fromtimestamp(float(updated_at), timezone.utc).strftime("%H:%M UTC")
    except (TypeError, ValueError, OverflowError, OSError):
        timestamp = "hora desconocida"
    freshness_label = "ACTUAL" if freshness == "FRESH" else "DESACTUALIZADO" if freshness == "STALE" else freshness
    lines = [f"📊 Scan web · 1m/8h · {timestamp} · {freshness_label}"]
    if not rows:
        lines.append("No hay resultados disponibles en este ciclo.")
    ranked_rows = sorted(
        rows,
        key=lambda row: float(row.get("final_result_usdt") if row.get("final_result_usdt") is not None else -1_000_000),
        reverse=True,
    )
    for index, row in enumerate(ranked_rows[:24], start=1):
        symbol = str(row.get("symbol", "?"))
        state = str(row.get("status", "?"))
        result = row.get("final_result_usdt")
        tp = row.get("tp_optimal_percent")
        stop = row.get("loss_limit_percent")
        execution_stop = row.get("stop_percent")
        tracker_period = row.get("tracker_period")
        ops = row.get("operations", 0)
        wins = row.get("wins", 0)
        losses = row.get("losses", 0)
        activity = row.get("activity_state", "—") if state == "VALID" else state
        if result is None:
            lines.append(f"{index}. {symbol} · {state}")
            continue
        result_value = float(result)
        sign = "+" if result_value >= 0 else ""
        tp_text = f"TP {float(tp):.2f}%" if tp is not None else "TP —"
        if tracker_period is not None:
            tp_text += f" N {int(tracker_period)}"
        if stop is not None:
            tp_text += f" MINROE {float(stop):.1f}%"
        if execution_stop is not None:
            tp_text += f" SL {float(execution_stop):.2f}%"
        if row.get("leverage") is not None:
            tp_text += f" {float(row['leverage']):.1f}x"
        risk_percent = row.get("risk_percent")
        risk_usdt = row.get("risk_usdt")
        risk_text = f" R{float(risk_percent):.1f}%" if risk_percent is not None else ""
        if risk_usdt is not None:
            risk_text += f" ${float(risk_usdt):.2f}"
        win_rate = row.get("win_rate")
        win_rate_text = f" · WR {float(win_rate):.1f}%" if win_rate is not None else ""
        duration = row.get("average_duration_minutes")
        duration_text = f" · ⌀ {float(duration):.1f}m" if duration is not None else ""
        lines.append(
            f"{index}. {symbol} · {sign}{result_value:.2f} USDT · {tp_text}{risk_text} · "
            f"Ops {ops} · W {wins}/L {losses}{win_rate_text}{duration_text} · {activity}"
        )
    return "\n".join(lines)[:3900]


class TelegramControlService:
    """Own the command use cases so REST and Telegram share identical logic."""

    def __init__(self, worker_manager: object, scan_provider: ScanProvider) -> None:
        self.worker_manager = worker_manager
        self.scan_provider = scan_provider

    async def scan(self, user_id: str, limit: int = 20) -> dict[str, object]:
        return await self.scan_provider(user_id, max(1, min(int(limit), 30)))

    async def start(self, user_id: str, symbol: str, *, risk_percent: float = 1.0, leverage: float = 1.0, initial_balance: float = 100.0) -> dict[str, Any]:
        normalized = self._symbol(symbol)
        activate = getattr(self.worker_manager, "activate", self.worker_manager.start)
        return await activate(
            user_id,
            normalized,
            mode="signals_only",
            interval="1m",
            tracker_period=5,
            stop_percent=0.2,
            target_percent=1.0,
            risk_percent=risk_percent,
            leverage=leverage,
            initial_balance=initial_balance,
        )

    async def set_mode(self, user_id: str, mode: str, symbol: str | None = None) -> dict[str, Any]:
        normalized = self._symbol(symbol) if symbol else None
        if normalized is None:
            active = [worker for worker in self.worker_manager.list(user_id) if worker.get("running")]
            if len(active) != 1:
                raise ValueError("No hay una única sesión activa. Usa /start SYMBOL primero.")
            normalized = self._symbol(str(active[0].get("symbol", "")))
        return await self.worker_manager.set_mode(user_id, normalized, mode)

    async def stop(self, user_id: str, symbol: str) -> dict[str, Any]:
        if symbol:
            return await self.worker_manager.stop(user_id, self._symbol(symbol))
        active = [worker for worker in self.worker_manager.list(user_id) if worker.get("running")]
        if not active:
            raise ValueError("No hay una sesión activa para detener.")
        return await self.worker_manager.stop(user_id, self._symbol(str(active[0].get("symbol", ""))))

    def status(self, user_id: str) -> dict[str, object]:
        workers = self.worker_manager.list(user_id)
        lines = ["🟢 Sesión Tracker"]
        if not workers:
            lines.append("No hay workers activos.")
        for worker in workers:
            latency = worker.get("p95_event_latency_ms")
            latency_text = f"p95 {float(latency):.1f} ms" if latency is not None else "p95 —"
            params = worker.get("adaptive_parameters") if isinstance(worker.get("adaptive_parameters"), dict) else {}
            adaptive_text = (
                f"N {params.get('tracker_period', '—')} · TP {float(params.get('target_percent', 0)):.2f}% · "
                f"SL precio {float(params.get('stop_percent', 0)):.2f}% · MINROE {float(params.get('minroe_limit_percent', 0)):.2f}% · "
                f"riesgo {float(params.get('risk_percent', 0)):.2f}% "
                f"({float(params.get('risk_usdt', 0)):.2f} USDT) · "
                f"ventana {int(params.get('bars', 0))}/480 · v{worker.get('parameter_version', 0)}"
            ) if params else "parámetros pendientes"
            tracked = worker.get("tracker_operation") if isinstance(worker.get("tracker_operation"), dict) else None
            execution = worker.get("operation") if isinstance(worker.get("operation"), dict) else None
            background = worker.get("background_operations") if isinstance(worker.get("background_operations"), list) else []
            tracker_state = f"{tracked.get('side')} {tracked.get('level')}" if tracked else "sin posición"
            execution_state = f"{execution.get('side')} {execution.get('status', 'OPEN')}" if execution else "sin posición"
            background_state = ", ".join(
                f"{item.get('side')} {item.get('status', 'OPEN')}" for item in background if isinstance(item, dict)
            )
            error = worker.get("last_error")
            line = (
                f"{worker.get('symbol', '?')} · {str(worker.get('mode', 'signals_only')).upper()} · {worker.get('status', '?')} · "
                f"cola {worker.get('queue_depth', 0)} · velas {worker.get('events_processed', 0)} · {latency_text}\n"
                f"  Tracker {tracker_state} · ejecución {execution_state}\n"
                f"  Parámetros: {adaptive_text}"
            )
            if background_state:
                line += f"\n  Operaciones previas supervisadas: {background_state}"
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
