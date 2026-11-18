import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.scanner_snapshot import public_snapshot, worker_parameters_from_snapshot


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
    assert result["symbols"][0]["symbol"] == "BTCUSDT"
    assert result["symbols"][0]["active_parameters"]["target_percent"] == 2.2
    assert result["symbols"][0]["active_parameters"]["tracker_period"] == 8
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


def test_public_snapshot_exposes_worker_parameters_as_current_symbol_values():
    snapshot = {
        "scan_id": "scan-2", "config": {}, "universe": [],
        "symbols": [{
            "symbol": "BTCUSDT", "status": "VALID", "tp_optimal_percent": 2.0,
            "tracker_period": 8, "stop_percent": 0.2, "loss_limit_percent": 6.0,
            "worker_parameters": {
                "source": "WORKER", "running": True, "tracker_period": 11,
                "target_percent": 3.5, "stop_percent": 0.3, "parameter_version": 4,
            },
        }],
        "updated_at": datetime.now(timezone.utc),
    }

    public = public_snapshot(snapshot)

    assert public["symbols"][0]["active_parameters"]["source"] == "WORKER"
    assert public["symbols"][0]["active_parameters"]["target_percent"] == 3.5
    assert public["symbols"][0]["active_parameters"]["tracker_period"] == 11


def test_worker_startup_parameters_come_from_the_shared_symbol_row():
    snapshot = {
        "config": {"tracker_period": 8, "stop_percent": 0.25, "risk_percent": 1.5, "initial_balance": 250},
        "symbols": [{
            "symbol": "BTCUSDT", "status": "VALID", "tp_optimal_percent": 2.4,
            "loss_limit_percent": 5.0, "tracker_period": 8, "stop_percent": 0.25,
            "risk_percent": 1.5, "initial_balance": 250, "leverage": 12,
        }],
    }

    parameters = worker_parameters_from_snapshot(snapshot, "btcusdt")

    assert parameters == {
        "tracker_period": 8, "stop_percent": 0.25, "target_percent": 2.4,
        "minroe_limit_percent": 5.0, "risk_percent": 1.5, "leverage": 12,
        "initial_balance": 250, "bars": 0, "last_bar_time": None,
        "status": "SCANNER_SNAPSHOT",
    }


def test_stopped_worker_parameters_fall_back_to_latest_scanner_result():
    snapshot = {
        "config": {},
        "symbols": [{
            "symbol": "BTCUSDT", "status": "VALID", "tp_optimal_percent": 1.8,
            "tracker_period": 7, "stop_percent": 0.2,
            "worker_parameters": {"running": False, "target_percent": 9.0, "tracker_period": 20},
        }],
    }

    parameters = worker_parameters_from_snapshot(snapshot, "BTCUSDT")

    assert parameters["target_percent"] == 1.8
    assert parameters["tracker_period"] == 7


def test_scanner_snapshot_accepts_valid_two_character_binance_base_symbol():
    from app import main

    payload = main.ScannerSnapshotSymbolInput(
        symbol="OPUSDT", variation_average_pct=0.7, leverage=12,
    )

    assert payload.symbol == "OPUSDT"


def test_scanner_snapshot_normalizes_case_and_whitespace_before_validation():
    from app import main

    payload = main.ScannerSnapshotSymbolInput(
        symbol="  btcusdt ", variation_average_pct=0.7, leverage=12,
    )

    assert payload.symbol == "BTCUSDT"


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


