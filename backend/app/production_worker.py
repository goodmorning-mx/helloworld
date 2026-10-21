"""Per-symbol strategy workers with Paper and Binance execution adapters."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import logging
import asyncio
import time
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR
from collections import deque
from typing import Any, Protocol
from uuid import uuid4
import httpx

from sqlalchemy import insert, or_, select, update
from sqlalchemy.dialects.postgresql import JSONB, insert as pg_insert
from sqlalchemy.engine import Engine
from sqlalchemy.sql import column, table

from app.binance_credentials import BinanceMonitorManager
from app.binance_execution import BinanceExecutionStore
from app.adaptive_tracker import WINDOW_BARS, calibrate_tracker_parameters
from app.market_gateway import BinanceMarketGateway
from app.paper_operations import PaperOperationStore
from app.telegram_service import BackendEventBus
from app.tracker_strategy import tracker_close_reason, tracker_levels, tracker_signal

logger = logging.getLogger(__name__)
WORKER_HEARTBEAT_SECONDS = 15

production_worker_configs_table = table(
    "production_worker_configs",
    column("id"), column("user_id"), column("symbol"), column("mode"), column("interval"),
    column("tracker_period"), column("stop_percent"), column("target_percent"), column("quantity"),
    column("risk_percent"), column("leverage"), column("initial_balance"),
    column("enabled"), column("created_at"), column("updated_at"),
)
production_worker_runtime_table = table(
    "production_worker_runtime", column("owner_id"), column("lease_until"),
    column("user_id"), column("symbol"), column("last_bar_time"), column("heartbeat_at"),
    column("status"), column("tracker_operation", JSONB), column("adaptive_parameters", JSONB), column("updated_at"),
)
production_worker_sessions_table = table(
    "production_worker_sessions", column("user_id"), column("symbol"),
    column("owner_id"), column("lease_until"), column("updated_at"),
)


class ProductionWorkerConfigStore:
    def __init__(self, engine: Engine):
        self._engine = engine

    def save(self, user_id: str, values: dict[str, Any]) -> None:
        now = datetime.now(timezone.utc)
        symbol = str(values["symbol"]).upper()
        clean_values = {key: value for key, value in values.items() if key != "symbol"}
        with self._engine.begin() as connection:
            existing = connection.execute(select(production_worker_configs_table).where(production_worker_configs_table.c.user_id == user_id, production_worker_configs_table.c.symbol == symbol)).mappings().first()
            if existing:
                connection.execute(update(production_worker_configs_table).where(production_worker_configs_table.c.id == existing["id"]).values(**clean_values, symbol=symbol, updated_at=now))
            else:
                connection.execute(insert(production_worker_configs_table).values(id=str(uuid4()), user_id=user_id, **clean_values, symbol=symbol, created_at=now, updated_at=now))

    def disable(self, user_id: str, symbol: str) -> None:
        with self._engine.begin() as connection:
            connection.execute(update(production_worker_configs_table).where(production_worker_configs_table.c.user_id == user_id, production_worker_configs_table.c.symbol == symbol.upper()).values(enabled=False, updated_at=datetime.now(timezone.utc)))

    def enabled(self) -> list[dict[str, Any]]:
        with self._engine.connect() as connection:
            return [dict(row) for row in connection.execute(select(production_worker_configs_table).where(production_worker_configs_table.c.enabled.is_(True))).mappings().all()]

    def runtime(self, user_id: str, symbol: str) -> dict[str, Any] | None:
        with self._engine.connect() as connection:
            row = connection.execute(select(production_worker_runtime_table).where(production_worker_runtime_table.c.user_id == user_id, production_worker_runtime_table.c.symbol == symbol.upper())).mappings().first()
            return dict(row) if row else None

    def claim_lease(self, user_id: str, symbol: str, owner_id: str, lease_seconds: int = 45) -> bool:
        now = datetime.now(timezone.utc)
        statement = pg_insert(production_worker_runtime_table).values(
            user_id=user_id, symbol=symbol.upper(), owner_id=owner_id,
            lease_until=now + timedelta(seconds=lease_seconds), last_bar_time=None,
            heartbeat_at=now, status="STARTING", updated_at=now,
        ).on_conflict_do_update(
            index_elements=[production_worker_runtime_table.c.user_id, production_worker_runtime_table.c.symbol],
            set_={"owner_id": owner_id, "lease_until": now + timedelta(seconds=lease_seconds), "heartbeat_at": now, "status": "STARTING", "updated_at": now},
            where=or_(production_worker_runtime_table.c.lease_until < now, production_worker_runtime_table.c.owner_id == owner_id),
        ).returning(production_worker_runtime_table.c.owner_id)
        with self._engine.begin() as connection:
            return connection.execute(statement).scalar_one_or_none() == owner_id

    def save_runtime(self, user_id: str, symbol: str, owner_id: str, *, last_bar_time: int | None, status: str = "RUNNING", tracker_operation: dict[str, Any] | None = None, adaptive_parameters: dict[str, Any] | None = None, lease_seconds: int = 45) -> bool:
        now = datetime.now(timezone.utc)
        with self._engine.begin() as connection:
            result = connection.execute(update(production_worker_runtime_table).where(production_worker_runtime_table.c.user_id == user_id, production_worker_runtime_table.c.symbol == symbol.upper(), production_worker_runtime_table.c.owner_id == owner_id).values(last_bar_time=last_bar_time, tracker_operation=tracker_operation, adaptive_parameters=adaptive_parameters, heartbeat_at=now, lease_until=now + timedelta(seconds=lease_seconds), status=status, updated_at=now))
            return result.rowcount == 1

    def release_lease(self, user_id: str, symbol: str, owner_id: str, status: str) -> None:
        now = datetime.now(timezone.utc)
        with self._engine.begin() as connection:
            connection.execute(update(production_worker_runtime_table).where(production_worker_runtime_table.c.user_id == user_id, production_worker_runtime_table.c.symbol == symbol.upper(), production_worker_runtime_table.c.owner_id == owner_id).values(owner_id=None, lease_until=now, heartbeat_at=now, status=status, updated_at=now))

    def claim_session(self, user_id: str, symbol: str, owner_id: str, lease_seconds: int = 45) -> bool:
        now = datetime.now(timezone.utc)
        statement = pg_insert(production_worker_sessions_table).values(
            user_id=user_id, symbol=symbol.upper(), owner_id=owner_id,
            lease_until=now + timedelta(seconds=lease_seconds), updated_at=now,
        ).on_conflict_do_update(
            index_elements=[production_worker_sessions_table.c.user_id],
            set_={"symbol": symbol.upper(), "owner_id": owner_id,
                  "lease_until": now + timedelta(seconds=lease_seconds), "updated_at": now},
            where=or_(production_worker_sessions_table.c.lease_until < now,
                      production_worker_sessions_table.c.owner_id == owner_id),
        ).returning(production_worker_sessions_table.c.owner_id)
        with self._engine.begin() as connection:
            return connection.execute(statement).scalar_one_or_none() == owner_id

    def renew_session(self, user_id: str, symbol: str, owner_id: str, lease_seconds: int = 45) -> bool:
        now = datetime.now(timezone.utc)
        with self._engine.begin() as connection:
            result = connection.execute(update(production_worker_sessions_table).where(
                production_worker_sessions_table.c.user_id == user_id,
                production_worker_sessions_table.c.symbol == symbol.upper(),
                production_worker_sessions_table.c.owner_id == owner_id,
            ).values(lease_until=now + timedelta(seconds=lease_seconds), updated_at=now))
            return result.rowcount == 1

    def release_session(self, user_id: str, symbol: str, owner_id: str) -> None:
        now = datetime.now(timezone.utc)
        with self._engine.begin() as connection:
            connection.execute(update(production_worker_sessions_table).where(
                production_worker_sessions_table.c.user_id == user_id,
                production_worker_sessions_table.c.symbol == symbol.upper(),
                production_worker_sessions_table.c.owner_id == owner_id,
            ).values(owner_id=None, lease_until=now, updated_at=now))


class ExecutionAdapter(Protocol):
    mode: str

    async def open(self, worker: "SymbolWorker", side: str, price: float, bar: dict[str, Any]) -> dict[str, Any]: ...
    async def close(self, worker: "SymbolWorker", reason: str, price: float, bar: dict[str, Any]) -> dict[str, Any]: ...


class SignalOnlyExecutionAdapter:
    """Keep Tracker active and publish signals without placing operations."""
    mode = "signals_only"

    async def open(self, worker: "SymbolWorker", side: str, price: float, bar: dict[str, Any]) -> dict[str, Any]:
        return {}

    async def close(self, worker: "SymbolWorker", reason: str, price: float, bar: dict[str, Any]) -> dict[str, Any]:
        return {}


@dataclass
class SymbolWorker:
    user_id: str
    symbol: str
    interval: str
    tracker_period: int
    stop_percent: float
    target_percent: float
    adapter: ExecutionAdapter
    paper_store: PaperOperationStore
    events: BackendEventBus
    bars: list[dict[str, Any]] = field(default_factory=list)
    operation: dict[str, Any] | None = None
    operation_adapter: ExecutionAdapter | None = None
    background_operations: list[tuple[dict[str, Any], ExecutionAdapter]] = field(default_factory=list)
    tracker_operation: dict[str, Any] | None = None
    adaptive_parameters: dict[str, Any] = field(default_factory=dict)
    recalibration_task: asyncio.Task[None] | None = None
    parameter_version: int = 0
    running: bool = True
    last_bar_time: int | None = None
    queue: asyncio.Queue[dict[str, Any]] = field(default_factory=lambda: asyncio.Queue(maxsize=64))
    task: asyncio.Task[None] | None = None
    initialization_task: asyncio.Task[None] | None = None
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    status: str = "STARTING"
    events_received: int = 0
    events_processed: int = 0
    duplicate_events: int = 0
    queue_overflows: int = 0
    last_event_latency_ms: float | None = None
    latency_samples_ms: deque[float] = field(default_factory=lambda: deque(maxlen=100))
    last_error: str | None = None
    runtime_store: ProductionWorkerConfigStore | None = None
    session_store: ProductionWorkerConfigStore | None = None
    account_listener: Any = None
    event_loop: asyncio.AbstractEventLoop | None = None
    state_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    history_provider: Any = None
    pending_bar_times: set[int] = field(default_factory=set)
    lease_owner_id: str | None = None
    on_lease_lost: Any = None
    started: asyncio.Event = field(default_factory=asyncio.Event)

    def offer_market_event(self, event: dict[str, Any]) -> None:
        """Enqueue closed candles quickly so market fanout never waits on trading work."""
        if not self.running or event.get("type") != "kline" or event.get("interval") != self.interval:
            return
        bar = event.get("bar")
        if not isinstance(bar, dict) or not bar.get("closed"):
            return
        try:
            bar_time = int(bar["time"])
        except (KeyError, TypeError, ValueError):
            return
        if bar_time <= (self.last_bar_time or -1) or bar_time in self.pending_bar_times:
            self.duplicate_events += 1
            return
        self.events_received += 1
        queued_event = {**event, "_worker_received_at": time.perf_counter()}
        try:
            self.queue.put_nowait(queued_event)
            self.pending_bar_times.add(bar_time)
        except asyncio.QueueFull:
            self.queue_overflows += 1
            self.status = "DEGRADED"
            self.last_error = "worker candle queue is full"

    async def run(self) -> None:
        self.started.set()
        await self.ready.wait()
        if self.status == "STARTING":
            self.status = "RUNNING"
        while self.running:
            try:
                event = await asyncio.wait_for(self.queue.get(), timeout=WORKER_HEARTBEAT_SECONDS)
            except TimeoutError:
                if not await self._renew_lease():
                    break
                continue
            received_at = float(event.get("_worker_received_at", time.perf_counter()))
            try:
                if not await self._renew_lease():
                    self.pending_bar_times.discard(int(event["bar"]["time"]))
                    break
                await self.process_market_event(event)
                self.pending_bar_times.discard(int(event["bar"]["time"]))
                self.events_processed += 1
                self.last_event_latency_ms = (time.perf_counter() - received_at) * 1000
                self.latency_samples_ms.append(self.last_event_latency_ms)
                if self.status != "DEGRADED":
                    self.last_error = None
                if self.history_provider is not None:
                    for bar in self.history_provider():
                        if bool(bar.get("closed")) and int(bar["time"]) > (self.last_bar_time or -1):
                            self.offer_market_event({"type": "kline", "interval": self.interval, "bar": bar})
                if self.status != "DEGRADED":
                    self.status = "RUNNING"
                elif self.queue_overflows:
                    latest_time = max((int(bar["time"]) for bar in self.history_provider() if bool(bar.get("closed"))), default=self.last_bar_time or -1) if self.history_provider is not None else self.last_bar_time or -1
                    scheduled_through = max([self.last_bar_time or -1, *self.pending_bar_times])
                    if latest_time <= scheduled_through:
                        self.status = "RUNNING"
                        self.last_error = None
                if not await self._renew_lease():
                    break
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.status = "ERROR"
                self.last_error = str(exc)[:300]
                logger.exception("production_worker_event_failed symbol=%s", self.symbol)
                if self.running:
                    await asyncio.sleep(0.5)
                    try:
                        self.queue.put_nowait(event)
                    except asyncio.QueueFull:
                        self.queue_overflows += 1
                        self.pending_bar_times.discard(int(event["bar"]["time"]))
            finally:
                self.queue.task_done()

    async def _renew_lease(self) -> bool:
        if self.runtime_store is None or self.lease_owner_id is None:
            return True
        owned = await asyncio.to_thread(self.runtime_store.save_runtime, self.user_id, self.symbol, self.lease_owner_id, last_bar_time=self.last_bar_time, status=self.status, tracker_operation=self.tracker_operation, adaptive_parameters=self.adaptive_parameters)
        if owned and (self.session_store is None or self.lease_owner_id is None):
            return True
        if owned and await asyncio.to_thread(self.session_store.renew_session, self.user_id, self.symbol, self.lease_owner_id):
            return True
        if owned:
            owned = False
        self.status = "LEASE_LOST"
        self.last_error = "worker lease was claimed by another backend instance"
        self.running = False
        if self.on_lease_lost is not None:
            self.on_lease_lost()
        return False

    async def on_market_event(self, event: dict[str, Any]) -> None:
        """Compatibility entry point for direct callers; gateway uses the nonblocking offer."""
        await self.process_market_event(event)

    async def process_market_event(self, event: dict[str, Any]) -> None:
        async with self.state_lock:
            await self._process_market_event_locked(event)

    async def _process_market_event_locked(self, event: dict[str, Any]) -> None:
        if not self.running or event.get("type") != "kline" or event.get("interval") != self.interval:
            return
        bar = event.get("bar")
        if not isinstance(bar, dict) or not bool(bar.get("closed")):
            return
        # A recalibration is calculated off-loop, but the next candle must use
        # its committed parameter snapshot. The market callback remains enqueue-only.
        if self.recalibration_task is not None and not self.recalibration_task.done():
            await self.recalibration_task
        normalized = {key: float(bar[key]) if key != "time" else int(bar[key]) for key in ("time", "open", "high", "low", "close")}
        if self.last_bar_time is not None and normalized["time"] <= self.last_bar_time:
            self.duplicate_events += 1
            return
        self.bars = [item for item in self.bars if int(item["time"]) != normalized["time"]][-WINDOW_BARS + 1:] + [normalized]
        await self._process_background_operations(normalized)
        await self._evaluate(normalized)
        self.last_bar_time = normalized["time"]

    async def _process_background_operations(self, bar: dict[str, Any]) -> None:
        survivors: list[tuple[dict[str, Any], ExecutionAdapter]] = []
        current_operation, current_adapter = self.operation, self.operation_adapter
        for operation, adapter in self.background_operations:
            reason = tracker_close_reason(
                str(operation["side"]), float(operation["entry_price"]), float(bar["close"]),
                float(operation.get("stop_percent", self.stop_percent)),
                float(operation.get("target_percent", self.target_percent)),
            )
            if reason is None:
                survivors.append((operation, adapter))
                continue
            self.operation, self.operation_adapter = operation, adapter
            try:
                await adapter.close(self, reason, float(bar["close"]), bar)
            except Exception:
                survivors.append((operation, adapter))
                raise
            finally:
                self.operation, self.operation_adapter = current_operation, current_adapter
        self.background_operations = survivors

    async def _evaluate(self, bar: dict[str, Any]) -> None:
        # Paper/Binance executions manage their own exits. These exits never
        # mutate Tracker's independent virtual position or signal sequence.
        if self.operation is not None:
            operation_stop = float(self.operation.get("stop_percent", self.stop_percent))
            operation_target = float(self.operation.get("target_percent", self.target_percent))
            execution_reason = tracker_close_reason(str(self.operation["side"]), float(self.operation["entry_price"]), float(bar["close"]), operation_stop, operation_target)
            if execution_reason is not None:
                closing_adapter = self.operation_adapter or self.adapter
                await closing_adapter.close(self, execution_reason, float(bar["close"]), bar)
                self.operation_adapter = None

        if len(self.bars) <= self.tracker_period:
            return
        previous = self.bars[-self.tracker_period - 1:-1]
        close = float(bar["close"])
        signal_data = tracker_signal(close, tracker_levels(previous))
        tracker_closed = False
        if self.tracker_operation is not None:
            tracked = self.tracker_operation
            raw_reason = tracker_close_reason(str(tracked["side"]), float(tracked["entry_price"]), close, float(tracked["stop_percent"]), float(tracked["target_percent"]))
            opposite_signal = signal_data is not None and signal_data[0] != tracked["side"]
            reason = raw_reason if raw_reason != "TP" or opposite_signal else None
            if reason is not None:
                tracker_closed = True
                await self.events.publish({"type": "TRACKER_OPERATION_CLOSED", "symbol": self.symbol, "side": tracked["side"], "reason": reason, "price": close, "bar_time": int(bar["time"]), "parameter_version": tracked.get("parameter_version")})
                self.tracker_operation = None
                self._schedule_recalibration()
                if reason == "TP":
                    side = "SHORT" if tracked["side"] == "LONG" else "LONG"
                    level = tracked.get("level", "H1")
                    signal_data = (side, level)

        if self.tracker_operation is None and signal_data is not None:
            side, level = signal_data
            self.tracker_operation = {
                "side": side, "level": level, "entry_time": int(bar["time"]), "entry_price": close,
                "stop_percent": self.stop_percent, "target_percent": self.target_percent,
                "parameter_version": self.parameter_version,
            }
            signal_id = f"{self.symbol}:{self.interval}:{bar['time']}:{side}:{level}"
            await self.events.publish({"type": "TRACKER_SIGNAL", "signal_id": signal_id, "symbol": self.symbol, "side": side, "level": level, "interval": self.interval, "bar_time": int(bar["time"]), "price": close, "stop_percent": self.stop_percent, "target_percent": self.target_percent, "tracker_period": self.tracker_period, "parameter_version": self.parameter_version, "mode": self.adapter.mode})
            # Executions mirror Tracker entries but own their independent
            # operation lifecycle and cannot feed back into strategy state.
            if self.operation is None:
                await self.adapter.open(self, side, close, {**bar, "level": level, "signal_id": signal_id})
                if self.operation is not None:
                    self.operation_adapter = self.adapter
        elif tracker_closed and self.tracker_operation is None and self.operation is None:
            # A Tracker SL can retry only when the same candle has a new signal.
            if signal_data is not None:
                side, level = signal_data
                signal_id = f"{self.symbol}:{self.interval}:{bar['time']}:{side}:{level}"
                await self.adapter.open(self, side, close, {**bar, "level": level, "signal_id": signal_id})
                if self.operation is not None:
                    self.operation_adapter = self.adapter

    def _schedule_recalibration(self) -> None:
        if self.recalibration_task is not None and not self.recalibration_task.done():
            return
        self.recalibration_task = asyncio.create_task(self._recalibrate(), name=f"tracker-calibration-{self.symbol}")

    async def _recalibrate(self) -> None:
        current = dict(self.adaptive_parameters)
        source_bars = list(self.bars)
        params = await asyncio.to_thread(
            calibrate_tracker_parameters, source_bars,
            risk_percent=float(current.get("risk_percent", 1.0)),
            leverage=float(current.get("leverage", 1.0)),
            initial_balance=float(current.get("initial_balance", 100.0)),
            current_tracker_period=self.tracker_period,
        )
        if not self.running:
            return
        self.adaptive_parameters = params
        self.tracker_period = int(params["tracker_period"])
        self.stop_percent = float(params["stop_percent"])
        self.target_percent = float(params["target_percent"])
        self.parameter_version += 1
        self.adaptive_parameters["parameter_version"] = self.parameter_version
        if self.tracker_operation is not None:
            self.tracker_operation.update({
                "stop_percent": self.stop_percent,
                "target_percent": self.target_percent,
                "parameter_version": self.parameter_version,
            })
        update_execution = getattr(self.operation_adapter or self.adapter, "update_parameters", None)
        if update_execution is not None:
            await update_execution(self)
        for operation, adapter in self.background_operations:
            update_background = getattr(adapter, "update_parameters", None)
            if update_background is None:
                continue
            current_operation, current_adapter = self.operation, self.operation_adapter
            self.operation, self.operation_adapter = operation, adapter
            try:
                await update_background(self)
            finally:
                self.operation, self.operation_adapter = current_operation, current_adapter
        await self._persist_runtime_snapshot()
        await self.events.publish({"type": "TRACKER_PARAMETERS_UPDATED", "symbol": self.symbol, **params, "parameter_version": self.parameter_version})

    async def _persist_runtime_snapshot(self) -> None:
        if self.runtime_store is None or self.lease_owner_id is None:
            return
        await asyncio.to_thread(
            self.runtime_store.save_runtime,
            self.user_id,
            self.symbol,
            self.lease_owner_id,
            last_bar_time=self.last_bar_time,
            status=self.status,
            tracker_operation=self.tracker_operation,
            adaptive_parameters=self.adaptive_parameters,
        )


class PaperExecutionAdapter:
    mode = "paper"

    def __init__(self, initial_balance: float = 100.0, risk_usdt: float = 1.0, fee_rate: float = 0.0014) -> None:
        self.initial_balance = initial_balance
        self.risk_usdt = risk_usdt
        self.fee_rate = max(0.0, float(fee_rate))

    async def open(self, worker: SymbolWorker, side: str, price: float, bar: dict[str, Any]) -> dict[str, Any]:
        direction = 1 if side == "LONG" else -1
        stop = price * (1 - direction * worker.stop_percent / 100)
        target = price * (1 + direction * worker.target_percent / 100)
        parameters = worker.adaptive_parameters
        risk_percent = max(0.01, min(float(parameters.get("risk_percent", 1.0)), 100.0))
        leverage = max(1.0, min(float(parameters.get("leverage", 1.0)), 125.0))
        risk_usdt = self.initial_balance * risk_percent / 100
        notional = min(risk_usdt / max(worker.stop_percent / 100, 0.000001), self.initial_balance * leverage)
        operation = {"id": f"paper-worker-{uuid4().hex[:12]}", "symbol": worker.symbol, "side": side, "chart": "entry", "level": bar.get("level"), "entry_time": int(bar["time"]), "entry_price": price, "current_time": int(bar["time"]), "current_price": price, "stop_time": int(bar["time"]), "stop_price": stop, "target_time": int(bar["time"]), "target_price": target, "stop_percent": worker.stop_percent, "target_percent": worker.target_percent, "parameter_version": worker.parameter_version, "status": "OPEN", "close_reason": None, "risk_percent": risk_percent, "notional": notional, "margin": notional / leverage, "pnl": 0.0, "source": "realtime-engine", "idempotency_key": f"tracker:{worker.symbol}:{worker.interval}:{bar['time']}:{side}:{bar.get('level', 'H1')}"}
        worker.operation = await asyncio.to_thread(_persist_open, worker, operation)
        await worker.events.publish({"type": "PAPER_ENTRY", "symbol": worker.symbol, "side": side, "price": price})
        return worker.operation

    async def update_parameters(self, worker: SymbolWorker) -> None:
        """Move an open Paper position's protection to the Tracker snapshot."""
        operation = worker.operation
        if operation is None:
            return
        direction = 1 if operation["side"] == "LONG" else -1
        entry = float(operation["entry_price"])
        stop = entry * (1 - direction * worker.stop_percent / 100)
        target = entry * (1 + direction * worker.target_percent / 100)
        operation.update({
            "stop_percent": worker.stop_percent,
            "target_percent": worker.target_percent,
            "stop_price": stop,
            "target_price": target,
            "parameter_version": worker.parameter_version,
        })
        await asyncio.to_thread(worker.paper_store.update, worker.user_id, operation["id"], {
            "stop_price": stop,
            "target_price": target,
        })

    async def close(self, worker: SymbolWorker, reason: str, price: float, bar: dict[str, Any]) -> dict[str, Any]:
        if worker.operation is None:
            return {}
        operation = worker.operation
        direction = 1 if operation["side"] == "LONG" else -1
        gross_pnl = (price - float(operation["entry_price"])) * direction * float(operation["notional"]) / float(operation["entry_price"])
        fees = float(operation["notional"]) * self.fee_rate
        pnl = gross_pnl - fees
        result = await asyncio.to_thread(_persist_close, worker, operation, reason, price, bar, pnl)
        worker.operation = None
        await worker.events.publish({"type": "PAPER_EXIT", "symbol": worker.symbol, "side": operation["side"], "reason": reason, "pnl": round(pnl, 6)})
        return result


