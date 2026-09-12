"""Per-user encrypted Binance credentials and account monitor lifecycle."""

from __future__ import annotations

import base64
import hashlib
import logging
import threading
from collections import defaultdict
from datetime import datetime, timezone
from typing import Callable

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import delete, insert, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import NoResultFound
from sqlalchemy.sql import table, column

from app.binance_account import BinanceAccountMonitor
from app.config import Settings

logger = logging.getLogger(__name__)

credentials_table = table(
    "user_binance_credentials",
    column("user_id"), column("encrypted_api_key"), column("encrypted_api_secret"),
    column("created_at"), column("updated_at"),
)


class CredentialCipher:
    """Fernet wrapper. The plaintext secret never leaves this module."""

    def __init__(self, configured_key: str, jwt_secret: str):
        key = configured_key.strip()
        if not key:
            key = base64.urlsafe_b64encode(hashlib.sha256(jwt_secret.encode()).digest()).decode()
            logger.warning("BINANCE_CREDENTIALS_ENCRYPTION_KEY is not set; deriving it from JWT_SECRET")
        self._fernet = Fernet(key.encode())

    def encrypt(self, value: str) -> str:
        return self._fernet.encrypt(value.encode()).decode()

    def decrypt(self, value: str) -> str:
        try:
            return self._fernet.decrypt(value.encode()).decode()
        except InvalidToken as exc:
            raise RuntimeError("Binance credential encryption key is invalid or credentials are unreadable") from exc


class BinanceCredentialStore:
    def __init__(self, engine: Engine, settings: Settings):
        self._engine = engine
        self._cipher = CredentialCipher(settings.binance_credentials_encryption_key, settings.jwt_secret)

    def get(self, user_id: str) -> tuple[str, str] | None:
        query = select(credentials_table.c.encrypted_api_key, credentials_table.c.encrypted_api_secret).where(credentials_table.c.user_id == user_id)
        with self._engine.connect() as connection:
            row = connection.execute(query).first()
        if row is None:
            return None
        return self._cipher.decrypt(row.encrypted_api_key), self._cipher.decrypt(row.encrypted_api_secret)

    def user_ids(self) -> list[str]:
        """Return configured users so backend workers do not depend on a UI request."""
        with self._engine.connect() as connection:
            rows = connection.execute(select(credentials_table.c.user_id)).all()
        return [str(row.user_id) for row in rows]

    def status(self, user_id: str) -> dict[str, object]:
        query = select(credentials_table.c.encrypted_api_key, credentials_table.c.updated_at).where(credentials_table.c.user_id == user_id)
        with self._engine.connect() as connection:
            row = connection.execute(query).first()
        if row is None:
            return {"configured": False, "masked_api_key": None, "updated_at": None}
        key = self._cipher.decrypt(row.encrypted_api_key)
        return {"configured": True, "masked_api_key": f"••••••••{key[-4:]}", "updated_at": row.updated_at.isoformat() if row.updated_at else None}

    def save(self, user_id: str, api_key: str, api_secret: str) -> None:
        now = datetime.now(timezone.utc)
        values = {
            "user_id": user_id,
            "encrypted_api_key": self._cipher.encrypt(api_key.strip()),
            "encrypted_api_secret": self._cipher.encrypt(api_secret.strip()),
            "created_at": now,
            "updated_at": now,
        }
        with self._engine.begin() as connection:
            if connection.execute(select(credentials_table.c.user_id).where(credentials_table.c.user_id == user_id)).first():
                connection.execute(update(credentials_table).where(credentials_table.c.user_id == user_id).values(**{k: values[k] for k in values if k not in {"user_id", "created_at"}}))
            else:
                connection.execute(insert(credentials_table).values(**values))

    def delete(self, user_id: str) -> None:
        with self._engine.begin() as connection:
            connection.execute(delete(credentials_table).where(credentials_table.c.user_id == user_id))