def test_web_snapshot_reuses_running_worker_parameters_for_its_result(monkeypatch):
    from app import main

    worker_parameters = {
        "running": True, "source": "WORKER", "parameter_version": 7,
        "tracker_period": 9, "stop_percent": 0.3, "target_percent": 2.25,
        "initial_balance": 420, "risk_percent": 1.2, "leverage": 12,
    }
    previous = {
        "config": {"tracker_period": 5, "stop_percent": 0.2, "initial_balance": 100, "risk_percent": 1},
        "universe": [{"symbol": "DOGEUSDT", "leverage": 10}],
        "symbols": [{"symbol": "DOGEUSDT", "worker_parameters": worker_parameters}],
    }
    calls = []
    saved = {}

    async def analyze(**kwargs):
        calls.append(kwargs)
        return {"symbols": [{
            "symbol": "DOGEUSDT", "status": "VALID", "tp_optimal_percent": kwargs["target_percent"],
            "average_duration_minutes": 2.0, "operations": 4, "wins": 2, "losses": 2,
            "win_rate": 50.0, "equity_final": 435.0, "final_result_usdt": 15.0,
            "loss_limit_percent": 5.0, "last_bar_time": 1_800_000_000, "bars": 480,
        }]}

    class FakeStore:
        def get(self, _user_id):
            return previous

        def replace(self, user_id, **snapshot):
            saved["user_id"] = user_id
            saved.update(snapshot)
            return {**snapshot, "user_id": user_id, "updated_at": datetime.now(timezone.utc)}

    monkeypatch.setattr(main, "binance_scanner_analysis", analyze)
    monkeypatch.setattr(main, "scanner_snapshot_store", FakeStore())
    payload = main.ScannerSnapshotInput(
        symbols=[{"symbol": "DOGEUSDT", "variation_average_pct": 0.7, "leverage": 10}],
        tracker_period=5, stop_percent=0.2, initial_balance=100, risk_percent=1,
    )

    result = asyncio.run(main.update_scanner_snapshot(payload, SimpleNamespace(user_id="owner")))

    assert len(calls) == 1
    assert calls[0]["tracker_period"] == 9
    assert calls[0]["stop_percent"] == 0.3
    assert calls[0]["initial_balance"] == 420
    assert calls[0]["risk_percent"] == 1.2
    assert calls[0]["leverage"] == 12
    assert calls[0]["target_percent"] == 2.25
    assert calls[0]["include_operations"] is False
    row = saved["symbols"][0]
    assert row["final_result_usdt"] == 15.0
    assert row["tp_optimal_percent"] == 2.25
    assert row["analysis_parameter_version"] == 7
    assert result["symbols"][0]["final_result_usdt"] == 15.0


def test_worker_parameter_publication_refreshes_shared_result_asynchronously(monkeypatch):
    from app import main

    published = []
    analyzed = []

    class FakeStore:
        def publish_worker_parameters(self, user_id, symbol, parameters):
            published.append(("parameters", user_id, symbol, dict(parameters)))

        def publish_worker_analysis(self, user_id, symbol, analysis, *, parameter_version):
            published.append(("analysis", user_id, symbol, dict(analysis), parameter_version))
            return True

    async def analyze(**kwargs):
        analyzed.append(kwargs)
        return {"symbols": [{"symbol": "BTCUSDT", "status": "VALID", "final_result_usdt": 12.0}]}

    monkeypatch.setattr(main, "scanner_snapshot_store", FakeStore())
    monkeypatch.setattr(main, "binance_scanner_analysis", analyze)
    monkeypatch.setattr(main, "_shared_analysis_refresh_tasks", {})
    monkeypatch.setattr(main, "_shared_analysis_refresh_requested", {})
    parameters = {
        "running": True, "parameter_version": 5, "tracker_period": 8,
        "stop_percent": 0.3, "target_percent": 2.4, "initial_balance": 300,
        "risk_percent": 1.5, "leverage": 10,
    }

    async def scenario():
        await main._publish_shared_worker_parameters("owner", "BTCUSDT", parameters)
        assert [item[0] for item in published] == ["parameters"]
        task = main._shared_analysis_refresh_tasks[("owner", "BTCUSDT")]
        await task

    asyncio.run(scenario())

    assert len(analyzed) == 1
    assert analyzed[0]["target_percent"] == 2.4
    assert analyzed[0]["tracker_period"] == 8
    assert published[-1][0] == "analysis"
    assert published[-1][-1] == 5
