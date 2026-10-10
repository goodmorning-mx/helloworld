from app.scanner_analysis import ScannerAnalysisConfig, activity_state, analyze_tracker


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
