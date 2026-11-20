from app.scanner_analysis import ScannerAnalysisConfig, _limited_operations, _simulate, activity_state, analyze_tracker, analyze_tracker_operations
from app.profiling import Profiling


def test_tracker_does_not_count_signal_candle_wick_after_close_entry() -> None:
    bars = [
        {"time": 0, "open": 100, "high": 101, "low": 99, "close": 100},
        {"time": 60, "open": 100, "high": 101, "low": 99, "close": 100},
        # The LONG signal is known only at this candle's close. Its low of 50
        # happened before the fill and must not affect the operation's MINROE.
        {"time": 120, "open": 100, "high": 101, "low": 50, "close": 100},
        {"time": 180, "open": 100, "high": 100.2, "low": 99.9, "close": 100.2},
    ]
    signals = [None, None, ("LONG", "L1"), ("SHORT", "H1")]
    operations = _simulate(
        bars,
        ScannerAnalysisConfig(tracker_period=2, stop_percent=10, leverage=1),
        target_percent=0.1,
        signals=signals,
    )

    assert len(operations) == 1
    assert operations[0]["entry_time"] == 120
    assert operations[0]["min_roe_time"] == 180
    assert operations[0]["min_roe"] > -0.2


def test_limited_floor_cannot_be_tighter_than_fixed_price_stop() -> None:
    operation = {
        "pnl": 1.0,
        "status": "WIN",
        "side": "LONG",
        "entry_price": 100.0,
        "exit_price": 101.0,
        "leverage": 20.0,
        "min_roe": -1.54,
        "notional": 605.8489,
    }
    _equity, adjusted = _limited_operations(
        [operation],
        ScannerAnalysisConfig(stop_percent=0.2, leverage=20),
    )

    # The adaptive MINROE (-1.54% ROE = -0.077% price) has not reached
    # the fixed -0.20% price stop (-4.00% ROE at 20x).
    assert adjusted[0]["limited"] is False
    assert adjusted[0]["result_roe"] > -4.0
    assert adjusted[0]["pnl"] == operation["pnl"]


def test_tracker_analysis_reports_optimal_tp_and_average_duration() -> None:
    bars = [
        {"time": 0, "open": 100, "high": 101, "low": 99, "close": 100},
        {"time": 60, "open": 100, "high": 101, "low": 99, "close": 100},
        {"time": 120, "open": 100, "high": 102, "low": 100, "close": 102},
        # The SHORT's high crosses the fixed 0.20% price stop in ROE terms,
        # while the close remains open and the later Tracker close is a WIN.
        {"time": 180, "open": 102, "high": 102.5, "low": 101.9, "close": 101.9},
        {"time": 240, "open": 101.8, "high": 102, "low": 99.5, "close": 99.5},
    ]
    result = analyze_tracker(bars, ScannerAnalysisConfig(tracker_period=2, min_tp_percent=.1, max_tp_percent=.1, tp_step_percent=.1))

    assert result["tp_optimal_percent"] == .1
    assert result["operations"] == 1
    # A win that crosses the limited stop keeps its WIN classification/filter,
    # while its realized PNL and balance reflect the stop loss.
    assert result["wins"] == 1
    assert result["losses"] == 0
    assert result["average_duration_minutes"] == 2
    assert result["final_result_usdt"] < 0
    assert result["max_balance"] == 100.0
    assert result["min_balance"] == result["equity_final"]
    assert len(result["operation_details"]) == result["operations"]
    assert result["operation_details"][0]["entry_price"] == 102
    assert result["operation_details"][0]["exit_price"] == 99.5
    assert result["operation_details"][0]["status"] == "WIN"
    assert result["operation_details"][0]["raw_status"] == "WIN"
    assert result["operation_details"][0]["limited"] is True
    assert result["operation_details"][0]["pnl"] < 0
    assert result["operation_details"][0]["raw_pnl"] > 0

    selected = analyze_tracker_operations(
        bars,
        ScannerAnalysisConfig(tracker_period=2, min_tp_percent=.1, max_tp_percent=.1, tp_step_percent=.1),
        target_percent=result["tp_optimal_percent"],
    )
    for key in ("operations", "wins", "losses", "win_rate", "equity_final", "final_result_usdt", "max_balance", "min_balance", "average_duration_minutes"):
        assert selected[key] == result[key]
    assert selected["operation_details"] == result["operation_details"]


def test_activity_state_has_stable_thresholds() -> None:
    assert activity_state(.1) == "DORMIDA"
    assert activity_state(.25) == "DESPERTANDO"
    assert activity_state(.6) == "ACTIVA"


def test_profiling_collects_stage_timings() -> None:
    profiling = Profiling("test")
    with profiling.measure("parse"):
        pass

    snapshot = profiling.snapshot()
    assert snapshot["name"] == "test"
    assert snapshot["total_ms"] >= 0
    assert snapshot["stages"][0]["stage"] == "parse"
    assert snapshot["stages"][0]["count"] == 1


def test_profiling_records_chronological_checkpoints() -> None:
    profiling = Profiling("test")
    profiling.mark("start", item=1)
    profiling.mark("end")

    marks = profiling.snapshot()["marks"]
    assert [mark["stage"] for mark in marks] == ["start", "end"]
    assert marks[0]["item"] == 1
    assert marks[0]["elapsed_ms"] <= marks[1]["elapsed_ms"]
