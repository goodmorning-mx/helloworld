from app import walk_forward


def _flat_bars(count: int) -> list[dict[str, float | int | bool]]:
    return [
        {"time": index * 60, "open": 100, "high": 100.1, "low": 99.9, "close": 100, "closed": True}
        for index in range(count)
    ]


def _fake_snapshot(history, *, current_balance, risk_percent, leverage, current_period, coarse, fee_rate, loss_limit_selection):
    return {
        "status": "ADAPTIVE", "tracker_period": 4, "target_percent": 1.0,
        "stop_percent": 0.2, "minroe_limit_percent": 4.0,
        "bars": len(history), "last_bar_time": history[-1]["time"],
    }


def test_walk_forward_calibrates_only_from_preceding_closed_bars(monkeypatch):
    observed = []

    def snapshot(history, **kwargs):
        observed.append((history[0]["time"], history[-1]["time"], kwargs["coarse"]))
        return _fake_snapshot(history, **kwargs)

    monkeypatch.setattr(walk_forward, "_snapshot", snapshot)
    bars = _flat_bars(190)
    bars.append({"time": 190 * 60, "open": 100, "high": 102, "low": 99, "close": 101, "closed": False})

    result = walk_forward.run_walk_forward(
        bars, symbol="TESTUSDT", window_bars=120, recalibration_bars=30,
    )

    assert result["status"] == "COMPLETE"
    assert result["bars"] == 190
    assert len(observed) == 3
    for training_start, training_end, coarse in observed:
        assert training_start <= training_end
        assert coarse is False
    assert all(fold["training_through"] < fold["effective_from"] for fold in result["folds"])


def test_study_chooses_window_on_tuning_then_uses_untouched_holdout(monkeypatch):
    monkeypatch.setattr(walk_forward, "_snapshot", _fake_snapshot)
    result = walk_forward.run_walk_forward_study(
        _flat_bars(600), symbol="TESTUSDT", window_candidates=(120, 240),
        recalibration_bars=60, holdout_fraction=0.25,
    )

    assert result["status"] == "COMPLETE"
    assert result["tuning_bars"] == 360
    assert result["holdout_bars"] == 240
    assert result["holdout_start"] == 360 * 60
    assert result["selected_window_bars"] in (120, 240)
    assert result["holdout"]["evaluation_start"] == result["holdout_start"]
    assert result["holdout"]["calibration_search"] == "coarse"


def test_adaptive_window_choices_use_only_completed_shadow_segments(monkeypatch):
    monkeypatch.setattr(walk_forward, "_snapshot", _fake_snapshot)
    result = walk_forward.run_adaptive_window_walk_forward(
        _flat_bars(260), symbol="TESTUSDT", window_candidates=(120, 180),
        recalibration_bars=15, evaluation_start_index=180,
    )

    assert result["mode"] == "ADAPTIVE_WINDOW_WALK_FORWARD"
    assert result["result"]["window_bars"] == 180
    assert result["selection_history"][0]["scores"] == {}
    for fold in result["selection_history"][1:]:
        assert fold["score_segment_through"] < fold["effective_from"]
        assert set(fold["scores"]) == {"120", "180"}
    assert all(fold["window_bars"] in {120, 180} for fold in result["result"]["folds"])


def test_walk_forward_keeps_each_open_operation_parameter_version(monkeypatch):
    monkeypatch.setattr(walk_forward, "_snapshot", _fake_snapshot)
    result = walk_forward.run_walk_forward(
        _flat_bars(121), symbol="TESTUSDT", window_bars=120, recalibration_bars=15,
    )

    # Every reported trade carries the immutable snapshot version used at entry.
    assert all("parameter_version" in operation for operation in result["operations"])
    assert all(4 <= operation["tracker_period"] <= 20 for operation in result["operations"])
    assert all(operation["target_percent"] == 1.0 for operation in result["operations"])


def test_open_trade_keeps_its_entry_snapshot_after_recalibration(monkeypatch):
    def changing_snapshot(history, **kwargs):
        target = 1.0 if history[-1]["time"] < 8_000 else 2.0
        return {**_fake_snapshot(history, **kwargs), "target_percent": target}

    def signal(close, _levels):
        if close > 101:
            return "SHORT", "H1"
        return "LONG", "L1"

    def close_reason(side, entry, close, stop, target):
        movement = (close - entry) / entry * (1 if side == "LONG" else -1) * 100
        if movement <= -abs(stop):
            return "SL"
        if movement >= abs(target):
            return "TP"
        return None

    monkeypatch.setattr(walk_forward, "_snapshot", changing_snapshot)
    monkeypatch.setattr(walk_forward, "tracker_signal", signal)
    monkeypatch.setattr(walk_forward, "tracker_close_reason", close_reason)
    bars = _flat_bars(150)
    bars[136].update({"open": 101, "high": 101.2, "low": 100.9, "close": 101.1})

    result = walk_forward.run_walk_forward(
        bars, symbol="TESTUSDT", window_bars=120, recalibration_bars=15,
    )

    first_trade = result["operations"][0]
    assert first_trade["parameter_version"] == 1
    assert first_trade["target_percent"] == 1.0
    assert first_trade["close_reason"] == "TP"


def test_clean_bars_deduplicates_timestamps_and_drops_open_candles():
    bars = _flat_bars(2)
    bars.append({"time": 60, "open": 100, "high": 105, "low": 98, "close": 104, "closed": True})
    bars.append({"time": 120, "open": 100, "high": 105, "low": 98, "close": 104, "closed": False})

    cleaned = walk_forward._clean_bars(bars)

    assert len(cleaned) == 2
    assert cleaned[-1]["time"] == 60
    assert cleaned[-1]["close"] == 104
