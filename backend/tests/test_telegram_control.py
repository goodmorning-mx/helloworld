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
    assert ("/trading/production/workers/events", ("GET",)) in paths
    assert ("/market/binance/scanner-snapshot", ("GET",)) in paths
    assert ("/market/binance/scanner-snapshot", ("POST",)) in paths


def test_telegram_scan_reads_exact_latest_web_snapshot_without_recalculating(monkeypatch):
    from app import main
    from datetime import datetime, timezone

    row = {
        "symbol": "ETHUSDT", "status": "VALID", "tp_optimal_percent": 2.5,
        "loss_limit_percent": 3.0, "stop_percent": 0.4, "tracker_period": 9,
        "leverage": 10, "risk_percent": 1.2, "final_result_usdt": 3.0,
        "equity_final": 103.0, "operations": 2, "wins": 1, "losses": 1,
        "win_rate": 50.0, "average_duration_minutes": 4.5,
        "activity_state": "ACTIVA", "last_bar_time": 1_800_000_000,
        "bars": 480, "window_seconds": 28_800,
    }
    class FakeSnapshotStore:
        def get(self, user_id):
            assert user_id == "owner"
            return {
                "scan_id": "scan-1", "config": {"tracker_period": 9, "leverage": 10},
                "universe": [{"symbol": "ETHUSDT", "leverage": 10}], "symbols": [row],
                "started_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc),
            }

    monkeypatch.setattr(main, "scanner_snapshot_store", FakeSnapshotStore())
    monkeypatch.setattr(main, "binance_active_symbols", lambda **_kwargs: pytest.fail("Telegram must not rebuild the universe"))
    monkeypatch.setattr(main, "binance_scanner_analysis", lambda **_kwargs: pytest.fail("Telegram must not recalculate analysis"))
    snapshot = asyncio.run(main._telegram_scan_snapshot("owner", 2))

    assert snapshot["symbols"][0]["symbol"] == "ETHUSDT"
    assert snapshot["symbols"][0]["tracker_period"] == 9
    assert snapshot["symbols"][0]["leverage"] == 10
    assert "N 9" in snapshot["text"]
    assert "SL 0.40%" in snapshot["text"]
    assert "10.0x" in snapshot["text"]
    assert "WR 50.0%" in snapshot["text"]
    assert "ETHUSDT" in snapshot["text"]
