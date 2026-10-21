import asyncio

import pytest

from app.telegram_control import TelegramControlService, format_scanner_message
from app.config import Settings


class FakeWorkers:
    def __init__(self):
        self.started = []
        self.stopped = []
        self.workers = []

    async def start(self, user_id, symbol, **kwargs):
        self.started.append((user_id, symbol, kwargs))
        return {"symbol": symbol, "status": "RUNNING", "mode": kwargs["mode"]}

    async def stop(self, user_id, symbol):
        self.stopped.append((user_id, symbol))
        return {"symbol": symbol, "status": "STOPPED"}

    def list(self, user_id):
        return self.workers


def test_control_starts_signal_session_and_normalizes_symbols():
    async def run():
        workers = FakeWorkers()
        control = TelegramControlService(workers, lambda *_: asyncio.sleep(0, result={"symbols": []}))
        result = await control.start("owner", "btcUsdt")
        assert result["mode"] == "signals_only"
        assert workers.started == [("owner", "BTCUSDT", {
            "mode": "signals_only", "interval": "1m", "tracker_period": 5,
            "stop_percent": 0.2, "target_percent": 1.0,
            "risk_percent": 1.0, "leverage": 1.0, "initial_balance": 100.0,
        })]

    asyncio.run(run())


@pytest.mark.parametrize("symbol", ["BTC", "BTC/USDT", "../BTCUSDT", "BTCUSDT?x=1"])
def test_control_rejects_invalid_symbols(symbol):
    async def run():
        control = TelegramControlService(FakeWorkers(), lambda *_: asyncio.sleep(0, result={"symbols": []}))
        with pytest.raises(ValueError, match="Símbolo inválido"):
            await control.start("owner", symbol)

    asyncio.run(run())


def test_scanner_message_is_bounded_and_formats_ranked_result():
    message = format_scanner_message([
        {
            "symbol": "BTCUSDT", "status": "VALID", "final_result_usdt": 12.345,
            "tp_optimal_percent": 2.5, "operations": 8, "wins": 5,
            "losses": 3, "activity_state": "ACTIVA",
        }
    ], updated_at=0)
    assert "BTCUSDT" in message
    assert "+12.35 USDT" in message
    assert "TP 2.50%" in message
    assert "Ops 8 · W 5/L 3" in message
    assert len(message) <= 3900


def test_status_contains_worker_runtime_metrics():
    workers = FakeWorkers()
    workers.workers = [{
        "symbol": "BTCUSDT", "status": "RUNNING", "queue_depth": 2,
        "events_processed": 10, "p95_event_latency_ms": 18.5,
    }]
    control = TelegramControlService(workers, lambda *_: asyncio.sleep(0, result={"symbols": []}))
    result = control.status("owner")
    assert result["count"] == 1
    assert "cola 2" in result["text"]
    assert "p95 18.5 ms" in result["text"]


def test_automatic_telegram_signal_messages_are_enabled_by_default():
    assert Settings(_env_file=None).telegram_signal_notifications_enabled is True


def test_api_exposes_authenticated_telegram_control_routes():
    from app.main import app

    paths = {(route.path, tuple(sorted(route.methods or []))) for route in app.routes if hasattr(route, "methods")}
    assert ("/telegram/scan", ("GET",)) in paths
    assert ("/telegram/status", ("GET",)) in paths
    assert ("/telegram/workers", ("GET",)) in paths
    assert ("/telegram/workers", ("POST",)) in paths
    assert ("/telegram/workers/{symbol}", ("DELETE",)) in paths
    assert ("/telegram/workers/{symbol}/mode", ("PATCH",)) in paths


def test_internal_scanner_snapshot_uses_shared_cached_analysis_and_compact_results(monkeypatch):
    from app import main

    calls = {}

    def active_symbols(**kwargs):
        calls["active"] = kwargs
        return {"symbols": [
            {"symbol": "BTCUSDT", "variation_average_pct": 0.5},
            {"symbol": "ETHUSDT", "variation_average_pct": 0.7},
        ]}

    async def scanner_analysis(**kwargs):
        calls["analysis"] = kwargs
        return {
            "updated_at": 1,
            "config": {"tracker_period": 5},
            "symbols": [
                {"symbol": "BTCUSDT", "status": "VALID", "final_result_usdt": 2, "operations": 1, "profiling": {"secretly_large": True}},
                {"symbol": "ETHUSDT", "status": "VALID", "final_result_usdt": 3, "operations": 2},
            ],
        }

    class FakeWorkerManager:
        def list(self, _user_id):
            return [{
                "symbol": "ETHUSDT", "running": True, "parameter_version": 7,
                "adaptive_parameters": {"target_percent": 2.5, "stop_percent": 0.4, "tracker_period": 9, "risk_percent": 1.2, "risk_usdt": 1.2},
            }]

    monkeypatch.setattr(main, "binance_active_symbols", active_symbols)
    monkeypatch.setattr(main, "binance_scanner_analysis", scanner_analysis)
    monkeypatch.setattr(main, "production_workers", FakeWorkerManager())
    snapshot = asyncio.run(main._telegram_scan_snapshot("owner", 2))

    assert snapshot["symbols"][0]["symbol"] == "ETHUSDT"
    assert "profiling" not in snapshot["symbols"][0]
    assert snapshot["symbols"][0]["tracker_period"] == 9
    assert snapshot["symbols"][0]["parameter_source"] == "TRACKER_WORKER"
    assert "N 9" in snapshot["text"]
    assert "SL 0.40%" in snapshot["text"]
    assert calls["analysis"]["symbols"] == "BTCUSDT,ETHUSDT"
    assert calls["analysis"]["limit"] == 480
    assert "ETHUSDT" in snapshot["text"]