class BinanceExecutionAdapter:
    mode = "live"

    def __init__(self, manager: BinanceMonitorManager, store: BinanceExecutionStore, quantity: float = 0.0, base_url: str = "https://fapi.binance.com") -> None:
        self.manager = manager
        self.store = store
        self.quantity = quantity
        self.base_url = base_url.rstrip("/")
        self._rules_cache: dict[str, tuple[float, float, float, float, float, int, int]] = {}

    def _rules(self, symbol: str) -> tuple[float, float, float, float, float, int, int]:
        cached = self._rules_cache.get(symbol)
        if cached is not None and time.monotonic() - cached[0] < 300:
            return cached
        response = httpx.get(f"{self.base_url}/fapi/v1/exchangeInfo", timeout=10)
        response.raise_for_status()
        payload = response.json()
        item = next((row for row in payload.get("symbols", []) if str(row.get("symbol", "")).upper() == symbol), None)
        if item is None:
            raise RuntimeError(f"Binance no encontró el símbolo {symbol}.")
        filters = {str(row.get("filterType")): row for row in item.get("filters", [])}
        lot = filters.get("MARKET_LOT_SIZE") or filters.get("LOT_SIZE") or {}
        notional = filters.get("NOTIONAL") or filters.get("MIN_NOTIONAL") or {}
        price = filters.get("PRICE_FILTER") or {}
        result = (time.monotonic(), float(lot.get("stepSize", 0) or 0), float(lot.get("minQty", 0) or 0),
                  float(notional.get("notional", notional.get("minNotional", 0)) or 0),
                  float(price.get("tickSize", 0) or 0), int(item.get("pricePrecision", 8)), int(item.get("quantityPrecision", 8)))
        self._rules_cache[symbol] = result
        return result

    @staticmethod
    def _align(value: float, step: float, precision: int, *, ceiling: bool) -> float:
        if step <= 0:
            return float(f"{value:.{precision}f}")
        rounding = ROUND_CEILING if ceiling else ROUND_FLOOR
        aligned = (Decimal(str(value)) / Decimal(str(step))).to_integral_value(rounding=rounding) * Decimal(str(step))
        return float(f"{aligned:.{precision}f}")

    def _sized_quantity(self, worker: "SymbolWorker", price: float) -> float:
        if self.quantity > 0:
            return self.quantity
        snapshot = self.manager.snapshot(worker.user_id)
        if not snapshot.get("healthy") or not snapshot.get("stream_connected"):
            raise RuntimeError("El User Data Stream de Binance se desconectó; no se abrirá una nueva operación.")
        available = float(snapshot.get("available_balance") or 0)
        if available <= 0:
            raise RuntimeError("Binance no reporta balance disponible para dimensionar la orden.")
        parameters = worker.adaptive_parameters
        leverage = max(1.0, min(float(parameters.get("leverage", 1)), 125.0))
        risk_percent = max(.01, min(float(parameters.get("risk_percent", 1)), 100.0))
        risk_amount = available * risk_percent / 100
        notional = min(risk_amount / max(worker.stop_percent / 100, .000001), available * leverage)
        _time, step, min_quantity, min_notional, _tick, _price_precision, quantity_precision = self._rules(worker.symbol)
        quantity = self._align(notional / price, step, quantity_precision, ceiling=False)
        if quantity <= 0 or quantity < min_quantity or quantity * price < min_notional:
            raise RuntimeError("El riesgo calculado queda debajo del tamaño mínimo permitido por Binance.")
        return quantity

    async def open(self, worker: SymbolWorker, side: str, price: float, bar: dict[str, Any]) -> dict[str, Any]:
        quantity = await asyncio.to_thread(self._sized_quantity, worker, price)
        order_side = "BUY" if side == "LONG" else "SELL"
        intent = await asyncio.to_thread(self.store.create, worker.user_id, {"symbol": worker.symbol, "side": side, "quantity": quantity, "entry_time": datetime.fromtimestamp(bar["time"], timezone.utc), "entry_price": price, "stop_loss": None, "take_profit": None, "signal_id": bar.get("signal_id")})
        if intent.get("reused"):
            status = str(intent.get("status", "")).upper()
            if status == "PROTECTED":
                position = await asyncio.to_thread(self.manager.position_risk, worker.user_id, worker.symbol)
                actual_quantity = abs(float(position.get("positionAmt", 0) or 0))
                if actual_quantity > 0:
                    worker.operation = {"id": intent["id"], "side": side, "level": bar.get("level"), "entry_price": float(intent.get("entry_price") or price), "quantity": actual_quantity, "notional": actual_quantity * float(intent.get("entry_price") or price), "stop_price": float(intent.get("stop_loss") or 0), "target_price": float(intent.get("take_profit") or 0), "stop_percent": worker.stop_percent, "target_percent": worker.target_percent, "parameter_version": worker.parameter_version, "status": "PROTECTED", "stop_algo_id": intent.get("stop_algo_id"), "take_profit_algo_id": intent.get("take_profit_algo_id")}
                    worker.operation_adapter = self
                else:
                    worker.status = "DEGRADED"
                    worker.last_error = "La intención Live ya existe; Binance todavía no confirma su posición. Requiere reconciliación."
                return intent
            worker.status = "DEGRADED"
            worker.last_error = f"Señal Tracker ya registrada con estado Live {status or 'desconocido'}; no se repetirá la orden."
            return intent
        close_side = "SELL" if side == "LONG" else "BUY"
        stop = price * (1 - (1 if side == "LONG" else -1) * worker.stop_percent / 100)
        target = price * (1 + (1 if side == "LONG" else -1) * worker.target_percent / 100)
        entry = None
        order_submission_started = False
        created_protections: list[dict[str, Any]] = []
        try:
            leverage = int(max(1, round(float(worker.adaptive_parameters.get("leverage", 1)))))
            await asyncio.to_thread(self.manager.set_symbol_margin_type, worker.user_id, worker.symbol, "ISOLATED")
            await asyncio.to_thread(self.manager.set_symbol_leverage, worker.user_id, worker.symbol, leverage)
            order_submission_started = True
            entry = await asyncio.to_thread(self.manager.place_market_order, worker.user_id, worker.symbol, order_side, quantity, str(intent["client_order_id"]))
            if isinstance(entry, dict) and str(entry.get("status", "")).upper() not in {"FILLED", ""}:
                raise RuntimeError(f"La entrada Binance no quedó completamente ejecutada: {entry.get('status')}.")
            average_open = float(entry.get("avgPrice") or entry.get("price") or price) if isinstance(entry, dict) else price
            actual_quantity = abs(float(entry.get("executedQty") or quantity)) if isinstance(entry, dict) else quantity
            if actual_quantity <= 0:
                raise RuntimeError("Binance no confirmó una cantidad ejecutada.")
            _time, _step, _min_qty, _min_notional, tick, price_precision, _qty_precision = self._rules(worker.symbol)
            stop = self._align(stop, tick, price_precision, ceiling=side == "SHORT")
            target = self._align(target, tick, price_precision, ceiling=side == "LONG")
            stop_order = await asyncio.to_thread(self.manager.place_close_protection, worker.user_id, worker.symbol, close_side, stop, f"{intent['client_order_id'][:26]}_sl", "STOP_MARKET")
            created_protections.append(stop_order)
            target_order = await asyncio.to_thread(self.manager.place_close_protection, worker.user_id, worker.symbol, close_side, target, f"{intent['client_order_id'][:25]}_tp", "TAKE_PROFIT_MARKET", working_type="CONTRACT_PRICE")
            created_protections.append(target_order)
            if not stop_order.get("algoId") or not target_order.get("algoId"):
                raise RuntimeError("Binance no confirmó los identificadores de ambas protecciones.")
            protected_intent = await asyncio.to_thread(self.store.mark_protected, intent["id"], worker.user_id, status="PROTECTED", exchange_order_id=str(entry.get("orderId") or "") if isinstance(entry, dict) else None, quantity=actual_quantity, entry_price=average_open, stop_loss=stop, take_profit=target, stop_algo_id=stop_order.get("algoId"), take_profit_algo_id=target_order.get("algoId"))
            if protected_intent is not None and str(protected_intent.get("status", "")).upper() == "CLOSED":
                for protection in created_protections:
                    if protection.get("algoId"):
                        await asyncio.to_thread(self.manager.cancel_close_protection, worker.user_id, worker.symbol, protection["algoId"])
                return intent
        except Exception as exc:
            if entry is None and order_submission_started:
                try:
                    entry = await asyncio.to_thread(self.manager.order_by_client_order_id, worker.user_id, worker.symbol, str(intent["client_order_id"]))
                except Exception as lookup_error:
                    await asyncio.to_thread(self.store.update, intent["id"], worker.user_id, status="RECONCILIATION_REQUIRED", last_error=f"order_lookup:{type(lookup_error).__name__}")
                    worker.status = "DEGRADED"
                    worker.last_error = "Binance no confirmó el resultado de la orden; se requiere reconciliación antes de reintentar."
                    await worker.events.publish({"type": "LIVE_RECONCILIATION_REQUIRED", "symbol": worker.symbol, "signal_id": bar.get("signal_id")})
                    logger.warning("live_worker_order_lookup_failed symbol=%s error_type=%s", worker.symbol, type(lookup_error).__name__)
                    return intent
            actual_quantity = abs(float(entry.get("executedQty") or 0)) if isinstance(entry, dict) else 0
            if actual_quantity > 0:
                average_open = float(entry.get("avgPrice") or entry.get("price") or price)
                try:
                    close_result = await asyncio.to_thread(self.manager.place_market_order, worker.user_id, worker.symbol, close_side, actual_quantity, f"{intent['client_order_id'][:24]}_emg", reduce_only=True)
                    closed = not isinstance(close_result, dict) or str(close_result.get("status", "")).upper() in {"FILLED", ""}
                except Exception as close_error:
                    closed = False
                    logger.warning("live_worker_emergency_close_failed symbol=%s error_type=%s", worker.symbol, type(close_error).__name__)
                try:
                    remaining = await asyncio.to_thread(self.manager.position_risk, worker.user_id, worker.symbol)
                    closed = closed and abs(float(remaining.get("positionAmt", 0) or 0)) <= 1e-12
                except Exception:
                    closed = False
                if closed:
                    for protection in created_protections:
                        if protection.get("algoId"):
                            try:
                                await asyncio.to_thread(self.manager.cancel_close_protection, worker.user_id, worker.symbol, protection["algoId"])
                            except Exception as cleanup_error:
                                logger.warning("live_worker_protection_cleanup_failed symbol=%s error_type=%s", worker.symbol, type(cleanup_error).__name__)
                    await asyncio.to_thread(self.store.update, intent["id"], worker.user_id, status="ERROR", last_error=f"entry_recovered_closed:{type(exc).__name__}")
                    return intent
                try:
                    _time, _step, _min_qty, _min_notional, tick, precision, _qty_precision = self._rules(worker.symbol)
                    direction = 1 if side == "LONG" else -1
                    fallback_stop = self._align(average_open * (1 - direction * worker.stop_percent / 100), tick, precision, ceiling=side == "SHORT")
                    fallback_target = self._align(average_open * (1 + direction * worker.target_percent / 100), tick, precision, ceiling=side == "LONG")
                    stop_order = await asyncio.to_thread(self.manager.place_close_protection, worker.user_id, worker.symbol, close_side, fallback_stop, f"{intent['client_order_id'][:26]}_sl", "STOP_MARKET")
                    created_protections.append(stop_order)
                    target_order = await asyncio.to_thread(self.manager.place_close_protection, worker.user_id, worker.symbol, close_side, fallback_target, f"{intent['client_order_id'][:25]}_tp", "TAKE_PROFIT_MARKET", working_type="CONTRACT_PRICE")
                    created_protections.append(target_order)
                    if not stop_order.get("algoId") or not target_order.get("algoId"):
                        raise RuntimeError("protection_ids_missing")
                    protected = await asyncio.to_thread(self.store.mark_protected, intent["id"], worker.user_id, status="PROTECTED", quantity=actual_quantity, entry_price=average_open, stop_loss=fallback_stop, take_profit=fallback_target, stop_algo_id=stop_order["algoId"], take_profit_algo_id=target_order["algoId"], last_error=None)
                    if protected is not None and str(protected.get("status", "")).upper() == "PROTECTED":
                        worker.operation = {"id": intent["id"], "side": side, "level": bar.get("level"), "entry_price": average_open, "quantity": actual_quantity, "notional": actual_quantity * average_open, "stop_price": fallback_stop, "target_price": fallback_target, "stop_percent": worker.stop_percent, "target_percent": worker.target_percent, "parameter_version": worker.parameter_version, "status": "PROTECTED", "stop_algo_id": stop_order["algoId"], "take_profit_algo_id": target_order["algoId"]}
                        worker.operation_adapter = self
                        await worker.events.publish({"type": "LIVE_ENTRY", "symbol": worker.symbol, "side": side, "price": average_open})
                        return intent
                except Exception as protection_error:
                    logger.warning("live_worker_fallback_protection_failed symbol=%s error_type=%s", worker.symbol, type(protection_error).__name__)
            await asyncio.to_thread(self.store.update, intent["id"], worker.user_id, status="UNPROTECTED_ERROR" if order_submission_started else "ERROR", last_error=f"execution_failed:{type(exc).__name__}")
            worker.status = "ERROR" if order_submission_started else worker.status
            worker.last_error = "No se pudo confirmar una ejecución Live segura; requiere revisión antes de nuevos intentos."
            await worker.events.publish({"type": "LIVE_RECONCILIATION_REQUIRED", "symbol": worker.symbol, "signal_id": bar.get("signal_id")})
            logger.warning("live_worker_entry_failed symbol=%s error_type=%s", worker.symbol, type(exc).__name__)
            return intent
        worker.operation = {"id": intent["id"], "side": side, "level": bar.get("level"), "entry_price": average_open, "quantity": actual_quantity, "notional": actual_quantity * average_open, "stop_price": stop, "target_price": target, "stop_percent": worker.stop_percent, "target_percent": worker.target_percent, "parameter_version": worker.parameter_version, "status": "PROTECTED", "stop_algo_id": stop_order.get("algoId"), "take_profit_algo_id": target_order.get("algoId")}
        worker.operation_adapter = self
        refreshed_intent = await asyncio.to_thread(self.store.get, intent["id"], worker.user_id)
        if refreshed_intent is not None and str(refreshed_intent.get("status", "")).upper() == "CLOSED":
            worker.operation = None
            worker.operation_adapter = None
            await worker.events.publish({"type": "LIVE_EXIT", "symbol": worker.symbol, "side": side, "reason": "BINANCE_FILL"})
            return intent
        await worker.events.publish({"type": "LIVE_ENTRY", "symbol": worker.symbol, "side": side, "price": price})
        return intent

    async def close(self, worker: SymbolWorker, reason: str, price: float, bar: dict[str, Any]) -> dict[str, Any]:
        operation = worker.operation
        if operation is None:
            return {}
        close_side = "SELL" if operation["side"] == "LONG" else "BUY"
        live_position = await asyncio.to_thread(self.manager.position_risk, worker.user_id, worker.symbol)
        actual_quantity = abs(float(live_position.get("positionAmt", 0) or 0))
        if actual_quantity > 0:
            close_result = await asyncio.to_thread(self.manager.place_market_order, worker.user_id, worker.symbol, close_side, actual_quantity, f"hwc_{uuid4().hex[:20]}", reduce_only=True)
            if isinstance(close_result, dict) and str(close_result.get("status", "")).upper() not in {"FILLED", ""}:
                await asyncio.to_thread(self.store.update, operation["id"], worker.user_id, status="CLOSING", last_error=f"cierre parcial o pendiente: {close_result.get('status')}")
                worker.status = "DEGRADED"
                worker.last_error = "El cierre de Binance sigue pendiente de reconciliación."
                return operation
        for field_name in ("stop_algo_id", "take_profit_algo_id"):
            algo_id = operation.get(field_name)
            if algo_id:
                try:
                    await asyncio.to_thread(self.manager.cancel_close_protection, worker.user_id, worker.symbol, algo_id)
                except Exception:
                    logger.warning("live_worker_protection_cancel_failed symbol=%s", worker.symbol, exc_info=True)
        await asyncio.to_thread(self.store.update, operation["id"], worker.user_id, status="CLOSED", last_error=None)
        worker.operation = None
        await worker.events.publish({"type": "LIVE_EXIT", "symbol": worker.symbol, "reason": reason, "price": price})
        return operation

    async def update_parameters(self, worker: "SymbolWorker") -> None:
        operation = worker.operation
        if operation is None:
            return
        direction = 1 if operation["side"] == "LONG" else -1
        entry = float(operation["entry_price"])
        stop = entry * (1 - direction * worker.stop_percent / 100)
        target = entry * (1 + direction * worker.target_percent / 100)
        _time, _step, _min_qty, _min_notional, tick, price_precision, _qty_precision = self._rules(worker.symbol)
        stop = self._align(stop, tick, price_precision, ceiling=operation["side"] == "SHORT")
        target = self._align(target, tick, price_precision, ceiling=operation["side"] == "LONG")
        close_side = "SELL" if operation["side"] == "LONG" else "BUY"
        new_orders: list[dict[str, Any]] = []
        try:
            new_orders.append(await asyncio.to_thread(self.manager.place_close_protection, worker.user_id, worker.symbol, close_side, stop, f"hwsl_{uuid4().hex[:18]}", "STOP_MARKET"))
            new_orders.append(await asyncio.to_thread(self.manager.place_close_protection, worker.user_id, worker.symbol, close_side, target, f"hwtp_{uuid4().hex[:18]}", "TAKE_PROFIT_MARKET", working_type="CONTRACT_PRICE"))
        except Exception:
            for order in new_orders:
                if order.get("algoId"):
                    try:
                        await asyncio.to_thread(self.manager.cancel_close_protection, worker.user_id, worker.symbol, order["algoId"])
                    except Exception:
                        logger.exception("live_worker_new_protection_cleanup_failed symbol=%s", worker.symbol)
            worker.status = "DEGRADED"
            worker.last_error = "No se pudieron reemplazar las protecciones Binance; se conservan las anteriores."
            logger.exception("live_worker_protection_update_failed symbol=%s", worker.symbol)
            return
        old_ids = (operation.get("stop_algo_id"), operation.get("take_profit_algo_id"))
        operation.update({"stop_price": stop, "target_price": target, "stop_percent": worker.stop_percent,
                          "target_percent": worker.target_percent, "parameter_version": worker.parameter_version,
                          "stop_algo_id": new_orders[0].get("algoId"), "take_profit_algo_id": new_orders[1].get("algoId")})
        await asyncio.to_thread(self.store.update, operation["id"], worker.user_id, stop_loss=stop, take_profit=target,
                                 stop_algo_id=operation["stop_algo_id"], take_profit_algo_id=operation["take_profit_algo_id"])
        for algo_id in old_ids:
            if algo_id:
                try:
                    await asyncio.to_thread(self.manager.cancel_close_protection, worker.user_id, worker.symbol, algo_id)
                except Exception:
                    logger.warning("live_worker_old_protection_cancel_failed symbol=%s", worker.symbol, exc_info=True)


