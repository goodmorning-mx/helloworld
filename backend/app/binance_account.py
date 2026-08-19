"""Read-only Binance Futures account monitor and private User Data Stream."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import hmac
import json
import logging
import threading
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from app.config import Settings

try:
    from websockets.sync.client import connect
except ImportError:  # pragma: no cover - dependency is supplied by uvicorn[standard]
    connect = None


logger = logging.getLogger(__name__)


class BinanceAccountMonitor:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._key = settings.binance_api_key
        self._secret = settings.binance_api_secret
        self._base = settings.binance_base_url.rstrip("/")
        self._ws_base = "wss://fstream.binance.com/ws"
        if "testnet" in self._base:
            self._ws_base = "wss://stream.binancefuture.com/ws"
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._snapshot: dict[str, object] = {
            "enabled": True, "healthy": False, "stream_connected": False,
            "last_update": None, "last_event": None, "error": None,
            "wallet_balance": None, "available_balance": None,
            "total_unrealized_pnl": None, "positions": [], "events": [],
        }

    def start(self) -> "BinanceAccountMonitor":
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="binance-user-stream", daemon=True)
            self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)
        self._thread = None

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            return json.loads(json.dumps(self._snapshot))

    def _run(self) -> None:
        if connect is None:
            self._set(error="La dependencia WebSocket no está disponible")
            return
        retry = 1
        while not self._stop.is_set():
            try:
                self._refresh_account()
                listen_key = self._create_listen_key()
                with connect(f"{self._ws_base}/{listen_key}", open_timeout=10, ping_interval=20, ping_timeout=20) as socket:
                    self._set(healthy=True, stream_connected=True, error=None)
                    retry = 1
                    last_keepalive = time.monotonic()
                    while not self._stop.is_set():
                        if time.monotonic() - last_keepalive > 25 * 60:
                            self._keepalive(listen_key)
                            last_keepalive = time.monotonic()
                        try:
                            raw = socket.recv(timeout=2)
                        except TimeoutError:
                            continue
                        self._handle_event(json.loads(raw))
            except Exception as exc:  # reconnect with backoff; never crash the API
                logger.warning("Binance User Data Stream disconnected: %s", exc)
                self._set(healthy=False, stream_connected=False, error=str(exc))
                self._stop.wait(retry)
                retry = min(retry * 2, 30)

    def _refresh_account(self) -> None:
        account = self._signed_get("/fapi/v2/account")
        positions = self._signed_get("/fapi/v2/positionRisk")
        active = [self._position(row) for row in positions if float(row.get("positionAmt", 0)) != 0]
        self._set(
            healthy=True,
            wallet_balance=account.get("totalWalletBalance"),
            available_balance=account.get("availableBalance"),
            total_unrealized_pnl=account.get("totalUnrealizedProfit"),
            positions=active, last_update=self._now(), error=None,
        )

    def _handle_event(self, event: dict) -> None:
        event_type = event.get("e")
        if event_type == "ACCOUNT_UPDATE":
            account = event.get("a", {})
            usdt = next((row for row in account.get("B", []) if row.get("a") == "USDT"), {})
            positions = [self._position(row) for row in account.get("P", []) if float(row.get("pa", 0)) != 0]
            self._set(
                wallet_balance=usdt.get("wb"), available_balance=usdt.get("cw"),
                total_unrealized_pnl=sum(float(row.get("up", 0)) for row in account.get("P", [])),
                positions=positions, last_update=self._now(), last_event=event_type,
            )
        elif event_type == "ORDER_TRADE_UPDATE":
            order = event.get("o", {})
            item = {"time": self._now(), "type": event_type, "symbol": order.get("s"),
                    "side": order.get("S"), "status": order.get("X"), "order_type": order.get("o"),
                    "price": order.get("ap") or order.get("p"), "quantity": order.get("z") or order.get("q")}
            with self._lock:
                events = list(self._snapshot["events"])
                events.append(item)
                self._snapshot["events"] = events[-20:]
                self._snapshot["last_event"] = event_type
                self._snapshot["last_update"] = item["time"]

    @staticmethod
    def _position(row: dict) -> dict[str, object]:
        return {"symbol": row.get("s"), "side": row.get("ps") or row.get("positionSide"),
                "quantity": row.get("pa") or row.get("positionAmt"),
                "entry_price": row.get("ep") or row.get("entryPrice"),
                "mark_price": row.get("mp") or row.get("markPrice"),
                "unrealized_pnl": row.get("up") or row.get("unRealizedProfit"),
                "liquidation_price": row.get("liquidationPrice")}

    def _create_listen_key(self) -> str:
        return self._request("POST", "/fapi/v1/listenKey")["listenKey"]

    def _keepalive(self, listen_key: str) -> None:
        self._request("PUT", "/fapi/v1/listenKey", {"listenKey": listen_key})

    def _signed_get(self, path: str) -> dict | list:
        return self._request("GET", path, signed=True)

    def _request(self, method: str, path: str, params: dict | None = None, *, signed: bool = False) -> dict | list:
        params = dict(params or {})
        if signed:
            params["timestamp"] = int(time.time() * 1000)
            params["recvWindow"] = 5000
            unsigned = urlencode(params)
            params["signature"] = hmac.new(self._secret.encode(), unsigned.encode(), hashlib.sha256).hexdigest()
        request = Request(f"{self._base}{path}?{urlencode(params)}", method=method,
                          headers={"X-MBX-APIKEY": self._key, "Accept": "application/json"})
        with urlopen(request, timeout=10) as response:
            return json.loads(response.read())

    def _set(self, **values: object) -> None:
        with self._lock:
            self._snapshot.update(values)

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()
