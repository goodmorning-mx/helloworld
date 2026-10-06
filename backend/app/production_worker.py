"""Per-symbol strategy workers with Paper and Binance execution adapters."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import logging
from typing import Any, Protocol
from uuid import uuid4

from sqlalchemy import insert, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.sql import column, table

from app.binance_credentials import BinanceMonitorManager
from app.binance_execution import BinanceExecutionStore
from app.market_gateway import BinanceMarketGateway
from app.paper_operations import PaperOperationStore
from app.telegram_service import BackendEventBus

logger = logging.getLogger(__name__)

production_worker_configs_table = table(
    "production_worker_configs",
    column("id"), column("user_id"), column("symbol"), column("mode"), column("interval"),
    column("tracker_period"), column("stop_percent"), column("target_percent"), column("quantity"),
    column("enabled"), column("created_at"), column("updated_at"),
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
    running: bool = True
    last_bar_time: int | None = None

    async def on_market_event(self, event: dict[str, Any]) -> None:
        if not self.running or event.get("type") != "kline" or event.get("interval") != self.interval:
            return
        bar = event.get("bar")
        if not isinstance(bar, dict) or not bool(bar.get("closed")):
            return
        normalized = {key: float(bar[key]) if key != "time" else int(bar[key]) for key in ("time", "open", "high", "low", "close")}
        if normalized["time"] == self.last_bar_time:
            return
        self.last_bar_time = normalized["time"]
        self.bars = [item for item in self.bars if int(item["time"]) != normalized["time"]][-1499:] + [normalized]
        await self._evaluate(normalized)

    async def _evaluate(self, bar: dict[str, Any]) -> None:
        if len(self.bars) <= self.tracker_period:
            return
        previous = self.bars[-self.tracker_period - 1:-1]
        highpointer = max(float(item["high"]) for item in previous)
        lowpointer = min(float(item["low"]) for item in previous)
        maxpointer = max(max(float(item["open"]), float(item["close"])) for item in previous)
        minpointer = min(min(float(item["open"]), float(item["close"])) for item in previous)
        close = float(bar["close"])
        signal: str | None = None
        level: str | None = None
        if close >= maxpointer and close >= highpointer:
            signal, level = "SHORT", "H2"
        elif close >= maxpointer and close < highpointer:
            signal, level = "SHORT", "H1"
        elif close <= minpointer and close > lowpointer:
            signal, level = "LONG", "L1"
        elif close <= lowpointer and close <= minpointer:
            signal, level = "LONG", "L2"

        if self.operation is not None:
            direction = 1 if self.operation["side"] == "LONG" else -1
            stop_hit = float(bar["low"]) <= self.operation["stop_price"] if direction == 1 else float(bar["high"]) >= self.operation["stop_price"]
            target_hit = float(bar["high"]) >= self.operation["target_price"] if direction == 1 else float(bar["low"]) <= self.operation["target_price"]
            if stop_hit or target_hit:
                await self.adapter.close(self, "SL" if stop_hit else "TP", close, bar)
        if self.operation is None and signal is not None:
            await self.adapter.open(self, signal, close, {**bar, "level": level})


class PaperExecutionAdapter:
    mode = "paper"

    def __init__(self, initial_balance: float = 100.0, risk_usdt: float = 1.0) -> None:
        self.initial_balance = initial_balance
        self.risk_usdt = risk_usdt

    async def open(self, worker: SymbolWorker, side: str, price: float, bar: dict[str, Any]) -> dict[str, Any]:
        direction = 1 if side == "LONG" else -1
        stop = price * (1 - direction * worker.stop_percent / 100)
        target = price * (1 + direction * worker.target_percent / 100)
        notional = self.risk_usdt / (worker.stop_percent / 100)
        operation = {"id": f"paper-worker-{uuid4().hex[:12]}", "symbol": worker.symbol, "side": side, "entry_time": datetime.fromtimestamp(bar["time"], timezone.utc), "entry_price": price, "current_time": datetime.fromtimestamp(bar["time"], timezone.utc), "current_price": price, "stop_time": None, "stop_price": stop, "target_time": None, "target_price": target, "status": "OPEN", "close_reason": None, "risk_percent": None, "notional": notional, "margin": notional, "pnl": 0.0}
        worker.operation = _persist_open(worker, operation)
        await worker.events.publish({"type": "PAPER_ENTRY", "symbol": worker.symbol, "side": side, "price": price})
        return worker.operation

    async def close(self, worker: SymbolWorker, reason: str, price: float, bar: dict[str, Any]) -> dict[str, Any]:
        if worker.operation is None:
            return {}
        operation = worker.operation
        direction = 1 if operation["side"] == "LONG" else -1
        pnl = (price - float(operation["entry_price"])) * direction * float(operation["notional"]) / float(operation["entry_price"])
        result = _persist_close(worker, operation, reason, price, bar, pnl)
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
        intent = self.store.create(worker.user_id, {"symbol": worker.symbol, "side": side, "quantity": self.quantity, "entry_time": datetime.fromtimestamp(bar["time"], timezone.utc), "entry_price": price, "stop_loss": None, "take_profit": None})
        close_side = "SELL" if side == "LONG" else "BUY"
        stop = price * (1 - (1 if side == "LONG" else -1) * worker.stop_percent / 100)
        target = price * (1 + (1 if side == "LONG" else -1) * worker.target_percent / 100)
        entry = None
        try:
            entry = self.manager.place_market_order(worker.user_id, worker.symbol, order_side, self.quantity, str(intent["client_order_id"]))
            average_open = float(entry.get("avgPrice") or entry.get("price") or price) if isinstance(entry, dict) else price
            actual_quantity = abs(float(entry.get("executedQty") or self.quantity)) if isinstance(entry, dict) else self.quantity
            self.manager.place_close_protection(worker.user_id, worker.symbol, close_side, stop, f"{intent['client_order_id']}_sl", "STOP_MARKET")
            self.manager.place_close_protection(worker.user_id, worker.symbol, close_side, target, f"{intent['client_order_id']}_tp", "TAKE_PROFIT_MARKET", working_type="CONTRACT_PRICE")
            self.store.update(intent["id"], worker.user_id, status="PROTECTED", quantity=actual_quantity, entry_price=average_open, stop_loss=stop, take_profit=target)
        except Exception as exc:
            if entry is not None:
                try:
                    self.manager.place_market_order(worker.user_id, worker.symbol, close_side, self.quantity, f"{intent['client_order_id']}_emergency", reduce_only=True)
                except Exception:
                    logger.exception("live_worker_emergency_close_failed symbol=%s", worker.symbol)
            self.store.update(intent["id"], worker.user_id, status="ERROR", last_error=str(exc))
            raise
        worker.operation = {"id": intent["id"], "side": side, "entry_price": average_open, "notional": actual_quantity * average_open, "stop_price": stop, "target_price": target, "status": "PROTECTED"}
        await worker.events.publish({"type": "LIVE_ENTRY", "symbol": worker.symbol, "side": side, "price": price})
        return intent

    async def close(self, worker: SymbolWorker, reason: str, price: float, bar: dict[str, Any]) -> dict[str, Any]:
        operation = worker.operation
        if operation is None:
            return {}
        close_side = "SELL" if operation["side"] == "LONG" else "BUY"
        self.manager.place_market_order(worker.user_id, worker.symbol, close_side, self.quantity, f"{operation['id']}_close", reduce_only=True)
        self.store.update(operation["id"], worker.user_id, status="CLOSED", last_error=None)
        worker.operation = None
        await worker.events.publish({"type": "LIVE_EXIT", "symbol": worker.symbol, "reason": reason, "price": price})
        return operation


def _persist_open(worker: SymbolWorker, operation: dict[str, Any]) -> dict[str, Any]:
    database_operation = {**operation, "side": str(operation["side"]).lower()}
    saved = worker.paper_store.create(worker.user_id, database_operation)
    return {**operation, "id": saved.get("id", operation["id"])}


def _persist_close(worker: SymbolWorker, operation: dict[str, Any], reason: str, price: float, bar: dict[str, Any], pnl: float) -> dict[str, Any]:
    return worker.paper_store.update(worker.user_id, operation["id"], {"current_time": datetime.fromtimestamp(bar["time"], timezone.utc), "current_price": price, "stop_time": datetime.fromtimestamp(bar["time"], timezone.utc) if reason == "SL" else None, "target_time": datetime.fromtimestamp(bar["time"], timezone.utc) if reason == "TP" else None, "status": "CLOSED - WIN" if reason == "TP" else "CLOSED - FAILED", "close_reason": reason, "pnl": pnl}) or operation


class ProductionWorkerManager:
    def __init__(self, gateway: BinanceMarketGateway, paper_store: PaperOperationStore, events: BackendEventBus, binance_manager: BinanceMonitorManager, execution_store: BinanceExecutionStore, config_store: ProductionWorkerConfigStore | None = None) -> None:
        self.gateway = gateway
        self.paper_store = paper_store
        self.events = events
        self.binance_manager = binance_manager
        self.execution_store = execution_store
        self.config_store = config_store
        self.workers: dict[tuple[str, str], SymbolWorker] = {}

    async def start(self, user_id: str, symbol: str, *, mode: str = "paper", interval: str = "1m", tracker_period: int = 5, stop_percent: float = 0.2, target_percent: float = 1.0, quantity: float = 0.0) -> dict[str, Any]:
        key = (user_id, symbol.upper())
        existing = self.workers.get(key)
        if existing is not None:
            return self.status(user_id, symbol)
        if mode == "live" and quantity <= 0:
            raise ValueError("quantity debe ser positiva para modo live")
        adapter: ExecutionAdapter = PaperExecutionAdapter() if mode == "paper" else BinanceExecutionAdapter(self.binance_manager, self.execution_store, quantity)
        worker = SymbolWorker(user_id, symbol.upper(), interval, max(1, int(tracker_period)), abs(float(stop_percent)), abs(float(target_percent)), adapter, self.paper_store, self.events)
        worker.bars = self.gateway.snapshot(worker.symbol, interval)[-1500:]
        self.workers[key] = worker
        self.gateway.add_listener(worker.symbol, worker.on_market_event)
        if self.config_store is not None:
            self.config_store.save(user_id, {"symbol": worker.symbol, "mode": mode, "interval": interval, "tracker_period": worker.tracker_period, "stop_percent": worker.stop_percent, "target_percent": worker.target_percent, "quantity": quantity, "enabled": True})
        await self.events.publish({"type": "WORKER_STARTED", "symbol": worker.symbol, "mode": mode})
        return self.status(user_id, symbol)

    async def stop(self, user_id: str, symbol: str) -> dict[str, Any]:
        key = (user_id, symbol.upper())
        worker = self.workers.pop(key, None)
        if worker is not None:
            worker.running = False
            self.gateway.remove_listener(worker.symbol, worker.on_market_event)
            await self.events.publish({"type": "WORKER_STOPPED", "symbol": worker.symbol})
        if self.config_store is not None:
            self.config_store.disable(user_id, symbol)
        return self.status(user_id, symbol)

    async def restore(self, *, resume_live: bool = False) -> None:
        if self.config_store is None:
            return
        for config in self.config_store.enabled():
            if config.get("mode") == "live" and not resume_live:
                continue
            try:
                await self.start(str(config["user_id"]), str(config["symbol"]), mode=str(config["mode"]), interval=str(config["interval"]), tracker_period=int(config["tracker_period"]), stop_percent=float(config["stop_percent"]), target_percent=float(config["target_percent"]), quantity=float(config["quantity"]))
            except Exception:
                logger.exception("production_worker_restore_failed symbol=%s", config.get("symbol"))

    def status(self, user_id: str, symbol: str) -> dict[str, Any]:
        worker = self.workers.get((user_id, symbol.upper()))
        return {"running": worker is not None and worker.running, "symbol": symbol.upper(), "mode": worker.adapter.mode if worker else None, "operation": worker.operation if worker else None, "bars": len(worker.bars) if worker else 0}

    def list(self, user_id: str) -> list[dict[str, Any]]:
        return [self.status(user_id, symbol) for uid, symbol in self.workers if uid == user_id]
