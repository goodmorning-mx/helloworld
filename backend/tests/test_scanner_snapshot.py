import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.scanner_snapshot import public_snapshot


def test_snapshot_is_fresh_for_three_minutes_and_keeps_one_payload():
    now = datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)
    snapshot = {
        "scan_id": "scan-1",
        "config": {"tracker_period": 8, "stop_percent": 0.3},
        "universe": [{"symbol": "BTCUSDT", "leverage": 10}],
        "symbols": [{"symbol": "BTCUSDT", "tp_optimal_percent": 2.2}],
        "updated_at": now - timedelta(seconds=120),
    }

    result = public_snapshot(snapshot, now=now)

    assert result["freshness"] == "FRESH"
    assert result["age_seconds"] == 120
    assert result["config"] == snapshot["config"]
    assert result["symbols"] == snapshot["symbols"]
    assert result["window_seconds"] == 28_800


def test_old_snapshot_is_explicitly_stale():
    now = datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)
    snapshot = {
        "scan_id": "scan-1", "config": {}, "universe": [], "symbols": [],
        "updated_at": now - timedelta(seconds=181),
    }

    result = public_snapshot(snapshot, now=now)

    assert result["freshness"] == "STALE"
    assert result["age_seconds"] == 181


def test_scanner_snapshot_accepts_valid_two_character_binance_base_symbol():
    from app import main

    payload = main.ScannerSnapshotSymbolInput(
        symbol="OPUSDT", variation_average_pct=0.7, leverage=12,
    )

    assert payload.symbol == "OPUSDT"


def test_web_snapshot_uses_existing_scanner_parameters_and_saves_complete_rows(monkeypatch):
    from app import main

    analysis_calls = []
    saved = {}

    async def analyze(**kwargs):
        analysis_calls.append(kwargs)
        return {"symbols": [{
            "symbol": kwargs["symbols"], "status": "VALID", "tp_optimal_percent": 2.4,
            "loss_limit_percent": 5.0, "operations": 7, "wins": 4, "losses": 3,
            "win_rate": 57.1, "equity_final": 105.0, "final_result_usdt": 5.0,
            "average_duration_minutes": 3.5, "last_bar_time": 1_800_000_000,
            "bars": 480, "activity_state": "ACTIVA",
        }]}

    class FakeStore:
        def get(self, _user_id):
            return None

        def replace(self, user_id, **snapshot):
            saved["user_id"] = user_id
            saved.update(snapshot)
            return {**snapshot, "user_id": user_id, "updated_at": datetime.now(timezone.utc)}

    monkeypatch.setattr(main, "binance_scanner_analysis", analyze)
    monkeypatch.setattr(main, "scanner_snapshot_store", FakeStore())
    payload = main.ScannerSnapshotInput(
        symbols=[{"symbol": "BTCUSDT", "variation_average_pct": 0.7, "leverage": 12}],
        tracker_period=8, stop_percent=0.35, initial_balance=250, risk_percent=1.5,
    )

    result = asyncio.run(main.update_scanner_snapshot(payload, SimpleNamespace(user_id="owner")))

    assert len(analysis_calls) == 1
    assert analysis_calls[0]["tracker_period"] == 8
    assert analysis_calls[0]["stop_percent"] == 0.35
    assert analysis_calls[0]["initial_balance"] == 250
    assert analysis_calls[0]["risk_percent"] == 1.5
    assert analysis_calls[0]["leverage"] == 12
    assert analysis_calls[0]["limit"] == 480
    assert saved["user_id"] == "owner"
    assert result["symbols"][0]["tp_optimal_percent"] == 2.4
    assert result["symbols"][0]["loss_limit_percent"] == 5.0
    assert result["symbols"][0]["tracker_period"] == 8
    assert result["symbols"][0]["leverage"] == 12
    assert result["symbols"][0]["risk_usdt"] == 3.75
