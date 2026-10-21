"""Backend-owned Binance runtime.

The supervisor keeps private account streams alive without a browser. Order
submission is behind a separate explicit production switch; the supervisor
itself never mutates the exchange.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import logging
import threading
import time
from uuid import uuid4

from sqlalchemy import insert, select, update, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import Engine
from sqlalchemy.sql import column, table

from app.binance_credentials import BinanceCredentialStore, BinanceMonitorManager
from app.config import Settings

logger = logging.getLogger(__name__)

execution_intents_table = table(
    "binance_execution_intents",
    column("id"), column("user_id"), column("symbol"), column("side"), column("quantity"), column("entry_time"), column("entry_price"),
    column("stop_loss"), column("take_profit"), column("status"), column("exchange_order_id"),
    column("client_order_id"), column("signal_id"), column("stop_algo_id"), column("take_profit_algo_id"), column("last_error"), column("created_at"), column("updated_at"),
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

    def get(self, intent_id: str, user_id: str) -> dict[str, object] | None:
        with self._engine.connect() as connection:
            row = connection.execute(select(execution_intents_table).where(
                execution_intents_table.c.id == intent_id,
                execution_intents_table.c.user_id == user_id,
            )).mappings().first()
            return dict(row) if row else None

    def create(self, user_id: str, values: dict[str, object]) -> dict[str, object]:
        now = datetime.now(timezone.utc)
        signal_id = str(values.get("signal_id") or "")
        client_order_id = f"hw_{hashlib.sha256(signal_id.encode()).hexdigest()[:32]}" if signal_id else f"helloworld_{uuid4().hex[:20]}"
        intent = {
            **values,
            "id": str(uuid4()),
            "user_id": user_id,
            "status": "PENDING_APPROVAL",
            "client_order_id": client_order_id,
            "created_at": now,
            "updated_at": now,
        }
        intent["signal_id"] = signal_id or None
        with self._engine.begin() as connection:
            if signal_id:
                statement = pg_insert(execution_intents_table).values(**intent).on_conflict_do_nothing(
                    index_elements=[execution_intents_table.c.user_id, execution_intents_table.c.signal_id],
                    index_where=text("signal_id IS NOT NULL"),
                ).returning(*execution_intents_table.columns)
                row = connection.execute(statement).mappings().first()
                if row is not None:
                    return dict(row)
                existing = connection.execute(select(execution_intents_table).where(
                    execution_intents_table.c.user_id == user_id,
                    execution_intents_table.c.signal_id == signal_id,
                )).mappings().first()
                if existing is not None:
                    return {**dict(existing), "reused": True}
            else:
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

    def mark_protected(self, intent_id: str, user_id: str, **values: object) -> dict[str, object] | None:
        """Do not resurrect a Live intent already closed by the User Stream."""
        values["updated_at"] = datetime.now(timezone.utc)
        with self._engine.begin() as connection:
            connection.execute(update(execution_intents_table).where(
                execution_intents_table.c.id == intent_id,
                execution_intents_table.c.user_id == user_id,
                execution_intents_table.c.status != "CLOSED",
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
                symbol = str(event.get("symbol") or "").upper()
                status = str(event.get("status") or "")
                is_close = status in {"TRIGGERED", "FILLED"} and bool(event.get("is_close"))
                client_matches = bool(root and client_id and client_id.startswith(root))
                symbol_matches = symbol and symbol == str(intent.get("symbol") or "").upper()
                if client_matches and client_id == root and status == "FILLED" and str(intent.get("status", "")).upper() not in {"PROTECTED", "CLOSED", "ERROR"}:
                    self.update(intent["id"], user_id, status="ENTRY_FILLED", exchange_order_id=str(event.get("exchange_order_id") or intent.get("exchange_order_id")))
                elif is_close and (client_matches and client_id != root or (not client_matches and symbol_matches and intent.get("status") not in {"CLOSED", "ERROR"})):
                    self.update(intent["id"], user_id, status="CLOSED", last_error=None)

    def reconcile_account_event(self, user_id: str, event: dict[str, object]) -> None:
        """Normalize one raw Binance account event before broadcasting it."""
        event_type = str(event.get("type") or event.get("e") or "")
        payload = event.get("event") if isinstance(event.get("event"), dict) else event
        order = payload.get("o") if isinstance(payload, dict) and isinstance(payload.get("o"), dict) else payload
        if not isinstance(order, dict):
            return
        status = str(order.get("X") or order.get("status") or "").upper()
        close_flag = order.get("cp") is True or str(order.get("cp") or "").lower() == "true" or order.get("R") is True or str(order.get("R") or "").lower() == "true"
        if event_type == "ALGO_UPDATE" and status == "TRIGGERED":
            close_flag = True
        if event_type not in {"ORDER_TRADE_UPDATE", "ALGO_UPDATE"} or not close_flag:
            return
        self.reconcile_events(user_id, [{
            "client_order_id": order.get("c") or order.get("ca") or order.get("clientOrderId"),
            "exchange_order_id": order.get("i") or order.get("aid") or order.get("algoId"),
            "symbol": order.get("s") or order.get("symbol"),
            "status": status,
            "is_close": True,
        }])


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
        if event.get("type") not in {"ORDER_TRADE_UPDATE", "ALGO_UPDATE"}:
            return
        self._store.reconcile_account_event(user_id, event)