def not_configured_snapshot() -> dict[str, object]:
    return {
        "enabled": True, "configured": False, "healthy": False, "stream_connected": False,
        "last_update": None, "last_event": None, "error": "Cuenta Binance no configurada",
        "error_kind": "NOT_CONFIGURED", "error_title": "Configura tu cuenta de Binance",
        "error_message": "Todavía no has agregado una API key y API secret para este usuario.",
        "error_action": "Abre tu avatar → Perfil → Binance y guarda tus credenciales.",
        "wallet_balance": None, "futures_balance": None, "available_balance": None, "total_unrealized_pnl": None,
        "positions": [], "events": [],
    }


class BinanceMonitorManager:
    def __init__(self, store: BinanceCredentialStore, settings: Settings):
        self._store = store
        self._settings = settings
        self._monitors: dict[str, BinanceAccountMonitor] = {}
        self._fingerprints: dict[str, str] = {}
        self._listeners: dict[str, set[Callable[[dict[str, object]], None]]] = defaultdict(set)
        self._lock = threading.RLock()

    def snapshot(self, user_id: str) -> dict[str, object]:
        credentials = self._store.get(user_id)
        if credentials is None:
            self._stop_user(user_id)
            return not_configured_snapshot()
        api_key, api_secret = credentials
        fingerprint = hashlib.sha256(f"{api_key}\0{api_secret}".encode()).hexdigest()
        with self._lock:
            monitor = self._monitors.get(user_id)
            if monitor is None or self._fingerprints.get(user_id) != fingerprint:
                if monitor is not None:
                    monitor.stop()
                monitor = BinanceAccountMonitor(api_key, api_secret, self._settings.binance_base_url, on_event=lambda event, uid=user_id: self._publish(uid, event))
                self._monitors[user_id] = monitor
                self._fingerprints[user_id] = fingerprint
                monitor.start()
        payload = monitor.snapshot()
        payload["configured"] = True
        return payload

    def subscribe_events(self, user_id: str, listener: Callable[[dict[str, object]], None]) -> None:
        with self._lock:
            self._listeners[user_id].add(listener)

    def unsubscribe_events(self, user_id: str, listener: Callable[[dict[str, object]], None]) -> None:
        with self._lock:
            listeners = self._listeners.get(user_id)
            if listeners is None:
                return
            listeners.discard(listener)
            if not listeners:
                self._listeners.pop(user_id, None)

    def _publish(self, user_id: str, event: dict[str, object]) -> None:
        with self._lock:
            listeners = list(self._listeners.get(user_id, ()))
        for listener in listeners:
            try:
                listener(event)
            except Exception:
                logger.exception("Binance event listener failed user=%s", user_id)

    def symbol_config(self, user_id: str, symbol: str) -> dict[str, object]:
        credentials = self._store.get(user_id)
        if credentials is None:
            return {"configured": False, "symbol": symbol.upper(), "margin_type": None, "leverage": None}
        api_key, api_secret = credentials
        fingerprint = hashlib.sha256(f"{api_key}\0{api_secret}".encode()).hexdigest()
        with self._lock:
            monitor = self._monitors.get(user_id)
            if monitor is None or self._fingerprints.get(user_id) != fingerprint:
                if monitor is not None:
                    monitor.stop()
                monitor = BinanceAccountMonitor(api_key, api_secret, self._settings.binance_base_url, on_event=lambda event, uid=user_id: self._publish(uid, event))
                self._monitors[user_id] = monitor
                self._fingerprints[user_id] = fingerprint
                monitor.start()
        try:
            config = monitor.symbol_config(symbol)
            config["futures_balance"] = monitor.snapshot().get("futures_balance")
            return {"configured": True, **config}
        except Exception as exc:
            logger.warning("Binance symbol config unavailable symbol=%s error=%s", symbol, exc)
            return {"configured": True, "symbol": symbol.upper(), "margin_type": None, "leverage": None, "error": str(exc)}

    def set_symbol_margin_type(self, user_id: str, symbol: str, margin_type: str) -> dict[str, object]:
        credentials = self._store.get(user_id)
        if credentials is None:
            raise RuntimeError("Cuenta Binance no configurada.")
        api_key, api_secret = credentials
        fingerprint = hashlib.sha256(f"{api_key}\0{api_secret}".encode()).hexdigest()
        with self._lock:
            monitor = self._monitors.get(user_id)
            if monitor is None or self._fingerprints.get(user_id) != fingerprint:
                if monitor is not None:
                    monitor.stop()
                monitor = BinanceAccountMonitor(api_key, api_secret, self._settings.binance_base_url, on_event=lambda event, uid=user_id: self._publish(uid, event))
                self._monitors[user_id] = monitor
                self._fingerprints[user_id] = fingerprint
                monitor.start()
        return {"configured": True, **monitor.set_margin_type(symbol, margin_type)}

    def set_symbol_leverage(self, user_id: str, symbol: str, leverage: int) -> dict[str, object]:
        credentials = self._store.get(user_id)
        if credentials is None:
            raise RuntimeError("Cuenta Binance no configurada.")
        api_key, api_secret = credentials
        fingerprint = hashlib.sha256(f"{api_key}\0{api_secret}".encode()).hexdigest()
        with self._lock:
            monitor = self._monitors.get(user_id)
            if monitor is None or self._fingerprints.get(user_id) != fingerprint:
                if monitor is not None:
                    monitor.stop()
                monitor = BinanceAccountMonitor(api_key, api_secret, self._settings.binance_base_url, on_event=lambda event, uid=user_id: self._publish(uid, event))
                self._monitors[user_id] = monitor
                self._fingerprints[user_id] = fingerprint
                monitor.start()
        return {"configured": True, **monitor.set_leverage(symbol, leverage)}

    def position_risk(self, user_id: str, symbol: str) -> dict[str, object]:
        monitor = self._monitor_for_user(user_id)
        return monitor.position_risk(symbol)

    def place_market_order(self, user_id: str, symbol: str, side: str, quantity: float, client_order_id: str, *, reduce_only: bool = False) -> dict:
        monitor = self._monitor_for_user(user_id)
        return monitor.place_market_order(symbol, side, quantity, client_order_id, reduce_only=reduce_only)

    def place_close_protection(self, user_id: str, symbol: str, side: str, stop_price: float, client_order_id: str, order_type: str, *, working_type: str = "MARK_PRICE") -> dict:
        monitor = self._monitor_for_user(user_id)
        return monitor.place_close_protection(symbol, side, stop_price, client_order_id, order_type, working_type=working_type)

    def cancel_close_protection(self, user_id: str, symbol: str, algo_id: str | int) -> dict:
        monitor = self._monitor_for_user(user_id)
        return monitor.cancel_close_protection(symbol, algo_id)

    def save(self, user_id: str, api_key: str, api_secret: str) -> dict[str, object]:
        self._validate(api_key, api_secret)
        self._store.save(user_id, api_key, api_secret)
        self._stop_user(user_id)
        return self._store.status(user_id)

    def delete(self, user_id: str) -> None:
        self._stop_user(user_id)
        self._store.delete(user_id)

    def stop_all(self) -> None:
        with self._lock:
            users = list(self._monitors)
        for user_id in users:
            self._stop_user(user_id)

    def _stop_user(self, user_id: str) -> None:
        with self._lock:
            monitor = self._monitors.pop(user_id, None)
            self._fingerprints.pop(user_id, None)
        if monitor is not None:
            monitor.stop()

    def _monitor_for_user(self, user_id: str) -> BinanceAccountMonitor:
        credentials = self._store.get(user_id)
        if credentials is None:
            raise RuntimeError("Cuenta Binance no configurada.")
        api_key, api_secret = credentials
        fingerprint = hashlib.sha256(f"{api_key}\0{api_secret}".encode()).hexdigest()
        with self._lock:
            monitor = self._monitors.get(user_id)
            if monitor is None or self._fingerprints.get(user_id) != fingerprint:
                if monitor is not None:
                    monitor.stop()
                monitor = BinanceAccountMonitor(api_key, api_secret, self._settings.binance_base_url, on_event=lambda event, uid=user_id: self._publish(uid, event))
                self._monitors[user_id] = monitor
                self._fingerprints[user_id] = fingerprint
                monitor.start()
        return monitor

    @staticmethod
    def _validate(api_key: str, api_secret: str) -> None:
        if len(api_key.strip()) < 10 or len(api_secret.strip()) < 10:
            raise ValueError("Las credenciales de Binance no tienen un formato válido")
