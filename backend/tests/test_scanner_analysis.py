from app.scanner_analysis import ScannerAnalysisConfig, activity_state, analyze_tracker
from app.profiling import Profiling


def test_tracker_analysis_reports_optimal_tp_and_average_duration() -> None:
    bars = [
        {"time": 0, "open": 100, "high": 101, "low": 99, "close": 100},
        {"time": 60, "open": 100, "high": 101, "low": 99, "close": 100},
        {"time": 120, "open": 100, "high": 102, "low": 100, "close": 102},
        {"time": 180, "open": 102, "high": 102, "low": 101.9, "close": 101.9},
        {"time": 240, "open": 101.8, "high": 102, "low": 99.5, "close": 99.5},
    ]
    result = analyze_tracker(bars, ScannerAnalysisConfig(tracker_period=2, min_tp_percent=.1, max_tp_percent=.1, tp_step_percent=.1))

    assert result["tp_optimal_percent"] == .1
    assert result["operations"] == 1
    assert result["wins"] == 1
    assert result["losses"] == 0
    assert result["average_duration_minutes"] == 2
    assert result["final_result_usdt"] > 0


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