def _persist_open(worker: SymbolWorker, operation: dict[str, Any]) -> dict[str, Any]:
    # Keep strategy metadata such as Tracker level in the worker memory, but
    # only send columns that exist in the paper_operations table.
    database_columns = {"id", "symbol", "side", "chart", "entry_time", "entry_price", "current_time", "current_price", "stop_time", "stop_price", "target_time", "target_price", "status", "close_reason", "risk_percent", "notional", "margin", "pnl", "source", "idempotency_key"}
    database_operation = {key: value for key, value in operation.items() if key in database_columns}
    database_operation["side"] = str(operation["side"]).lower()
    saved = worker.paper_store.create(worker.user_id, database_operation)
    return {**operation, "id": saved.get("id", operation["id"])}


def _persist_close(worker: SymbolWorker, operation: dict[str, Any], reason: str, price: float, bar: dict[str, Any], pnl: float) -> dict[str, Any]:
    return worker.paper_store.update(worker.user_id, operation["id"], {"current_time": int(bar["time"]), "current_price": price, "stop_time": int(bar["time"]) if reason == "SL" else operation.get("stop_time"), "target_time": int(bar["time"]) if reason == "TP" else operation.get("target_time"), "status": "CLOSED - WIN" if reason == "TP" else "CLOSED - FAILED", "close_reason": reason, "pnl": pnl}) or operation


