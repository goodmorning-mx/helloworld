"""Backend-owned Binance runtime.

The supervisor keeps private account streams alive without a browser. Order
submission is intentionally not implemented here yet; a separate explicit
production switch will be required before any exchange mutation is allowed.
"""

from __future__ import annotations

from datetime import datetime, timezone
import logging
import threading
import time
from uuid import uuid4

from sqlalchemy import insert, select
from sqlalchemy.engine import Engine
from sqlalchemy.sql import column, table

from app.binance_credentials import BinanceCredentialStore, BinanceMonitorManager
from app.config import Settings

logger = logging.getLogger(__name__)

execution_intents_table = table(
    "binance_execution_intents",
    column("id"), column("user_id"), column("symbol"), column("side"), column("quantity"),
    column("stop_loss"), column("take_profit"), column("status"), column("exchange_order_id"),
    column("client_order_id"), column("last_error"), column("created_at"), column("updated_at"),
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


class BinanceExecutionSupervisor:
    """Ensure every configured user's account stream runs independently of UI."""

    def __init__(self, settings: Settings, credentials: BinanceCredentialStore, monitors: BinanceMonitorManager):
        self._settings = settings
        self._credentials = credentials
        self._monitors = monitors
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._status = {"enabled": settings.binance_execution_worker_enabled, "running": False, "last_cycle": None, "users": 0}
        self._lock = threading.Lock()

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
        delay = max(5, min(int(self._settings.binance_execution_poll_seconds), 120))
        while not self._stop.is_set():
            try:
                users = self._credentials.user_ids()
                for user_id in users:
                    # snapshot() starts/reuses the user's resilient User Data
                    # Stream. No private endpoint is mutated by this call.
                    self._monitors.snapshot(user_id)
                with self._lock:
                    self._status.update({"last_cycle": datetime.now(timezone.utc).isoformat(), "users": len(users)})
            except Exception:
                logger.exception("binance_execution_supervisor_cycle_failed")
            self._stop.wait(delay)

