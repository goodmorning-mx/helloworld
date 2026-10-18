from app.adaptive_tracker import MIN_CALIBRATION_BARS, WINDOW_BARS, calibrate_tracker_parameters, minroe_to_price_stop_percent


def test_adaptive_calibration_uses_closed_rolling_window_and_levels_n_bounds():
    bars = [
        {"time": index * 60, "open": 100, "high": 100, "low": 100, "close": 100, "closed": True}
        for index in range(WINDOW_BARS + 5)
    ]
    bars.append({"time": (WINDOW_BARS + 5) * 60, "open": 100, "high": 102, "low": 99, "close": 101, "closed": False})

    parameters = calibrate_tracker_parameters(bars)

    assert parameters["status"] == "ADAPTIVE"
    assert parameters["bars"] == WINDOW_BARS
    assert parameters["last_bar_time"] == (WINDOW_BARS + 4) * 60
    assert 4 <= parameters["tracker_period"] <= 20
    assert 0.1 <= parameters["target_percent"] <= 20
    assert 0.05 <= parameters["stop_percent"] <= 20


def test_adaptive_calibration_keeps_safe_defaults_with_small_history():
    bars = [
        {"time": index * 60, "open": 100, "high": 100, "low": 100, "close": 100, "closed": True}
        for index in range(MIN_CALIBRATION_BARS - 1)
    ]

    parameters = calibrate_tracker_parameters(bars)

    assert parameters["status"] == "INSUFFICIENT_HISTORY"
    assert parameters["tracker_period"] == 5
    assert parameters["target_percent"] == 1.0
    assert parameters["stop_percent"] == 0.2


def test_minroe_stop_converts_to_unleveraged_price_distance():
    assert minroe_to_price_stop_percent(20, 20) == 1
    assert minroe_to_price_stop_percent(0, 10) == 0.2
