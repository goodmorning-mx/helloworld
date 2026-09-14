"""Read-only Binance Futures account monitor and private User Data Stream."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import hmac
import json
import logging
import threading
import time
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
import httpx

from app.config import Settings

try:
    from websockets.sync.client import connect
except ImportError:  # pragma: no cover - dependency is supplied by uvicorn[standard]
    connect = None


logger = logging.getLogger(__name__)


class BinanceAccountMonitor:
    def __init__(self, settings_or_key: Settings | str, api_secret: str | None = None, base_url: str | None = None, on_event: Callable[[dict[str, object]], None] | None = None):
        # Settings is retained for backwards-compatible unit tests. Runtime
        # monitors receive credentials belonging to exactly one authenticated user.
        if isinstance(settings_or_key, Settings):
            self._key = settings_or_key.binance_api_key
            self._secret = settings_or_key.binance_api_secret
            self._base = settings_or_key.binance_base_url.rstrip("/")
        else:
            self._key = settings_or_key.strip()
            self._secret = (api_secret or "").strip()
        self._base = (base_url or "https://fapi.binance.com").rstrip("/")
        self._on_event = on_event
        self._http = httpx.Client(timeout=10, limits=httpx.Limits(max_connections=8, max_keepalive_connections=4), headers={"X-MBX-APIKEY": self._key, "Accept": "application/json"})
        self._ws_base = "wss://fstream.binance.com/ws"
        if "testnet" in self._base:
            self._ws_base = "wss://stream.binancefuture.com/ws"
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._snapshot: dict[str, object] = {
            "enabled": True, "healthy": False, "stream_connected": False,
            "last_update": None, "last_event": None, "error": None,
            "error_kind": None, "error_title": None, "error_message": None, "error_action": None,
            "wallet_balance": None, "futures_balance": None, "available_balance": None,
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
        self._http.close()

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            return json.loads(json.dumps(self._snapshot))

    def max_leverages(self) -> dict[str, int]:
        """Return Binance's first-bracket maximum leverage per symbol."""
        payload = self._signed_get("/fapi/v1/leverageBracket")
        result: dict[str, int] = {}
        for item in payload if isinstance(payload, list) else []:
            symbol = str(item.get("symbol", "")).upper()
            brackets = item.get("brackets", [])
            values = [int(bracket["initialLeverage"]) for bracket in brackets if bracket.get("initialLeverage") is not None]
            if symbol and values:
                result[symbol] = max(values)
        return result

    def symbol_config(self, symbol: str) -> dict[str, object]:
        """Return account-specific leverage and isolated wallet for a symbol."""
        requested = symbol.strip().upper()
        payload = self._request("GET", "/fapi/v1/symbolConfig", {"symbol": requested}, signed=True)
        item = next((row for row in payload if str(row.get("symbol", "")).upper() == requested), {}) if isinstance(payload, list) else {}
        positions = self._signed_get("/fapi/v2/positionRisk")
        position = next((row for row in positions if str(row.get("symbol", "")).upper() == requested), {}) if isinstance(positions, list) else {}
        return {
            "symbol": requested,
            "margin_type": str(item.get("marginType", "")).upper() or None,
            "leverage": int(item["leverage"]) if item.get("leverage") is not None else None,
            "isolated_balance": float(position.get("isolatedWallet", 0) or 0),
        }

    def set_margin_type(self, symbol: str, margin_type: str = "ISOLATED") -> dict[str, object]:
        """Change the margin mode for one Binance Futures symbol."""
        requested = symbol.strip().upper()
        mode = margin_type.strip().upper()
        if mode not in {"ISOLATED", "CROSSED"}:
            raise ValueError("El modo de margen debe ser ISOLATED o CROSSED.")
        try:
            self._request("POST", "/fapi/v1/marginType", {"symbol": requested, "marginType": mode}, signed=True)
        except HTTPError as exc:
            # Binance returns -4046 when the symbol is already in the target
            # mode; the desired state is already satisfied in that case.
            if getattr(exc, "code", None) != 400:
                raise
            try:
                payload = json.loads(exc.read().decode("utf-8"))
            except (ValueError, UnicodeDecodeError, OSError):
                payload = {}
            if payload.get("code") != -4046:
                raise
        return self.symbol_config(requested)

    def set_leverage(self, symbol: str, leverage: int) -> dict[str, object]:
        """Change the account leverage for one Binance Futures symbol."""
        requested = symbol.strip().upper()
        value = int(leverage)
        if not 1 <= value <= 125:
            raise ValueError("El leverage debe estar entre 1x y 125x.")
        self._request("POST", "/fapi/v1/leverage", {"symbol": requested, "leverage": value}, signed=True)
        return self.symbol_config(requested)

    def position_risk(self, symbol: str) -> dict[str, object]:
        """Read one filled position once, after an entry is acknowledged."""
        requested = symbol.strip().upper()
        payload = self._signed_get("/fapi/v2/positionRisk")
        return next((row for row in payload if str(row.get("symbol", "")).upper() == requested), {}) if isinstance(payload, list) else {}

    def place_market_order(self, symbol: str, side: str, quantity: float, client_order_id: str, *, reduce_only: bool = False) -> dict:
        """Submit one market entry. Caller must pass the production safety gate."""
        requested = symbol.strip().upper()
        order_side = side.strip().upper()
        if order_side not in {"BUY", "SELL"} or quantity <= 0:
            raise ValueError("Orden Binance inválida.")
        params = {
            "symbol": requested, "side": order_side, "type": "MARKET",
            "quantity": format(quantity, ".16g"), "newClientOrderId": client_order_id,
            "newOrderRespType": "RESULT",
        }
        if reduce_only:
            params["reduceOnly"] = "true"
        return self._request("POST", "/fapi/v1/order", params, signed=True)

    def place_close_protection(self, symbol: str, side: str, stop_price: float, client_order_id: str, order_type: str, *, working_type: str = "MARK_PRICE") -> dict:
        """Place a server-side close-all Algo protective trigger."""
        requested = symbol.strip().upper()
        trigger_type = order_type.strip().upper()
        trigger_price_type = working_type.strip().upper()
        if trigger_type not in {"STOP_MARKET", "TAKE_PROFIT_MARKET"} or trigger_price_type not in {"MARK_PRICE", "CONTRACT_PRICE"} or stop_price <= 0:
            raise ValueError("Protección Binance inválida.")
        return self._request("POST", "/fapi/v1/algoOrder", {
            "algoType": "CONDITIONAL", "symbol": requested, "side": side.strip().upper(), "type": trigger_type,
            "triggerPrice": format(stop_price, ".16g"), "closePosition": "true",
            # MARK_PRICE avoids depending on the browser's last trade stream.
            # Do not enable priceProtect: it can delay a valid protective
            # trigger when mark and contract prices temporarily diverge.
            "workingType": trigger_price_type, "priceProtect": "FALSE",
            "clientAlgoId": client_order_id,
        }, signed=True)

    def cancel_close_protection(self, symbol: str, algo_id: str | int) -> dict:
        """Cancel one active Binance Futures algo protection order."""
        requested = symbol.strip().upper()
        if not str(algo_id).strip():
            raise ValueError("Algo ID inválido.")
        return self._request("DELETE", "/fapi/v1/algoOrder", {"symbol": requested, "algoId": str(algo_id)}, signed=True)

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
                self._set_error(exc)
                self._set(healthy=False, stream_connected=False)
                self._stop.wait(retry)
                retry = min(retry * 2, 30)

    def _refresh_account(self) -> None:
        account = self._signed_get("/fapi/v2/account")
        positions = self._signed_get("/fapi/v2/positionRisk")
        active = [self._position(row) for row in positions if float(row.get("positionAmt", 0)) != 0]
        self._set(
            healthy=True,
            wallet_balance=account.get("totalWalletBalance"),
            futures_balance=account.get("totalMarginBalance"),
            available_balance=account.get("availableBalance"),
            total_unrealized_pnl=account.get("totalUnrealizedProfit"),
            positions=active, last_update=self._now(), error=None,
        )

    def _handle_event(self, event: dict) -> None:
        event_type = event.get("e")
        if event_type == "ACCOUNT_UPDATE":
            account = event.get("a", {})
            usdt = next((row for row in account.get("B", []) if row.get("a") == "USDT"), {})
            with self._lock:
                previous = {str(row.get("symbol", "")).upper(): row for row in self._snapshot.get("positions", [])}
            positions = dict(previous)
            for row in account.get("P", []):
                symbol = str(row.get("s") or row.get("symbol") or "").upper()
                if not symbol:
                    continue
                if float(row.get("pa") or row.get("positionAmt") or 0) == 0:
                    positions.pop(symbol, None)
                    continue
                position = self._position(row)
                # ACCOUNT_UPDATE intentionally omits some risk fields. Keep
                # the latest positionRisk values until the next REST refresh.
                old = previous.get(str(position.get("symbol", "")).upper(), {})
                for key in ("notional", "isolated_margin", "leverage", "margin_type"):
                    if position.get(key) in (None, "") and old.get(key) not in (None, ""):
                        position[key] = old[key]
                positions[symbol] = position
            self._set(
                wallet_balance=usdt.get("wb"),
                futures_balance=float(usdt.get("wb", 0)) + sum(float(row.get("up", 0)) for row in account.get("P", [])),
                available_balance=usdt.get("cw"),
                total_unrealized_pnl=sum(float(row.get("up", 0)) for row in account.get("P", [])),
                positions=list(positions.values()), last_update=self._now(), last_event=event_type,
            )
        elif event_type == "ORDER_TRADE_UPDATE":
            order = event.get("o", {})
            item = {"time": self._now(), "type": event_type, "symbol": order.get("s"),
                    "side": order.get("S"), "status": order.get("X"), "order_type": order.get("o"),
                    "price": order.get("ap") or order.get("p"), "quantity": order.get("z") or order.get("q"),
                    "client_order_id": order.get("c"), "exchange_order_id": order.get("i")}
            with self._lock:
                events = list(self._snapshot["events"])
                events.append(item)
                self._snapshot["events"] = events[-20:]
                # Binance normally follows a filled close order with an
                # ACCOUNT_UPDATE, but the order event is the first and most
                # immediate signal. Project a fully filled close-all/reduce
                # only order immediately so the UI cannot retain a phantom
                # position while waiting for the balance event.
                if order.get("X") == "FILLED" and (order.get("cp") is True or order.get("R") is True):
                    symbol = str(order.get("s") or "").upper()
                    current = next((row for row in self._snapshot.get("positions", []) if str(row.get("symbol", "")).upper() == symbol), None)
                    executed = float(order.get("z") or order.get("l") or 0)
                    current_quantity = abs(float((current or {}).get("quantity") or 0))
                    if symbol and (order.get("cp") is True or (current_quantity > 0 and executed >= current_quantity)):
                        self._snapshot["positions"] = [row for row in self._snapshot["positions"] if str(row.get("symbol", "")).upper() != symbol]
                self._snapshot["last_event"] = event_type
                self._snapshot["last_update"] = item["time"]
        if event_type in {"ACCOUNT_UPDATE", "ORDER_TRADE_UPDATE", "MARGIN_CALL", "listenKeyExpired"}:
            self._emit_event({
                "type": str(event_type), "event": event, "snapshot": self.snapshot(),
                "backend_received_at_ms": int(time.time() * 1000),
            })

    def _emit_event(self, payload: dict[str, object]) -> None:
        if self._on_event is None:
            return
        try:
            self._on_event(payload)
        except Exception:
            logger.exception("Binance account event callback failed")

    @staticmethod
    def _position(row: dict) -> dict[str, object]:
        quantity = row.get("pa") or row.get("positionAmt")
        return {"symbol": row.get("s") or row.get("symbol"), "side": row.get("ps") or row.get("positionSide"),
                "quantity": quantity, "size": quantity,
                "entry_price": row.get("ep") or row.get("entryPrice"),
                "mark_price": row.get("mp") or row.get("markPrice"),
                "unrealized_pnl": row.get("up") or row.get("unRealizedProfit"),
                "liquidation_price": row.get("liquidationPrice"),
                "notional": row.get("notional") or row.get("notionalValue"),
                "isolated_margin": row.get("isolatedMargin"),
                "leverage": row.get("leverage"),
                "margin_type": row.get("mt") or row.get("marginType"),
                "isolated_wallet": row.get("iw") or row.get("isolatedWallet")}

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
        response = self._http.request(method, f"{self._base}{path}", params=params)
        response.raise_for_status()
        return response.json()

    def _set_error(self, exc: Exception) -> None:
        kind, title, message, action = self._friendly_error(exc)
        self._set(error=str(exc), error_kind=kind, error_title=title,
                  error_message=message, error_action=action)

    @staticmethod
    def _friendly_error(exc: Exception) -> tuple[str, str, str, str]:
        provider_code = None
        if isinstance(exc, (HTTPError, httpx.HTTPStatusError)):
            try:
                payload = exc.response.json() if isinstance(exc, httpx.HTTPStatusError) else json.loads(exc.read().decode("utf-8"))
                provider_code = payload.get("code")
            except (ValueError, UnicodeDecodeError, OSError):
                pass
        if provider_code == -2015 or getattr(exc, "code", None) == 401:
            return (
                "BINANCE_AUTH_OR_IP",
                "Binance rechazó la conexión (IP o permisos)",
                "La API key, sus permisos o la IP pública del servidor no están autorizados para Binance Futures.",
                "Agrega la IP pública de Coolify a la whitelist de Binance y verifica que la key tenga permiso de Futures.",
            )
        if getattr(exc, "code", None) in {418, 429}:
            return (
                "BINANCE_RATE_LIMIT",
                "Binance limitó temporalmente las solicitudes",
                "Se alcanzó el límite de consultas de Binance.",
                "El monitor pausará y reintentará automáticamente; no es necesario recargar la página.",
            )
        if getattr(exc, "code", None) and getattr(exc, "code", 0) >= 500:
            return (
                "BINANCE_SERVER",
                "Binance reporta una falla temporal",
                "El servicio de Binance no está respondiendo correctamente.",
                "El monitor seguirá reintentando automáticamente.",
            )
        if isinstance(exc, (TimeoutError, URLError, ConnectionError)):
            return (
                "NETWORK",
                "No hay conexión con Binance",
                "El backend no pudo comunicarse con la API o el User Stream de Binance.",
                "Verifica la red del servidor; el monitor seguirá reintentando automáticamente.",
            )
        return (
            "UNKNOWN",
            "No se pudo consultar Binance",
            "Binance devolvió un error no identificado.",
            "Revisa los logs del backend o intenta nuevamente en unos segundos.",
        )

    def _set(self, **values: object) -> None:
        with self._lock:
            self._snapshot.update(values)

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()
