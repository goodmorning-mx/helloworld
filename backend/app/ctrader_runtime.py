"""Per-user cTrader Open API runtime.

The Open API socket stays in a backend worker. The HTTP layer exposes only
normalized status and market data to the browser; OAuth secrets never leave
this process.
"""

from __future__ import annotations

import multiprocessing
import threading
import time
from collections import deque
from queue import Empty
from typing import Any
from uuid import uuid4

import httpx


def _period(interval: str) -> int:
    return {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60}.get(interval, 1)


def _worker(high_queue: Any, low_queue: Any, response_queue: Any, host: str, port: int,
            client_id: str, client_secret: str, access_token: str, account_id: int) -> None:
    from ctrader_open_api import Client, Protobuf, TcpProtocol
    from ctrader_open_api.messages.OpenApiMessages_pb2 import (
        ProtoOAAccountAuthReq, ProtoOAApplicationAuthReq,
        ProtoOAGetAccountListByAccessTokenReq, ProtoOAGetTrendbarsReq,
        ProtoOASymbolsListReq, ProtoOASpotEvent, ProtoOASubscribeSpotsReq,
        ProtoOASubscribeLiveTrendbarReq,
        ProtoOANewOrderReq, ProtoOAClosePositionReq, ProtoOAAmendPositionSLTPReq,
    )
    from twisted.internet import reactor

    state = {"connected": False, "ready": False, "account_id": account_id, "accounts": [], "symbols": {},
             "subscribed_spots": set(), "subscribed_trendbars": set()}
    client = Client(host, port, TcpProtocol)

    def emit(payload: dict[str, object]) -> None:
        response_queue.put(payload)

    def fail(reason: object) -> None:
        value = getattr(reason, "value", reason)
        name = type(value).__name__
        if "TimeoutError" in name:
            error = "cTrader no respondió a tiempo durante la autenticación o consulta."
        else:
            error = str(value)
        emit({"type": "ERROR", "error": error})

    def auth_account() -> None:
        request = ProtoOAAccountAuthReq()
        request.ctidTraderAccountId = account_id
        request.accessToken = access_token
        deferred = client.send(request)
        deferred.addCallbacks(on_account_auth, fail)

    def get_accounts() -> None:
        request = ProtoOAGetAccountListByAccessTokenReq()
        request.accessToken = access_token
        deferred = client.send(request)
        deferred.addCallbacks(on_accounts, fail)

    def on_connected(_client: object) -> None:
        state["connected"] = True
        request = ProtoOAApplicationAuthReq()
        request.clientId = client_id
        request.clientSecret = client_secret
        deferred = client.send(request)
        deferred.addCallbacks(lambda _message: get_accounts(), fail)

    def on_disconnected(_client: object, reason: object) -> None:
        state["connected"] = False
        state["ready"] = False
        state["subscribed_spots"].clear()
        state["subscribed_trendbars"].clear()
        emit({"type": "STATUS", "connected": False, "ready": False, "error": str(reason)})

    def on_accounts(message: object) -> None:
        payload = Protobuf.extract(message)
        if hasattr(payload, "errorCode"):
            fail(getattr(payload, "description", getattr(payload, "errorCode", "cTrader auth failed")))
            return
        accounts = [{"account_id": int(item.ctidTraderAccountId), "broker": str(getattr(item, "brokerName", "") or ""), "is_live": bool(getattr(item, "isLive", False))} for item in payload.ctidTraderAccount]
        state["accounts"] = accounts
        emit({"type": "ACCOUNTS", "data": accounts})
        account_ids = {int(item["account_id"]) for item in accounts}
        if account_id <= 0 and accounts:
            account_id = int(accounts[0]["account_id"])
            state["account_id"] = account_id
        if account_id not in account_ids:
            fail("La cuenta cTrader no pertenece al token del usuario")
            return
        auth_account()

    def on_account_auth(message: object) -> None:
        payload = Protobuf.extract(message)
        if hasattr(payload, "errorCode"):
            fail(getattr(payload, "description", getattr(payload, "errorCode", "cTrader account auth failed")))
            return
        state["ready"] = True
        emit({"type": "STATUS", "connected": True, "ready": True, "account_id": account_id})

    def on_message(_client: object, message: object) -> None:
        try:
            payload = Protobuf.extract(message)
            if hasattr(payload, "errorCode"):
                fail(getattr(payload, "description", getattr(payload, "errorCode", "cTrader error")))
            if isinstance(payload, ProtoOASpotEvent):
                symbol = state["symbols"].get(int(payload.symbolId))
                if symbol and (payload.bid or payload.ask):
                    emit({"type": "TICK", "symbol": symbol, "bid": float(payload.bid) / 100000,
                          "ask": float(payload.ask) / 100000, "price": float((payload.bid + payload.ask) / 2) / 100000,
                          "time": int(payload.timestamp or time.time() * 1000) // 1000})
            if hasattr(payload, "trendbar") and len(payload.trendbar):
                symbol = state["symbols"].get(int(payload.symbolId))
                if symbol:
                    bar = payload.trendbar[-1]
                    divider = 100000
                    emit({"type": "TICK", "symbol": symbol, "price": float(bar.low + bar.deltaClose) / divider,
                          "time": int(bar.utcTimestampInMinutes) * 60})
        except Exception as exc:
            fail(exc)

    def get_symbols() -> None:
        request = ProtoOASymbolsListReq()
        request.ctidTraderAccountId = account_id
        deferred = client.send(request)
        deferred.addCallbacks(on_symbols, fail)

    def on_symbols(message: object) -> None:
        payload = Protobuf.extract(message)
        if hasattr(payload, "errorCode"):
            fail(getattr(payload, "description", getattr(payload, "errorCode", "symbols unavailable")))
            return
        symbols = {str(item.symbolName).upper(): int(item.symbolId) for item in payload.symbol}
        state["symbols"] = {symbol_id: name for name, symbol_id in symbols.items()}
        emit({"type": "SYMBOLS", "data": symbols})

    def send_order(command: dict[str, object]) -> None:
        request = ProtoOANewOrderReq()
        request.ctidTraderAccountId = account_id
        request.symbolId = int(command["symbol_id"])
        request.orderType = 1  # MARKET
        request.tradeSide = 1 if command["side"] == "BUY" else 2  # BUY / SELL
        request.volume = int(command["volume"])
        request.comment = str(command.get("comment", "helloworld"))[:50]
        request.label = "helloworld"
        if command.get("stop_loss") is not None:
            request.stopLoss = float(command["stop_loss"])
        if command.get("take_profit") is not None:
            request.takeProfit = float(command["take_profit"])
        request_id = str(command["request_id"])
        client.send(request).addCallbacks(
            lambda message: emit({"type": "ORDER", "request_id": request_id, "data": _message_dict(message)}), fail)

    def close_position(command: dict[str, object]) -> None:
        request = ProtoOAClosePositionReq()
        request.ctidTraderAccountId = account_id
        request.positionId = int(command["position_id"])
        request.volume = int(command["volume"])
        request_id = str(command["request_id"])
        client.send(request).addCallbacks(
            lambda message: emit({"type": "ORDER", "request_id": request_id, "data": _message_dict(message)}), fail)

    def amend_position(command: dict[str, object]) -> None:
        request = ProtoOAAmendPositionSLTPReq()
        request.ctidTraderAccountId = account_id
        request.positionId = int(command["position_id"])
        if command.get("stop_loss") is not None:
            request.stopLoss = float(command["stop_loss"])
        if command.get("take_profit") is not None:
            request.takeProfit = float(command["take_profit"])
        request_id = str(command["request_id"])
        client.send(request).addCallbacks(
            lambda message: emit({"type": "ORDER", "request_id": request_id, "data": _message_dict(message)}), fail)

    def get_candles(command: dict[str, object]) -> None:
        symbol_id = int(command["symbol_id"])
        if symbol_id not in state["subscribed_spots"]:
            state["subscribed_spots"].add(symbol_id)
            spot_request = ProtoOASubscribeSpotsReq()
            spot_request.ctidTraderAccountId = account_id
            spot_request.symbolId.append(symbol_id)
            spot_request.subscribeToSpotTimestamp = True
            client.send(spot_request).addErrback(lambda reason: emit({"type": "STREAM_ERROR", "error": str(reason)}))
        trendbar_key = (symbol_id, _period(str(command["interval"])))
        if trendbar_key not in state["subscribed_trendbars"]:
            state["subscribed_trendbars"].add(trendbar_key)
            live_request = ProtoOASubscribeLiveTrendbarReq()
            live_request.ctidTraderAccountId = account_id
            live_request.symbolId = symbol_id
            live_request.period = trendbar_key[1]
            client.send(live_request).addErrback(lambda reason: emit({"type": "STREAM_ERROR", "error": str(reason)}))
        request = ProtoOAGetTrendbarsReq()
        request.ctidTraderAccountId = account_id
        request.symbolId = int(command["symbol_id"])
        request.period = _period(str(command["interval"]))
        request.fromTimestamp = int(command["from_timestamp"])
        request.toTimestamp = int(command["to_timestamp"])
        deferred = client.send(request)
        deferred.addCallbacks(lambda message: on_candles(message, command), fail)

    def on_candles(message: object, command: dict[str, object]) -> None:
        payload = Protobuf.extract(message)
        if hasattr(payload, "errorCode"):
            fail(getattr(payload, "description", getattr(payload, "errorCode", "candles unavailable")))
            return
        rows = []
        for bar in payload.trendbar:
            divider = 100000
            rows.append({"timestamp": int(bar.utcTimestampInMinutes), "low": float(bar.low) / divider,
                         "delta_open": float(bar.deltaOpen) / divider, "delta_high": float(bar.deltaHigh) / divider,
                         "delta_close": float(bar.deltaClose) / divider})
        emit({"type": "CANDLES", "request_id": command["request_id"], "data": rows})

    def handle(command: dict[str, object]) -> None:
        kind = command.get("type")
        if kind == "GET_SYMBOLS":
            get_symbols()
        elif kind == "GET_CANDLES":
            get_candles(command)
        elif kind == "PLACE_ORDER":
            send_order(command)
        elif kind == "CLOSE_POSITION":
            close_position(command)
        elif kind == "AMEND_POSITION":
            amend_position(command)
        elif kind == "SHUTDOWN":
            reactor.stop()

    def commands() -> None:
        while True:
            try:
                command = high_queue.get_nowait()
            except Empty:
                try:
                    command = low_queue.get(timeout=.25)
                except Empty:
                    continue
            if command.get("type") == "SHUTDOWN":
                reactor.callFromThread(handle, command)
                return
            while not state["ready"] and state["connected"]:
                time.sleep(.05)
            if state["ready"]:
                reactor.callFromThread(handle, command)

    client.setConnectedCallback(on_connected)
    client.setDisconnectedCallback(on_disconnected)
    client.setMessageReceivedCallback(on_message)
    client.startService()
    threading.Thread(target=commands, daemon=True).start()
    reactor.run(installSignalHandlers=False)


class CTraderSession:
    def __init__(self, settings: Any, credentials: dict[str, object]):
        self._settings = settings
        self._credentials = credentials
        self._context = multiprocessing.get_context("spawn")
        self._high = self._context.Queue()
        self._low = self._context.Queue()
        self._responses = self._context.Queue()
        self._process = None
        self._pending: deque[dict[str, object]] = deque()
        self._lock = threading.RLock()
        self._status = {"connected": False, "ready": False, "error": None, "symbols": {}, "last_tick": None}
        self._symbols_cache: dict[str, int] = {}
        self._symbols_cached_at = 0.0

    def start(self) -> None:
        if self.is_alive():
            return
        self._process = self._context.Process(target=_worker, args=(
            self._high, self._low, self._responses, self._settings.ctrader_host,
            self._settings.ctrader_port, self._settings.ctrader_client_id,
            self._settings.ctrader_client_secret, self._credentials["access_token"],
            int(self._credentials["account_id"]),
        ), daemon=True)
        self._process.start()

    def stop(self) -> None:
        if self._process is None:
            return
        if self._process.is_alive():
            self._low.put({"type": "SHUTDOWN"})
            self._process.join(3)
        if self._process.is_alive():
            self._process.terminate()
            self._process.join(1)
        self._process.close()
        self._process = None
        self._status = {"connected": False, "ready": False, "error": None, "symbols": {}, "last_tick": None}
        self._symbols_cache = {}
        self._symbols_cached_at = 0.0

    def is_alive(self) -> bool:
        return self._process is not None and self._process.is_alive()

    def snapshot(self) -> dict[str, object]:
        self._drain()
        return {**self._status, "process_alive": self.is_alive(), "account_id": self._status.get("account_id") or self._credentials["account_id"]}

    def symbols(self, timeout: float = 30) -> dict[str, int]:
        if self._symbols_cache and time.monotonic() - self._symbols_cached_at < 600:
            return dict(self._symbols_cache)
        self._low.put({"type": "GET_SYMBOLS"})
        response = self._wait("SYMBOLS", timeout)
        symbols = response.get("data", {})
        self._symbols_cache = {str(name).upper(): int(symbol_id) for name, symbol_id in symbols.items()}
        self._symbols_cached_at = time.monotonic()
        self._status["symbols"] = self._symbols_cache
        return dict(self._symbols_cache)

    def candles(self, symbol: str, interval: str, start_ms: int, end_ms: int, timeout: float = 30) -> list[dict[str, object]]:
        symbol_id = self.symbols().get(symbol.upper())
        if symbol_id is None:
            raise ValueError(f"Símbolo cTrader no disponible: {symbol}")
        request_id = uuid4().hex
        self._low.put({"type": "GET_CANDLES", "request_id": request_id, "symbol_id": symbol_id,
                       "interval": interval, "from_timestamp": start_ms, "to_timestamp": end_ms})
        return list(self._wait("CANDLES", timeout, request_id).get("data", []))

    def order(self, command: dict[str, object], timeout: float = 30) -> dict[str, object]:
        request_id = uuid4().hex
        self._high.put({**command, "request_id": request_id})
        return self._wait("ORDER", timeout, request_id)

    def _drain(self) -> None:
        while True:
            try:
                response = self._responses.get_nowait()
            except Empty:
                return
            if response.get("type") == "STATUS":
                self._status.update(response)
            elif response.get("type") == "ACCOUNTS":
                self._status["accounts"] = response.get("data", [])
            elif response.get("type") == "ERROR":
                self._status.update({"error": response.get("error"), "ready": False})
            elif response.get("type") == "TICK":
                self._status["last_tick"] = response
            else:
                self._pending.append(response)

    def _wait(self, kind: str, timeout: float, request_id: str | None = None) -> dict[str, object]:
        deadline = time.monotonic() + timeout
        with self._lock:
            while time.monotonic() < deadline:
                self._drain()
                for response in tuple(self._pending):
                    if response.get("type") == kind and (request_id is None or response.get("request_id") == request_id):
                        self._pending.remove(response)
                        return response
                time.sleep(.05)
        raise TimeoutError(f"cTrader no respondió: {kind}")


class CTraderManager:
    def __init__(self, settings: Any, store: Any):
        self._settings = settings
        self._store = store
        self._sessions: dict[str, CTraderSession] = {}
        self._lock = threading.RLock()

    def snapshot(self, user_id: str) -> dict[str, object]:
        credentials = self._store.get(user_id)
        base = {"enabled": self._settings.ctrader_enabled, "broker": "ctrader", "symbols": list(self._settings.ctrader_symbol_list)}
        if not self._settings.ctrader_enabled:
            return {**base, "configured": False, "healthy": False, "stream_connected": False,
                    "error_kind": "DISABLED", "error_title": "cTrader deshabilitado",
                    "error_message": "El broker cTrader no está habilitado en este entorno."}
        if credentials is None:
            self._stop(user_id)
            return {**base, "configured": False, "healthy": False, "stream_connected": False,
                    "error_kind": "NOT_CONFIGURED", "error_title": "Configura tu cuenta cTrader",
                    "error_message": "Agrega tu access token, refresh token y account ID desde Perfil → cTrader.",
                    "error_action": "Abre tu avatar → Perfil → cTrader."}
        session = self.start_user(user_id, credentials)
        status = session.snapshot()
        healthy = bool(status.get("ready") and status.get("process_alive"))
        public_status = {**status, "symbols": list((status.get("symbols") or {}).keys())}
        return {**base, **public_status, "configured": True, "healthy": healthy, "stream_connected": healthy,
                "error_kind": None if healthy else "CONNECTING", "error_title": None if healthy else "Conectando con cTrader",
                "error_message": None if healthy else (status.get("error") or "La sesión cTrader está autenticando."),
                "error_action": None if healthy else "Mantén abierto el perfil y verifica el token si no conecta."}

    def _stop(self, user_id: str) -> None:
        with self._lock:
            session = self._sessions.pop(user_id, None)
        if session:
            session.stop()

    def _refresh_credentials(self, user_id: str, credentials: dict[str, object]) -> dict[str, object]:
        refresh_token = str(credentials.get("refresh_token") or "").strip()
        if not refresh_token or not self._settings.ctrader_client_id or not self._settings.ctrader_client_secret:
            return credentials
        try:
            response = httpx.get(
                "https://openapi.ctrader.com/apps/token",
                params={
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "client_id": self._settings.ctrader_client_id,
                    "client_secret": self._settings.ctrader_client_secret,
                },
                headers={"Accept": "application/json"},
                timeout=10,
            )
            payload = response.json()
            access_token = str(payload.get("accessToken") or "").strip()
            rotated_refresh_token = str(payload.get("refreshToken") or refresh_token).strip()
            if not response.is_success or not access_token:
                return credentials
            refreshed = {**credentials, "access_token": access_token, "refresh_token": rotated_refresh_token}
            self._store.update_tokens(user_id, access_token, rotated_refresh_token)
            return refreshed
        except Exception:
            # Keep the existing token so a temporary OAuth outage does not
            # prevent the worker from attempting the normal connection.
            return credentials

    def start_user(self, user_id: str, credentials: dict[str, object] | None = None) -> CTraderSession:
        credentials = credentials or self._store.get(user_id)
        if credentials is None:
            raise ValueError("No hay credenciales cTrader para el usuario")
        with self._lock:
            session = self._sessions.get(user_id)
            if session is None:
                credentials = self._refresh_credentials(user_id, credentials)
                session = CTraderSession(self._settings, credentials)
                self._sessions[user_id] = session
                session.start()
            return session

    def start_configured(self) -> None:
        if not self._settings.ctrader_enabled:
            return
        for user_id in self._store.user_ids():
            try:
                self.start_user(user_id)
            except Exception:
                # A single user's expired or invalid credentials must not
                # prevent other users' workers from starting.
                continue

    def stop_all(self) -> None:
        with self._lock:
            users = list(self._sessions)
        for user_id in users:
            self._stop(user_id)

    def stop_user(self, user_id: str) -> None:
        self._stop(user_id)

    def session(self, user_id: str) -> CTraderSession | None:
        return self._sessions.get(user_id)

    def execute(self, user_id: str, command: dict[str, object]) -> dict[str, object]:
        status = self.snapshot(user_id)
        session = self.session(user_id)
        if session is None or not status.get("healthy"):
            raise RuntimeError(status.get("error_message") or "cTrader no está conectado.")
        symbols = session.symbols()
        symbol = str(command.get("symbol", "")).upper()
        symbol_id = symbols.get(symbol)
        if symbol_id is None:
            raise ValueError(f"Símbolo cTrader no disponible: {symbol}")
        return session.order({"type": "PLACE_ORDER", **command, "symbol_id": symbol_id})

    def execute_raw(self, user_id: str, command: dict[str, object]) -> dict[str, object]:
        status = self.snapshot(user_id)
        session = self.session(user_id)
        if session is None or not status.get("healthy"):
            raise RuntimeError(status.get("error_message") or "cTrader no está conectado.")
        return session.order(command)


def _message_dict(message: object) -> dict[str, object]:
    """Keep protobuf responses opaque but useful to the authenticated caller."""
    from ctrader_open_api import Protobuf
    payload = Protobuf.extract(message)
    result: dict[str, object] = {}
    for field in payload.DESCRIPTOR.fields:
        if field.name == "payloadType" or field.type in {11, 14}:
            continue
        value = getattr(payload, field.name)
        if value not in (None, "", 0, False):
            result[field.name] = value
    return result
