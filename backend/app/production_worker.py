"""Per-symbol strategy workers with Paper and Binance execution adapters."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import logging
import asyncio
import time
from collections import deque
from typing import Any, Protocol
from uuid import uuid4

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


class ExecutionAdapter(Protocol):
    mode: str

    async def open(self, worker: "SymbolWorker", side: str, price: float, bar: dict[str, Any]) -> dict[str, Any]: ...
    async def close(self, worker: "SymbolWorker", reason: str, price: float, bar: dict[str, Any]) -> dict[str, Any]: ...


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
        if owned:
            return True
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
        await self._evaluate(normalized)
        self.last_bar_time = normalized["time"]

    async def _evaluate(self, bar: dict[str, Any]) -> None:
        # Paper/Binance executions manage their own exits. These exits never
        # mutate Tracker's independent virtual position or signal sequence.
        if self.operation is not None:
            operation_stop = float(self.operation.get("stop_percent", self.stop_percent))
            operation_target = float(self.operation.get("target_percent", self.target_percent))
            execution_reason = tracker_close_reason(str(self.operation["side"]), float(self.operation["entry_price"]), float(bar["close"]), operation_stop, operation_target)
            if execution_reason is not None:
                await self.adapter.close(self, execution_reason, float(bar["close"]), bar)

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
                await self.adapter.open(self, side, close, {**bar, "level": level})
        elif tracker_closed and self.tracker_operation is None and self.operation is None:
            # A Tracker SL can retry only when the same candle has a new signal.
            if signal_data is not None:
                side, level = signal_data
                await self.adapter.open(self, side, close, {**bar, "level": level})

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
        update_execution = getattr(self.adapter, "update_parameters", None)
        if update_execution is not None:
            await update_execution(self)
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

    def __init__(self, manager: BinanceMonitorManager, store: BinanceExecutionStore, quantity: float) -> None:
        self.manager = manager
        self.store = store
        self.quantity = quantity

    async def open(self, worker: SymbolWorker, side: str, price: float, bar: dict[str, Any]) -> dict[str, Any]:
        order_side = "BUY" if side == "LONG" else "SELL"
        intent = await asyncio.to_thread(self.store.create, worker.user_id, {"symbol": worker.symbol, "side": side, "quantity": self.quantity, "entry_time": datetime.fromtimestamp(bar["time"], timezone.utc), "entry_price": price, "stop_loss": None, "take_profit": None})
        close_side = "SELL" if side == "LONG" else "BUY"
        stop = price * (1 - (1 if side == "LONG" else -1) * worker.stop_percent / 100)
        target = price * (1 + (1 if side == "LONG" else -1) * worker.target_percent / 100)
        entry = None
        try:
            entry = await asyncio.to_thread(self.manager.place_market_order, worker.user_id, worker.symbol, order_side, self.quantity, str(intent["client_order_id"]))
            average_open = float(entry.get("avgPrice") or entry.get("price") or price) if isinstance(entry, dict) else price
            actual_quantity = abs(float(entry.get("executedQty") or self.quantity)) if isinstance(entry, dict) else self.quantity
            await asyncio.to_thread(self.manager.place_close_protection, worker.user_id, worker.symbol, close_side, stop, f"{intent['client_order_id']}_sl", "STOP_MARKET")
            await asyncio.to_thread(self.manager.place_close_protection, worker.user_id, worker.symbol, close_side, target, f"{intent['client_order_id']}_tp", "TAKE_PROFIT_MARKET", working_type="CONTRACT_PRICE")
            await asyncio.to_thread(self.store.update, intent["id"], worker.user_id, status="PROTECTED", quantity=actual_quantity, entry_price=average_open, stop_loss=stop, take_profit=target)
        except Exception as exc:
            if entry is not None:
                try:
                    await asyncio.to_thread(self.manager.place_market_order, worker.user_id, worker.symbol, close_side, self.quantity, f"{intent['client_order_id']}_emergency", reduce_only=True)
                except Exception:
                    logger.exception("live_worker_emergency_close_failed symbol=%s", worker.symbol)
            await asyncio.to_thread(self.store.update, intent["id"], worker.user_id, status="ERROR", last_error=str(exc))
            raise
        worker.operation = {"id": intent["id"], "side": side, "level": bar.get("level"), "entry_price": average_open, "notional": actual_quantity * average_open, "stop_price": stop, "target_price": target, "stop_percent": worker.stop_percent, "target_percent": worker.target_percent, "parameter_version": worker.parameter_version, "status": "PROTECTED"}
        await worker.events.publish({"type": "LIVE_ENTRY", "symbol": worker.symbol, "side": side, "price": price})
        return intent

    async def close(self, worker: SymbolWorker, reason: str, price: float, bar: dict[str, Any]) -> dict[str, Any]:
        operation = worker.operation
        if operation is None:
            return {}
        close_side = "SELL" if operation["side"] == "LONG" else "BUY"
        await asyncio.to_thread(self.manager.place_market_order, worker.user_id, worker.symbol, close_side, self.quantity, f"{operation['id']}_close", reduce_only=True)
        await asyncio.to_thread(self.store.update, operation["id"], worker.user_id, status="CLOSED", last_error=None)
        worker.operation = None
        await worker.events.publish({"type": "LIVE_EXIT", "symbol": worker.symbol, "reason": reason, "price": price})
        return operation


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
    def __init__(self, gateway: BinanceMarketGateway, paper_store: PaperOperationStore, events: BackendEventBus, binance_manager: BinanceMonitorManager, execution_store: BinanceExecutionStore, config_store: ProductionWorkerConfigStore | None = None, base_url: str = "https://fapi.binance.com") -> None:
        self.gateway = gateway
        self.paper_store = paper_store
        self.events = events
        self.binance_manager = binance_manager
        self.execution_store = execution_store
        self.config_store = config_store
        self.base_url = base_url
        self.owner_id = uuid4().hex
        self.workers: dict[tuple[str, str], SymbolWorker] = {}

    async def start(self, user_id: str, symbol: str, *, mode: str = "paper", interval: str = "1m", tracker_period: int = 5, stop_percent: float = 0.2, target_percent: float = 1.0, quantity: float = 0.0, risk_percent: float = 1.0, leverage: float = 1.0, initial_balance: float = 100.0) -> dict[str, Any]:
        key = (user_id, symbol.upper())
        existing = self.workers.get(key)
        if existing is not None:
            if existing.running:
                return self.status(user_id, symbol)
            self.workers.pop(key, None)
        if mode == "live" and quantity <= 0:
            raise ValueError("quantity debe ser positiva para modo live")
        if self.config_store is not None:
            claimed = await asyncio.to_thread(self.config_store.claim_lease, user_id, symbol.upper(), self.owner_id)
            if not claimed:
                raise ValueError("Ya existe un worker activo para este símbolo en otra instancia.")
        adapter: ExecutionAdapter = PaperExecutionAdapter(initial_balance=max(1.0, float(initial_balance))) if mode == "paper" else BinanceExecutionAdapter(self.binance_manager, self.execution_store, quantity)
        worker = SymbolWorker(user_id, symbol.upper(), interval, max(1, int(tracker_period)), abs(float(stop_percent)), abs(float(target_percent)), adapter, self.paper_store, self.events)
        worker.runtime_store = self.config_store
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
            open_operation = await asyncio.to_thread(self.paper_store.open_for_symbol, user_id, worker.symbol) if mode == "paper" else None
            if open_operation is not None:
                worker.operation = _restore_paper_operation(open_operation)
            if self.config_store is not None:
                await asyncio.to_thread(self.config_store.save, user_id, {"symbol": worker.symbol, "mode": mode, "interval": interval, "tracker_period": worker.tracker_period, "stop_percent": worker.stop_percent, "target_percent": worker.target_percent, "quantity": quantity, "risk_percent": worker.adaptive_parameters.get("risk_percent", risk_percent), "leverage": worker.adaptive_parameters.get("leverage", leverage), "initial_balance": worker.adaptive_parameters.get("initial_balance", initial_balance), "enabled": True})
        except Exception:
            if self.config_store is not None:
                await asyncio.to_thread(self.config_store.release_lease, user_id, worker.symbol, self.owner_id, "ERROR")
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
        key = (user_id, symbol.upper())
        worker = self.workers.pop(key, None)
        if worker is not None:
            await self._shutdown_worker(worker, status="STOPPED")
            await self.events.publish({"type": "WORKER_STOPPED", "symbol": worker.symbol})
        if self.config_store is not None:
            await asyncio.to_thread(self.config_store.disable, user_id, symbol)
        return self.status(user_id, symbol)

    async def restore(self, *, resume_live: bool = False) -> None:
        if self.config_store is None:
            return
        for config in await asyncio.to_thread(self.config_store.enabled):
            if config.get("mode") == "live" and not resume_live:
                continue
            try:
                await self.start(str(config["user_id"]), str(config["symbol"]), mode=str(config["mode"]), interval=str(config["interval"]), tracker_period=int(config["tracker_period"]), stop_percent=float(config["stop_percent"]), target_percent=float(config["target_percent"]), quantity=float(config["quantity"]), risk_percent=float(config.get("risk_percent", 1.0)), leverage=float(config.get("leverage", 1.0)), initial_balance=float(config.get("initial_balance", 100.0)))
            except Exception:
                logger.exception("production_worker_restore_failed symbol=%s", config.get("symbol"))

    async def shutdown(self) -> None:
        """Stop in-process tasks while preserving enabled configs for restart recovery."""
        workers = list(self.workers.values())
        self.workers.clear()
        await asyncio.gather(*(self._shutdown_worker(worker, status="PAUSED") for worker in workers), return_exceptions=True)

    async def _shutdown_worker(self, worker: SymbolWorker, *, status: str) -> None:
        self.gateway.remove_listener(worker.symbol, worker.offer_market_event)
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

    def status(self, user_id: str, symbol: str) -> dict[str, Any]:
        worker = self.workers.get((user_id, symbol.upper()))
        latencies = sorted(worker.latency_samples_ms) if worker else []
        percentile = lambda value: round(latencies[min(len(latencies) - 1, int((len(latencies) - 1) * value))], 3) if latencies else None
        return {"running": worker is not None and worker.running, "symbol": symbol.upper(), "mode": worker.adapter.mode if worker else None, "operation": worker.operation if worker else None, "tracker_operation": worker.tracker_operation if worker else None, "adaptive_parameters": worker.adaptive_parameters if worker else None, "parameter_version": worker.parameter_version if worker else None, "bars": len(worker.bars) if worker else 0, "status": worker.status if worker else "STOPPED", "last_bar_time": worker.last_bar_time if worker else None, "queue_depth": worker.queue.qsize() if worker else 0, "events_received": worker.events_received if worker else 0, "events_processed": worker.events_processed if worker else 0, "duplicate_events": worker.duplicate_events if worker else 0, "queue_overflows": worker.queue_overflows if worker else 0, "last_event_latency_ms": worker.last_event_latency_ms if worker else None, "p50_event_latency_ms": percentile(.5), "p95_event_latency_ms": percentile(.95), "max_event_latency_ms": round(latencies[-1], 3) if latencies else None, "last_error": worker.last_error if worker else None}

    def list(self, user_id: str) -> list[dict[str, Any]]:
        return [self.status(user_id, symbol) for uid, symbol in self.workers if uid == user_id]
