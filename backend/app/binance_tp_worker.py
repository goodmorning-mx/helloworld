"""Backend-owned programmatic take-profit executor.

Prices arrive from Binance's mark-price WebSocket. The worker never depends on
the browser and never polls the price REST endpoint.
"""

from __future__ import annotations

import json
import logging
import threading
import time

from websockets.sync.client import connect

from app.binance_credentials import BinanceMonitorManager
from app.binance_execution import BinanceExecutionStore

logger = logging.getLogger(__name__)


class BinanceTakeProfitWorker:
    def __init__(self, manager: BinanceMonitorManager, store: BinanceExecutionStore, base_url: str):
        self._manager = manager
        self._store = store
        self._ws_base = "wss://fstream.binance.com/ws"
        if "testnet" in base_url:
            self._ws_base = "wss://stream.binancefuture.com/ws"
        self._stop = threading.Event()
        self._jobs: dict[str, threading.Thread] = {}
        self._lock = threading.RLock()

    def register(self, user_id: str, intent: dict[str, object]) -> None:
        intent_id = str(intent.get("id") or "")
        symbol = str(intent.get("symbol") or "").upper()
        target = float(intent.get("take_profit") or 0)
        quantity = abs(float(intent.get("quantity") or 0))
        side = str(intent.get("side") or "").upper()
        if not intent_id or not symbol or target <= 0 or quantity <= 0 or side not in {"LONG", "SHORT"}:
            return
        with self._lock:
            if intent_id in self._jobs:
                return
            thread = threading.Thread(
                target=self._run, args=(user_id, intent_id, symbol, side, quantity, target),
                name=f"binance-tp-{symbol}-{intent_id[:8]}", daemon=True,
            )
            self._jobs[intent_id] = thread
            thread.start()
        logger.info("binance_tp_registered user=%s symbol=%s intent=%s target=%s", user_id, symbol, intent_id, target)

    def stop(self) -> None:
        self._stop.set()
        with self._lock:
            jobs = list(self._jobs.values())
        for job in jobs:
            job.join(timeout=3)
        with self._lock:
            self._jobs.clear()

    def _run(self, user_id: str, intent_id: str, symbol: str, side: str, quantity: float, target: float) -> None:
        close_side = "SELL" if side == "LONG" else "BUY"
        try:
            delay = 1.0
            while not self._stop.is_set():
                try:
                    url = f"{self._ws_base}/{symbol.lower()}@markPrice@1s"
                    with connect(url, open_timeout=10, ping_interval=20, ping_timeout=20, close_timeout=5) as socket:
                        delay = 1.0
                        for raw in socket:
                            if self._stop.is_set():
                                return
                            data = json.loads(raw)
                            price = float(data.get("p") or 0)
                            reached = price >= target if side == "LONG" else price <= target
                            if not reached:
                                continue
                            # Persist the transition before submitting so a
                            # reconnect cannot submit two programmatic exits.
                            intent = self._store.update(intent_id, user_id, status="CLOSING")
                            if not intent:
                                return
                            logger.info("binance_tp_triggered user=%s symbol=%s price=%s target=%s", user_id, symbol, price, target)
                            self._manager.place_market_order(
                                user_id, symbol, close_side, quantity,
                                f"{intent['client_order_id']}_tp", reduce_only=True,
                            )
                            self._store.update(intent_id, user_id, status="CLOSED", last_error=None)
                            return
                except Exception:
                    logger.exception("binance_tp_stream_error user=%s symbol=%s retry_seconds=%s", user_id, symbol, delay)
                    self._stop.wait(delay)
                    delay = min(delay * 2, 30.0)
        finally:
            with self._lock:
                self._jobs.pop(intent_id, None)
