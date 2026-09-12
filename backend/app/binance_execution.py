"""Backend-owned Binance runtime.

The supervisor keeps private account streams alive without a browser. Order
submission is behind a separate explicit production switch; the supervisor
itself never mutates the exchange.
"""

from __future__ import annotations

from datetime import datetime, timezone
import logging
import threading
import time
from uuid import uuid4

from sqlalchemy import insert, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.sql import column, table

from app.binance_credentials import BinanceCredentialStore, BinanceMonitorManager
from app.config import Settings

logger = logging.getLogger(__name__)

execution_intents_table = table(
    "binance_execution_intents",
    column("id"), column("user_id"), column("symbol"), column("side"), column("quantity"), column("entry_time"), column("entry_price"),
    column("stop_loss"), column("take_profit"), column("status"), column("exchange_order_id"),
    column("client_order_id"), column("stop_algo_id"), column("take_profit_algo_id"), column("last_error"), column("created_at"), column("updated_at"),
)


class BinanceExecutionStore:
    def __init__(self, engine: Engine):
        self._engine = engine

    def list(self, user_id: str) -> list[dict[str, object]]:
        query = select(execution_intents_table).where(
            execution_intents_table.c.user_id == user_id
        ).order_by(execution_intents_table.c.created_at.desc())
        with self._engine.connect() as connection:
            return [dict(row) for row in connection.execute(query).mappings().all()]

    def create(self, user_id: str, values: dict[str, object]) -> dict[str, object]:
        now = datetime.now(timezone.utc)
        intent = {
            **values,
            "id": str(uuid4()),
            "user_id": user_id,
            "status": "PENDING_APPROVAL",
            "client_order_id": f"helloworld_{uuid4().hex[:20]}",
            "created_at": now,
            "updated_at": now,
        }
        with self._engine.begin() as connection:
            connection.execute(insert(execution_intents_table).values(**intent))
        return intent

    def update(self, intent_id: str, user_id: str, **values: object) -> dict[str, object] | None:
        values["updated_at"] = datetime.now(timezone.utc)
        with self._engine.begin() as connection:
            connection.execute(update(execution_intents_table).where(
                execution_intents_table.c.id == intent_id,
                execution_intents_table.c.user_id == user_id,
            ).values(**values))
            row = connection.execute(select(execution_intents_table).where(
                execution_intents_table.c.id == intent_id,
                execution_intents_table.c.user_id == user_id,
            )).mappings().first()
        return dict(row) if row else None

    def reconcile_events(self, user_id: str, events: list[dict[str, object]]) -> None:
        """Project Binance User Stream order events onto durable intent state."""
        intents = self.list(user_id)
        for intent in intents:
            root = str(intent.get("client_order_id") or "")
            for event in events:
                client_id = str(event.get("client_order_id") or "")
                if not client_id.startswith(root):
                    continue
                status = str(event.get("status") or "")
                if client_id == root and status == "FILLED":
                    self.update(intent["id"], user_id, status="ENTRY_FILLED", exchange_order_id=str(event.get("exchange_order_id") or intent.get("exchange_order_id")))
                elif client_id != root and status == "FILLED":
                    self.update(intent["id"], user_id, status="CLOSED", last_error=None)


class BinanceExecutionSupervisor:
    """Ensure every configured user's account stream runs independently of UI."""

    def __init__(self, settings: Settings, credentials: BinanceCredentialStore, monitors: BinanceMonitorManager, store: BinanceExecutionStore):
        self._settings = settings
        self._credentials = credentials
        self._monitors = monitors
        self._store = store
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._status = {"enabled": settings.binance_execution_worker_enabled, "running": False, "last_cycle": None, "users": 0}
        self._lock = threading.Lock()
        self._subscribed_users: set[str] = set()

    def start(self) -> None:
        if not self._settings.binance_execution_worker_enabled or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="binance-execution-supervisor", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=4)
        self._thread = None
        with self._lock:
            self._status["running"] = False

    def status(self) -> dict[str, object]:
        with self._lock:
            return dict(self._status)

    def _run(self) -> None:
        with self._lock:
            self._status["running"] = True
        # This is only a low-frequency lifecycle sweep. Order/position state
        # arrives through the private User Data Stream, never through this loop.
        delay = max(30, min(int(self._settings.binance_execution_poll_seconds), 300))
        while not self._stop.is_set():
            try:
                users = self._credentials.user_ids()
                for user_id in users:
                    if user_id in self._subscribed_users:
                        continue
                    self._monitors.subscribe_events(user_id, lambda event, uid=user_id: self._on_account_event(uid, event))
                    # snapshot() starts/reuses the resilient User Data Stream.
                    self._monitors.snapshot(user_id)
                    self._subscribed_users.add(user_id)
                self._subscribed_users.intersection_update(users)
                with self._lock:
                    self._status.update({"last_cycle": datetime.now(timezone.utc).isoformat(), "users": len(users)})
            except Exception:
                logger.exception("binance_execution_supervisor_cycle_failed")
            self._stop.wait(delay)

    def _on_account_event(self, user_id: str, event: dict[str, object]) -> None:
        if event.get("type") != "ORDER_TRADE_UPDATE":
            return
        order = event.get("event")
        if not isinstance(order, dict):
            return
        payload = order.get("o")
        if not isinstance(payload, dict):
            return
        self._store.reconcile_events(user_id, [{
            "client_order_id": payload.get("c"),
            "status": payload.get("X"),
            "exchange_order_id": payload.get("i"),
        }])