def _restore_paper_operation(row: dict[str, Any]) -> dict[str, Any]:
    operation = dict(row)
    operation["side"] = str(operation.get("side", "long")).upper()
    operation["current_time"] = operation.get("current_time") or operation.get("entry_time")
    operation["current_price"] = operation.get("current_price") or operation.get("entry_price")
    operation["level"] = "H1"
    entry = float(operation.get("entry_price") or 0)
    if entry > 0:
        operation["stop_percent"] = abs(float(operation.get("stop_price") or entry) - entry) / entry * 100
        operation["target_percent"] = abs(float(operation.get("target_price") or entry) - entry) / entry * 100
    return operation


class ProductionWorkerManager:
    def __init__(self, gateway: BinanceMarketGateway, paper_store: PaperOperationStore, events: BackendEventBus, binance_manager: BinanceMonitorManager, execution_store: BinanceExecutionStore, config_store: ProductionWorkerConfigStore | None = None, base_url: str = "https://fapi.binance.com", live_enabled: bool = False) -> None:
        self.gateway = gateway
        self.paper_store = paper_store
        self.events = events
        self.binance_manager = binance_manager
        self.execution_store = execution_store
        self.config_store = config_store
        self.base_url = base_url
        self.live_enabled = bool(live_enabled)
        self.owner_id = uuid4().hex
        self.workers: dict[tuple[str, str], SymbolWorker] = {}
        self._user_locks: dict[str, asyncio.Lock] = {}

    async def start(self, user_id: str, symbol: str, **settings: Any) -> dict[str, Any]:
        lock = self._user_locks.setdefault(user_id, asyncio.Lock())
        async with lock:
            return await self._start_locked(user_id, symbol, **settings)

    async def _start_locked(self, user_id: str, symbol: str, *, mode: str = "paper", interval: str = "1m", tracker_period: int = 5, stop_percent: float = 0.2, target_percent: float = 1.0, quantity: float = 0.0, risk_percent: float = 1.0, leverage: float = 1.0, initial_balance: float = 100.0) -> dict[str, Any]:
        if mode not in {"signals_only", "paper", "live"}:
            raise ValueError("Modo de worker inválido.")
        if mode == "live":
            raise ValueError("El modo Binance del worker sigue bloqueado hasta completar reconciliación de fills y protecciones.")
        key = (user_id, symbol.upper())
        for other_key, other_worker in list(self.workers.items()):
            if other_key[0] == user_id and other_key != key:
                if other_worker.operation is not None or other_worker.background_operations:
                    raise ValueError(f"Cierra la operación abierta de {other_worker.symbol} antes de cambiar el símbolo.")
                await self._shutdown_worker(other_worker, status="SWITCHED")
                self.workers.pop(other_key, None)
                if self.config_store is not None:
                    await asyncio.to_thread(self.config_store.disable, user_id, other_worker.symbol)
        existing = self.workers.get(key)
        if existing is not None:
            if existing.running:
                return self.status(user_id, symbol)
            self.workers.pop(key, None)
        if self.config_store is not None:
            session_claimed = await asyncio.to_thread(self.config_store.claim_session, user_id, symbol.upper(), self.owner_id)
            if not session_claimed:
                raise ValueError("Ya existe una sesión activa para este usuario en otra instancia.")
            claimed = await asyncio.to_thread(self.config_store.claim_lease, user_id, symbol.upper(), self.owner_id)
            if not claimed:
                await asyncio.to_thread(self.config_store.release_session, user_id, symbol.upper(), self.owner_id)
                raise ValueError("Ya existe un worker activo para este símbolo en otra instancia.")
        adapter: ExecutionAdapter = SignalOnlyExecutionAdapter() if mode == "signals_only" else PaperExecutionAdapter(initial_balance=max(1.0, float(initial_balance)))
        worker = SymbolWorker(user_id, symbol.upper(), interval, max(1, int(tracker_period)), abs(float(stop_percent)), abs(float(target_percent)), adapter, self.paper_store, self.events)
        worker.runtime_store = self.config_store
        worker.session_store = self.config_store
        worker.event_loop = asyncio.get_running_loop()
        worker.lease_owner_id = self.owner_id if self.config_store is not None else None
        worker.history_provider = lambda: self.gateway.snapshot(worker.symbol, worker.interval)
        worker.bars = self.gateway.snapshot(worker.symbol, interval)[-WINDOW_BARS:]
        try:
            runtime = await asyncio.to_thread(self.config_store.runtime, user_id, worker.symbol) if self.config_store is not None else None
            if runtime is not None and runtime.get("last_bar_time") is not None:
                worker.last_bar_time = runtime.get("last_bar_time")
            if runtime is not None:
                worker.tracker_operation = runtime.get("tracker_operation")
                saved_parameters = runtime.get("adaptive_parameters")
                if isinstance(saved_parameters, dict) and saved_parameters:
                    worker.adaptive_parameters = saved_parameters
                    worker.tracker_period = max(4, min(20, int(saved_parameters.get("tracker_period", worker.tracker_period))))
                    worker.stop_percent = max(0.05, float(saved_parameters.get("stop_percent", worker.stop_percent)))
                    worker.target_percent = max(0.1, float(saved_parameters.get("target_percent", worker.target_percent)))
                    worker.parameter_version = int(saved_parameters.get("parameter_version", 0))
                    if isinstance(adapter, PaperExecutionAdapter):
                        adapter.initial_balance = max(1.0, float(saved_parameters.get("initial_balance", adapter.initial_balance)))
            if not worker.adaptive_parameters:
                worker.adaptive_parameters = {
                    "status": "INITIAL", "window_hours": min(8.0, len(worker.bars) / 60),
                    "bars": len(worker.bars), "tracker_period": worker.tracker_period,
                    "stop_percent": worker.stop_percent, "target_percent": worker.target_percent,
                    "risk_percent": max(0.01, min(float(risk_percent), 100.0)), "leverage": max(1.0, min(float(leverage), 125.0)),
                    "minroe_limit_percent": worker.stop_percent * max(1.0, min(float(leverage), 125.0)),
                    "initial_balance": max(1.0, min(float(initial_balance), 1_000_000.0)),
                    "risk_usdt": max(1.0, min(float(initial_balance), 1_000_000.0)) * max(0.01, min(float(risk_percent), 100.0)) / 100,
                    "sample_operations": 0,
                    "last_bar_time": worker.bars[-1]["time"] if worker.bars else None,
                }
            open_operation = await asyncio.to_thread(self.paper_store.open_for_symbol, user_id, worker.symbol)
            if open_operation is not None:
                restored_operation = _restore_paper_operation(open_operation)
                paper_adapter = adapter if mode == "paper" else PaperExecutionAdapter(
                    initial_balance=max(1.0, float(worker.adaptive_parameters.get("initial_balance", initial_balance)))
                )
                if mode == "paper":
                    worker.operation = restored_operation
                    worker.operation_adapter = paper_adapter
                else:
                    worker.background_operations.append((restored_operation, paper_adapter))
            if self.config_store is not None:
                await asyncio.to_thread(self.config_store.save, user_id, {"symbol": worker.symbol, "mode": mode, "interval": interval, "tracker_period": worker.tracker_period, "stop_percent": worker.stop_percent, "target_percent": worker.target_percent, "quantity": quantity, "risk_percent": worker.adaptive_parameters.get("risk_percent", risk_percent), "leverage": worker.adaptive_parameters.get("leverage", leverage), "initial_balance": worker.adaptive_parameters.get("initial_balance", initial_balance), "enabled": True})
        except Exception:
            if self.config_store is not None:
                await asyncio.to_thread(self.config_store.release_lease, user_id, worker.symbol, self.owner_id, "ERROR")
                await asyncio.to_thread(self.config_store.release_session, user_id, worker.symbol, self.owner_id)
            raise
        self.workers[key] = worker
        worker.on_lease_lost = lambda: (self.gateway.remove_listener(worker.symbol, worker.offer_market_event), self.workers.pop(key, None))
        worker.task = asyncio.create_task(worker.run(), name=f"production-worker-{user_id}-{worker.symbol}")
        await asyncio.wait_for(worker.started.wait(), timeout=1)
        self.gateway.add_listener(worker.symbol, worker.offer_market_event)
        worker.initialization_task = asyncio.create_task(self._initialize_worker(worker, runtime), name=f"production-worker-init-{user_id}-{worker.symbol}")
        await self.events.publish({"type": "WORKER_STARTED", "symbol": worker.symbol, "mode": mode})
        return self.status(user_id, symbol)

    async def _initialize_worker(self, worker: SymbolWorker, runtime: dict[str, Any] | None) -> None:
        restored_parameters = bool(runtime and isinstance(runtime.get("adaptive_parameters"), dict) and runtime.get("adaptive_parameters"))
        try:
            if len(self.gateway.snapshot(worker.symbol, worker.interval)) < WINDOW_BARS:
                await self.gateway.prime(worker.symbol, worker.interval, self.base_url)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            worker.status = "DEGRADED"
            worker.last_error = f"market history seed failed: {exc}"[:300]
            logger.exception("production_worker_history_seed_failed symbol=%s", worker.symbol)
        try:
            worker.bars = self.gateway.snapshot(worker.symbol, worker.interval)[-WINDOW_BARS:]
            closed_bars = [bar for bar in worker.bars if bar.get("closed")]
            gap_exceeded = False
            if worker.last_bar_time is None and closed_bars:
                worker.last_bar_time = int(closed_bars[-1]["time"])
            elif worker.last_bar_time is not None and closed_bars:
                interval_seconds = int(worker.interval[:-1]) * (60 if worker.interval.endswith("m") else 1)
                if int(closed_bars[0]["time"]) > int(worker.last_bar_time) + interval_seconds:
                    worker.status = "DEGRADED"
                    worker.last_error = "recovery gap exceeds retained candle history; resuming from latest closed candle"
                    worker.last_bar_time = int(closed_bars[-1]["time"])
                    gap_exceeded = True
            if runtime is not None and runtime.get("last_bar_time") is not None and not gap_exceeded:
                worker.bars = [bar for bar in worker.bars if bool(bar.get("closed")) and int(bar["time"]) <= int(runtime["last_bar_time"])]
            if runtime is not None and runtime.get("last_bar_time") is not None and not gap_exceeded:
                for bar in self.gateway.snapshot(worker.symbol, worker.interval)[-WINDOW_BARS:]:
                    if bool(bar.get("closed")) and int(bar["time"]) > worker.last_bar_time:
                        worker.offer_market_event({"type": "kline", "interval": worker.interval, "bar": bar})
            if not restored_parameters:
                params = await asyncio.to_thread(
                    calibrate_tracker_parameters,
                    list(worker.bars),
                    risk_percent=float(worker.adaptive_parameters.get("risk_percent", 1.0)),
                    leverage=float(worker.adaptive_parameters.get("leverage", 1.0)),
                    initial_balance=float(worker.adaptive_parameters.get("initial_balance", 100.0)),
                    current_tracker_period=worker.tracker_period,
                )
                worker.adaptive_parameters = params
                worker.tracker_period = int(params["tracker_period"])
                worker.stop_percent = float(params["stop_percent"])
                worker.target_percent = float(params["target_percent"])
                worker.parameter_version += 1
                worker.adaptive_parameters["parameter_version"] = worker.parameter_version
                await self.events.publish({"type": "TRACKER_PARAMETERS_UPDATED", "symbol": worker.symbol, **params, "parameter_version": worker.parameter_version})
                await worker._persist_runtime_snapshot()
        except Exception as exc:
            worker.status = "ERROR"
            worker.last_error = f"worker initialization failed: {exc}"[:300]
            logger.exception("production_worker_initialization_failed symbol=%s", worker.symbol)
        finally:
            worker.ready.set()

    async def stop(self, user_id: str, symbol: str) -> dict[str, Any]:
        lock = self._user_locks.setdefault(user_id, asyncio.Lock())
        async with lock:
            return await self._stop_locked(user_id, symbol)

    async def _stop_locked(self, user_id: str, symbol: str) -> dict[str, Any]:
        key = (user_id, symbol.upper())
        active = self.workers.get(key)
        if active is not None and (active.operation is not None or active.background_operations):
            raise ValueError("La sesión tiene una operación abierta; espera su cierre para detenerla sin dejarla sin supervisión.")
        worker = self.workers.pop(key, None)
        if worker is not None:
            await self._shutdown_worker(worker, status="STOPPED")
            await self.events.publish({"type": "WORKER_STOPPED", "symbol": worker.symbol})
        if self.config_store is not None:
            await asyncio.to_thread(self.config_store.disable, user_id, symbol)
            await asyncio.to_thread(self.config_store.release_lease, user_id, symbol, self.owner_id, "STOPPED")
            await asyncio.to_thread(self.config_store.release_session, user_id, symbol, self.owner_id)
        return self.status(user_id, symbol)

    async def activate(self, user_id: str, symbol: str, mode: str = "signals_only", **settings: Any) -> dict[str, Any]:
        """Activate the user's single Tracker session for the requested symbol."""
        current = self.workers.get((user_id, symbol.upper()))
        if current is not None and current.running:
            if current.adapter.mode != mode:
                return await self.set_mode(user_id, symbol, mode)
            return self.status(user_id, symbol)
        return await self.start(user_id, symbol, mode=mode, **settings)

    async def activate_live(self, user_id: str, symbol: str, **settings: Any) -> dict[str, Any]:
        """Start or retain Tracker, wait until ready, then arm Live for future signals."""
        status = await self.activate(user_id, symbol, mode="signals_only", **settings)
        worker = self.workers.get((user_id, symbol.upper()))
        if worker is None:
            raise RuntimeError("No se pudo crear la sesión Tracker para producción.")
        await worker.ready.wait()
        return await self.set_mode(user_id, symbol, "live")

    async def set_mode(self, user_id: str, symbol: str, mode: str) -> dict[str, Any]:
        lock = self._user_locks.setdefault(user_id, asyncio.Lock())
        async with lock:
            return await self._set_mode_locked(user_id, symbol, mode)

    async def _set_mode_locked(self, user_id: str, symbol: str, mode: str) -> dict[str, Any]:
        if mode not in {"signals_only", "paper", "live"}:
            raise ValueError("Modo inválido.")
        worker = self.workers.get((user_id, symbol.upper()))
        if worker is None or not worker.running:
            raise ValueError("No hay una sesión activa para ese símbolo.")
        if mode == "live":
            next_adapter = await self._prepare_live_adapter(worker)
            if worker.event_loop is None or worker.event_loop.is_closed():
                raise ValueError("No hay un event loop activo para vigilar las órdenes Binance.")
        elif mode == "signals_only":
            next_adapter = SignalOnlyExecutionAdapter()
        else:
            next_adapter = PaperExecutionAdapter(initial_balance=max(1.0, float(worker.adaptive_parameters.get("initial_balance", 100.0))))
        async with worker.state_lock:
            return await self._apply_mode_locked(worker, mode, next_adapter)

    async def _apply_mode_locked(self, worker: SymbolWorker, mode: str, next_adapter: ExecutionAdapter) -> dict[str, Any]:
        # Keep an existing operation supervised by the adapter that opened it,
        # while freeing the active slot for the next mode's future signal.
        if self.config_store is not None:
            await asyncio.to_thread(self.config_store.save, worker.user_id, {
                "symbol": worker.symbol, "mode": mode, "interval": worker.interval,
                "tracker_period": worker.tracker_period, "stop_percent": worker.stop_percent,
                "target_percent": worker.target_percent, "quantity": 0,
                "risk_percent": worker.adaptive_parameters.get("risk_percent", 1.0),
                "leverage": worker.adaptive_parameters.get("leverage", 1.0),
                "initial_balance": worker.adaptive_parameters.get("initial_balance", 100.0), "enabled": True,
            })
        if worker.operation is not None and worker.operation_adapter is not None and worker.operation_adapter.mode != mode:
            worker.background_operations.append((worker.operation, worker.operation_adapter))
            worker.operation = None
            worker.operation_adapter = None
        restore_index = next((index for index, (_operation, adapter) in enumerate(worker.background_operations) if adapter.mode == mode), None)
        if worker.operation is None and restore_index is not None:
            worker.operation, worker.operation_adapter = worker.background_operations.pop(restore_index)
        worker.adapter = next_adapter
        if mode == "live":
            self._subscribe_live_events(worker)
        await self.events.publish({"type": "WORKER_MODE_CHANGED", "symbol": worker.symbol, "mode": mode})
        return self.status(worker.user_id, worker.symbol)

    async def _prepare_live_adapter(self, worker: SymbolWorker) -> ExecutionAdapter:
        if not self.live_enabled:
            raise ValueError("Producción Binance sigue bloqueada por configuración hasta aprobar la validación Live.")
        snapshot = await asyncio.to_thread(self.binance_manager.snapshot, worker.user_id)
        if not snapshot.get("configured") or not snapshot.get("healthy") or not snapshot.get("stream_connected"):
            raise ValueError("La cuenta Binance debe estar configurada y su User Data Stream conectado antes de activar producción.")
        if float(snapshot.get("available_balance") or 0) <= 0:
            raise ValueError("Binance no reporta balance disponible para ejecutar producción.")
        positions = snapshot.get("positions") if isinstance(snapshot.get("positions"), list) else []
        same_symbol_positions = [position for position in positions if isinstance(position, dict) and str(position.get("symbol", "")).upper() == worker.symbol and abs(float(position.get("quantity", 0) or 0)) > 0]
        leverage = int(max(1, round(float(worker.adaptive_parameters.get("leverage", 1)))))
        if same_symbol_positions:
            managed_live = [(operation, adapter) for operation, adapter in worker.background_operations if adapter.mode == "live"]
            if worker.operation is not None and worker.operation_adapter is not None and worker.operation_adapter.mode == "live":
                managed_live.append((worker.operation, worker.operation_adapter))
            if len(managed_live) != 1:
                raise ValueError("Ya existe una posición Binance para este símbolo que no pertenece a esta sesión.")
            operation, _adapter = managed_live[0]
            intent = await asyncio.to_thread(self.execution_store.get, str(operation["id"]), worker.user_id)
            protections = await asyncio.to_thread(self.binance_manager.open_close_protections, worker.user_id, worker.symbol)
            position = await asyncio.to_thread(self.binance_manager.position_risk, worker.user_id, worker.symbol)
            exchange_quantity = float(position.get("positionAmt", 0) or 0)
            expected_side = str(operation.get("side", "")).upper()
            side_matches = exchange_quantity > 0 if expected_side == "LONG" else exchange_quantity < 0
            quantity_matches = abs(abs(exchange_quantity) - abs(float(operation.get("quantity", 0) or 0))) <= max(1e-9, abs(exchange_quantity) * .001)
            symbol_config = await asyncio.to_thread(self.binance_manager.symbol_config, worker.user_id, worker.symbol)
            active_ids = {str(item.get("algoId")) for item in protections}
            expected_ids = {str(operation.get("stop_algo_id")), str(operation.get("take_profit_algo_id"))}
            if (intent is None or str(intent.get("status", "")).upper() != "PROTECTED" or
                    not expected_ids.issubset(active_ids) or not side_matches or not quantity_matches or
                    str(symbol_config.get("margin_type", "")).upper() != "ISOLATED" or
                    int(symbol_config.get("leverage") or 0) != leverage):
                raise ValueError("La posición Binance no tiene sus dos protecciones activas y reconciliadas.")
        else:
            margin = await asyncio.to_thread(self.binance_manager.set_symbol_margin_type, worker.user_id, worker.symbol, "ISOLATED")
            leverage_config = await asyncio.to_thread(self.binance_manager.set_symbol_leverage, worker.user_id, worker.symbol, leverage)
            if str(margin.get("margin_type", "")).upper() != "ISOLATED" or int(leverage_config.get("leverage") or 0) != leverage:
                raise ValueError("Binance no confirmó el margen aislado y leverage solicitados.")
        adapter = BinanceExecutionAdapter(self.binance_manager, self.execution_store, 0, self.base_url)
        await asyncio.to_thread(adapter._rules, worker.symbol)
        return adapter

    async def _restore_live_operation(self, worker: SymbolWorker) -> None:
        intents = await asyncio.to_thread(self.execution_store.list, worker.user_id)
        active = [item for item in intents if str(item.get("symbol", "")).upper() == worker.symbol and str(item.get("status", "")).upper() not in {"CLOSED", "ERROR"}]
        if not active:
            return
        if len(active) != 1 or str(active[0].get("status", "")).upper() != "PROTECTED":
            raise ValueError("Hay una intención Live sin cierre reconciliado; no se reanudará producción automáticamente.")
        intent = active[0]
        snapshot = await asyncio.to_thread(self.binance_manager.snapshot, worker.user_id)
        if not snapshot.get("healthy") or not snapshot.get("stream_connected"):
            raise ValueError("User Data Stream no está listo para reconciliar la posición Live.")
        position = await asyncio.to_thread(self.binance_manager.position_risk, worker.user_id, worker.symbol)
        quantity = abs(float(position.get("positionAmt", 0) or 0))
        if quantity <= 0 or abs(quantity - abs(float(intent.get("quantity", 0) or 0))) > max(1e-9, quantity * .001):
            raise ValueError("La posición del exchange no coincide con la intención Live persistida.")
        position_amount = float(position.get("positionAmt", 0) or 0)
        expected_side = str(intent.get("side", "")).upper()
        if (expected_side == "LONG" and position_amount <= 0) or (expected_side == "SHORT" and position_amount >= 0):
            raise ValueError("El lado de la posición del exchange no coincide con la intención Live.")
        protections = await asyncio.to_thread(self.binance_manager.open_close_protections, worker.user_id, worker.symbol)
        active_ids = {str(item.get("algoId")) for item in protections}
        expected_ids = {str(intent.get("stop_algo_id")), str(intent.get("take_profit_algo_id"))}
        if not expected_ids.issubset(active_ids):
            raise ValueError("La posición Live no tiene SL y TP activos; queda en modo seguro para reconciliación.")
        price = float(intent.get("entry_price") or 0)
        adapter = BinanceExecutionAdapter(self.binance_manager, self.execution_store, 0, self.base_url)
        worker.operation = {"id": intent["id"], "side": str(intent.get("side", "LONG")).upper(), "entry_price": price,
                            "quantity": quantity, "notional": quantity * price, "stop_price": float(intent.get("stop_loss") or 0),
                            "target_price": float(intent.get("take_profit") or 0), "stop_percent": worker.stop_percent,
                            "target_percent": worker.target_percent, "parameter_version": worker.parameter_version,
                            "status": "PROTECTED", "stop_algo_id": intent.get("stop_algo_id"),
                            "take_profit_algo_id": intent.get("take_profit_algo_id")}
        worker.operation_adapter = adapter

    def _subscribe_live_events(self, worker: SymbolWorker) -> None:
        if worker.account_listener is not None:
            return
        loop = worker.event_loop
        if loop is None:
            raise RuntimeError("No hay event loop activo para reconciliar eventos Binance.")

        def receive(event: dict[str, object]) -> None:
            if loop.is_closed():
                return
            loop.call_soon_threadsafe(lambda: asyncio.create_task(self._reconcile_live_event(worker, event)))

        worker.account_listener = receive
        self.binance_manager.subscribe_events(worker.user_id, receive)

    async def _reconcile_live_event(self, worker: SymbolWorker, event: dict[str, object]) -> None:
        async with worker.state_lock:
            await self._reconcile_live_event_locked(worker, event)

    async def _reconcile_live_event_locked(self, worker: SymbolWorker, event: dict[str, object]) -> None:
        event_type = str(event.get("type", "")).upper()
        if event_type not in {"ORDER_TRADE_UPDATE", "ALGO_UPDATE"}:
            return
        await asyncio.to_thread(self.execution_store.reconcile_account_event, worker.user_id, event)
        operations = ([worker.operation, worker.operation_adapter] if worker.operation is not None else [None, None])
        candidates: list[tuple[dict[str, Any], ExecutionAdapter]] = []
        if isinstance(operations[0], dict) and operations[1] is not None:
            candidates.append((operations[0], operations[1]))
        candidates.extend(worker.background_operations)
        for operation, adapter in list(candidates):
            if adapter.mode != "live":
                continue
            intent = await asyncio.to_thread(self.execution_store.get, str(operation["id"]), worker.user_id)
            if intent is None or str(intent.get("status", "")).upper() != "CLOSED":
                continue
            if worker.operation is operation:
                worker.operation = None
                worker.operation_adapter = None
            else:
                worker.background_operations = [(op, item_adapter) for op, item_adapter in worker.background_operations if op is not operation]
            await worker.events.publish({"type": "LIVE_EXIT", "symbol": worker.symbol, "side": operation.get("side"), "reason": "BINANCE_FILL"})
            await worker._persist_runtime_snapshot()

    async def restore(self, *, resume_live: bool = False) -> None:
        if self.config_store is None:
            return
        for config in await asyncio.to_thread(self.config_store.enabled):
            try:
                user_id, symbol = str(config["user_id"]), str(config["symbol"])
                saved_mode = str(config["mode"])
                settings = {
                    "interval": str(config["interval"]), "tracker_period": int(config["tracker_period"]),
                    "stop_percent": float(config["stop_percent"]), "target_percent": float(config["target_percent"]),
                    "quantity": float(config["quantity"]), "risk_percent": float(config.get("risk_percent", 1.0)),
                    "leverage": float(config.get("leverage", 1.0)), "initial_balance": float(config.get("initial_balance", 100.0)),
                }
                if saved_mode != "live":
                    await self.start(user_id, symbol, mode=saved_mode, **settings)
                    continue
                if not resume_live:
                    continue
                await self.start(user_id, symbol, mode="signals_only", **settings)
                worker = self.workers.get((user_id, symbol.upper()))
                if worker is None:
                    continue
                await worker.ready.wait()
                try:
                    await self._restore_live_operation(worker)
                    await self.set_mode(user_id, symbol, "live")
                except Exception as exc:
                    worker.status = "DEGRADED"
                    worker.last_error = f"Live recovery blocked: {exc}"[:300]
                    logger.warning("production_worker_live_recovery_blocked symbol=%s", symbol, exc_info=True)
            except Exception:
                logger.exception("production_worker_restore_failed symbol=%s", config.get("symbol"))

    async def shutdown(self) -> None:
        """Stop in-process tasks while preserving enabled configs for restart recovery."""
        workers = list(self.workers.values())
        self.workers.clear()
        await asyncio.gather(*(self._shutdown_worker(worker, status="PAUSED") for worker in workers), return_exceptions=True)

    async def _shutdown_worker(self, worker: SymbolWorker, *, status: str) -> None:
        self.gateway.remove_listener(worker.symbol, worker.offer_market_event)
        if worker.account_listener is not None:
            self.binance_manager.unsubscribe_events(worker.user_id, worker.account_listener)
            worker.account_listener = None
        if worker.initialization_task is not None and not worker.initialization_task.done():
            worker.initialization_task.cancel()
            await asyncio.gather(worker.initialization_task, return_exceptions=True)
        if worker.recalibration_task is not None and not worker.recalibration_task.done():
            worker.recalibration_task.cancel()
            await asyncio.gather(worker.recalibration_task, return_exceptions=True)
        worker.ready.set()
        try:
            await asyncio.wait_for(worker.queue.join(), timeout=10)
        except TimeoutError:
            logger.warning("production_worker_drain_timeout symbol=%s queued=%d", worker.symbol, worker.queue.qsize())
        worker.running = False
        if worker.task is not None:
            if worker.queue.empty():
                worker.task.cancel()
            await asyncio.gather(worker.task, return_exceptions=True)
        if self.config_store is not None and worker.lease_owner_id is not None:
            await asyncio.to_thread(self.config_store.release_lease, worker.user_id, worker.symbol, worker.lease_owner_id, status)
            await asyncio.to_thread(self.config_store.release_session, worker.user_id, worker.symbol, worker.lease_owner_id)

    def status(self, user_id: str, symbol: str) -> dict[str, Any]:
        worker = self.workers.get((user_id, symbol.upper()))
        latencies = sorted(worker.latency_samples_ms) if worker else []
        percentile = lambda value: round(latencies[min(len(latencies) - 1, int((len(latencies) - 1) * value))], 3) if latencies else None
        return {"running": worker is not None and worker.running, "symbol": symbol.upper(), "mode": worker.adapter.mode if worker else None, "operation": worker.operation if worker else None, "tracker_operation": worker.tracker_operation if worker else None, "adaptive_parameters": worker.adaptive_parameters if worker else None, "parameter_version": worker.parameter_version if worker else None, "bars": len(worker.bars) if worker else 0, "status": worker.status if worker else "STOPPED", "last_bar_time": worker.last_bar_time if worker else None, "queue_depth": worker.queue.qsize() if worker else 0, "events_received": worker.events_received if worker else 0, "events_processed": worker.events_processed if worker else 0, "duplicate_events": worker.duplicate_events if worker else 0, "queue_overflows": worker.queue_overflows if worker else 0, "last_event_latency_ms": worker.last_event_latency_ms if worker else None, "p50_event_latency_ms": percentile(.5), "p95_event_latency_ms": percentile(.95), "max_event_latency_ms": round(latencies[-1], 3) if latencies else None, "last_error": worker.last_error if worker else None}

    def list(self, user_id: str) -> list[dict[str, Any]]:
        return [self.status(user_id, symbol) for uid, symbol in self.workers if uid == user_id]
