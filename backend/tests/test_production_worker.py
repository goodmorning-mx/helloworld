import asyncio
import pytest

from app.production_worker import BinanceExecutionAdapter, PaperExecutionAdapter, ProductionWorkerManager, SignalOnlyExecutionAdapter, SymbolWorker
from app.telegram_service import BackendEventBus


class FakePaperStore:
    def __init__(self):
        self.rows = {}

    def create(self, user_id, values):
        self.rows[values["id"]] = dict(values)
        return dict(values)

    def update(self, user_id, operation_id, values):
        self.rows[operation_id].update(values)
        return dict(self.rows[operation_id])

    def open_for_symbol(self, user_id, symbol):
        return next((dict(row) for row in self.rows.values() if row.get("symbol") == symbol and row.get("status") == "OPEN" and row.get("source") == "realtime-engine"), None)


class FakeGateway:
    def __init__(self):
        self.bars = {"TESTUSDT": {"1m": [bar(index * 60, 100, 100, 100, 100) for index in range(1500)]}}
        self.listeners = {}

    def snapshot(self, symbol, interval):
        return list(self.bars.get(symbol.upper(), {}).get(interval, []))

    def add_listener(self, symbol, listener):
        self.listeners.setdefault(symbol, set()).add(listener)

    def remove_listener(self, symbol, listener):
        self.listeners.get(symbol, set()).discard(listener)


class FakeRuntimeStore:
    def __init__(self):
        self.states = {}
        self.configs = {}
        self.leases = set()
        self.sessions = {}

    def runtime(self, user_id, symbol):
        return self.states.get((user_id, symbol))

    def claim_lease(self, user_id, symbol, owner_id):
        key = (user_id, symbol)
        if key in self.leases:
            return False
        self.leases.add(key)
        self.states.setdefault(key, {"last_bar_time": None})
        return True

    def save_runtime(self, user_id, symbol, owner_id, *, last_bar_time, status="RUNNING", tracker_operation=None, adaptive_parameters=None, lease_seconds=45):
        key = (user_id, symbol)
        if key not in self.leases:
            return False
        self.states[key] = {"last_bar_time": last_bar_time, "status": status, "tracker_operation": tracker_operation, "adaptive_parameters": adaptive_parameters}
        return True

    def release_lease(self, user_id, symbol, owner_id, status):
        self.leases.discard((user_id, symbol))

    def claim_session(self, user_id, symbol, owner_id, lease_seconds=45):
        current = self.sessions.get(user_id)
        if current is not None and current != owner_id:
            return False
        self.sessions[user_id] = owner_id
        return True

    def renew_session(self, user_id, symbol, owner_id, lease_seconds=45):
        return self.sessions.get(user_id) == owner_id

    def release_session(self, user_id, symbol, owner_id):
        if self.sessions.get(user_id) == owner_id:
            self.sessions.pop(user_id, None)

    def save(self, user_id, config):
        self.configs[(user_id, config["symbol"])] = config

    def disable(self, user_id, symbol):
        self.configs.pop((user_id, symbol.upper()), None)

    def enabled(self):
        return list(self.configs.values())


def bar(time, open_, high, low, close, closed=True):
    return {"time": time, "open": open_, "high": high, "low": low, "close": close, "closed": closed}


def test_tracker_worker_uses_previous_bars_and_one_open_operation():
    async def scenario():
        store = FakePaperStore()
        worker = SymbolWorker("user", "TESTUSDT", "1m", 2, .2, 1.0, PaperExecutionAdapter(risk_usdt=1), store, BackendEventBus())
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": bar(1, 100, 100, 100, 100)})
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": bar(2, 100, 100, 100, 100)})
        # H2: close crosses both previous range levels, opening one SHORT.
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": bar(3, 100, 101, 99, 101)})
        assert worker.operation is not None
        assert worker.operation["side"] == "SHORT"
        opened_id = worker.operation["id"]
        # A new signal while the operation is open is evaluated only after the
        # current operation closes. The completed close reaches the target, so
        # the canonical strategy closes WIN and reverses immediately.
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": bar(4, 101, 102, 100, 99)})
        assert worker.operation is not None
        assert worker.operation["id"] != opened_id
        assert worker.operation["side"] == "LONG"
        assert len(store.rows) == 2
        assert store.rows[opened_id]["status"] == "CLOSED - WIN"

    asyncio.run(scenario())


def test_signal_only_worker_keeps_tracker_alive_without_creating_paper_operations():
    async def scenario():
        events = []

        class RecordingEvents:
            async def publish(self, event):
                events.append(event)

        store = FakePaperStore()
        worker = SymbolWorker("user", "TESTUSDT", "1m", 2, .2, 1.0, SignalOnlyExecutionAdapter(), store, RecordingEvents())
        for candle in [
            bar(1, 100, 100, 100, 100),
            bar(2, 100, 100, 100, 100),
            bar(3, 100, 101, 99, 101),
        ]:
            candle["closed"] = True
            await worker.on_market_event({"type": "kline", "interval": "1m", "bar": candle})
        signal = next(event for event in events if event["type"] == "TRACKER_SIGNAL")
        assert signal["side"] == "SHORT"
        assert signal["mode"] == "signals_only"
        assert worker.tracker_operation is not None
        assert worker.operation is None
        assert store.rows == {}

    asyncio.run(scenario())


def test_mode_switch_keeps_open_paper_trade_on_its_original_adapter():
    async def scenario():
        worker = SymbolWorker("user", "TESTUSDT", "1m", 2, .2, 1.0, PaperExecutionAdapter(), FakePaperStore(), BackendEventBus())
        worker.operation = {"id": "paper-open", "side": "LONG", "entry_price": 100, "stop_percent": .2, "target_percent": 1}
        original_adapter = worker.adapter
        worker.operation_adapter = original_adapter
        manager = ProductionWorkerManager(FakeGateway(), FakePaperStore(), BackendEventBus(), object(), object())
        manager.workers[("user", "TESTUSDT")] = worker
        result = await manager.set_mode("user", "TESTUSDT", "signals_only")
        assert result["mode"] == "signals_only"
        assert worker.operation is None
        assert worker.operation_adapter is None
        assert worker.background_operations == [({"id": "paper-open", "side": "LONG", "entry_price": 100, "stop_percent": .2, "target_percent": 1}, original_adapter)]
        assert worker.adapter is not original_adapter

    asyncio.run(scenario())


def test_background_paper_operation_keeps_closing_after_mode_switch():
    async def scenario():
        store = FakePaperStore()
        operation = {"id": "paper-open", "symbol": "TESTUSDT", "side": "LONG", "entry_price": 100, "stop_percent": .2, "target_percent": 1, "notional": 100, "status": "OPEN"}
        store.rows[operation["id"]] = dict(operation)
        adapter = PaperExecutionAdapter()
        worker = SymbolWorker("user", "TESTUSDT", "1m", 5, .2, 1, SignalOnlyExecutionAdapter(), store, BackendEventBus())
        worker.background_operations.append((operation, adapter))
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": bar(60, 100, 100, 99.7, 99.7)})
        assert store.rows["paper-open"]["status"] == "CLOSED - FAILED"
        assert worker.background_operations == []

    asyncio.run(scenario())


def test_tracker_worker_uses_close_not_intrabar_wick_and_retries_fail_same_candle():
    async def scenario():
        store = FakePaperStore()
        worker = SymbolWorker("user", "TESTUSDT", "1m", 2, .2, 1.0, PaperExecutionAdapter(risk_usdt=1), store, BackendEventBus())
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": bar(1, 100, 100, 100, 100)})
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": bar(2, 100, 100, 100, 100)})
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": bar(3, 100, 101, 99, 101)})
        opened_id = worker.operation["id"]

        # The wick crosses the theoretical SL, but the completed close does
        # not. The operation must remain open.
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": bar(4, 101, 102, 100, 100.9)})
        assert worker.operation is not None
        assert worker.operation["id"] == opened_id

        # The close crosses SL. The same candle is H1 SHORT, so the failed
        # operation is closed and a replacement is opened immediately.
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": bar(5, 100.9, 101.4, 100.8, 101.3)})
        assert store.rows[opened_id]["status"] == "CLOSED - FAILED"
        assert worker.operation is not None
        assert worker.operation["id"] != opened_id
        assert worker.operation["side"] == "SHORT"
        assert len(store.rows) == 2

    asyncio.run(scenario())


def test_execution_exit_does_not_change_the_authoritative_tracker_position():
    async def scenario():
        store = FakePaperStore()
        worker = SymbolWorker("user", "TESTUSDT", "1m", 2, .2, 1.0, PaperExecutionAdapter(risk_usdt=1), store, BackendEventBus())
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": bar(1, 100, 100, 100, 100)})
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": bar(2, 100, 100, 100, 100)})
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": bar(3, 100, 101, 99, 101)})
        tracked_id = dict(worker.tracker_operation)
        worker.operation["stop_percent"] = .05
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": bar(4, 101, 101.2, 100.9, 101.1)})
        assert worker.operation is None
        assert worker.tracker_operation == tracked_id
        assert next(iter(store.rows.values()))["status"] == "CLOSED - FAILED"

    asyncio.run(scenario())


def test_paper_protection_levels_follow_tracker_recalibration():
    async def scenario():
        store = FakePaperStore()
        worker = SymbolWorker("user", "TESTUSDT", "1m", 5, .2, 1.0, PaperExecutionAdapter(), store, BackendEventBus())
        operation = {"id": "paper-1", "symbol": "TESTUSDT", "side": "LONG", "entry_price": 100.0, "stop_price": 99.8, "target_price": 101.0, "status": "OPEN"}
        store.rows[operation["id"]] = dict(operation)
        worker.operation = operation
        worker.stop_percent = .5
        worker.target_percent = 2.0
        worker.parameter_version = 4

        await worker.adapter.update_parameters(worker)

        assert worker.operation["stop_price"] == 99.5
        assert worker.operation["target_price"] == 102.0
        assert worker.operation["parameter_version"] == 4
        assert store.rows["paper-1"]["stop_price"] == 99.5
        assert store.rows["paper-1"]["target_price"] == 102.0

    asyncio.run(scenario())


def test_worker_market_callback_enqueues_without_waiting_for_strategy():
    async def scenario():
        worker = SymbolWorker("user", "TESTUSDT", "1m", 2, .2, 1.0, PaperExecutionAdapter(), FakePaperStore(), BackendEventBus())
        entered = asyncio.Event()
        release = asyncio.Event()

        async def slow_evaluate(_bar):
            entered.set()
            await release.wait()

        worker._evaluate = slow_evaluate
        worker.ready.set()
        worker.task = asyncio.create_task(worker.run())
        event = {"type": "kline", "interval": "1m", "bar": bar(60, 100, 101, 99, 100)}
        started = asyncio.get_running_loop().time()
        worker.offer_market_event(event)
        assert asyncio.get_running_loop().time() - started < .05
        await asyncio.wait_for(entered.wait(), timeout=.5)
        assert worker.last_bar_time is None
        release.set()
        await asyncio.wait_for(worker.queue.join(), timeout=.5)
        assert worker.last_bar_time == 60
        worker.running = False
        worker.task.cancel()
        await asyncio.gather(worker.task, return_exceptions=True)

    asyncio.run(scenario())


def test_worker_deduplicates_queued_candle_timestamps():
    async def scenario():
        worker = SymbolWorker("user", "TESTUSDT", "1m", 2, .2, 1.0, PaperExecutionAdapter(), FakePaperStore(), BackendEventBus())
        event = {"type": "kline", "interval": "1m", "bar": bar(60, 100, 101, 99, 100)}
        worker.offer_market_event(event)
        worker.offer_market_event(event)
        assert worker.queue.qsize() == 1
        assert worker.events_received == 1
        assert worker.duplicate_events == 1

    asyncio.run(scenario())


def test_manager_starts_and_stops_supervised_paper_worker_and_releases_lease():
    async def scenario():
        gateway = FakeGateway()
        runtime = FakeRuntimeStore()
        manager = ProductionWorkerManager(gateway, FakePaperStore(), BackendEventBus(), object(), object(), runtime)
        status = await manager.start("user", "TESTUSDT", mode="paper")
        assert status["running"] is True
        assert len(gateway.listeners["TESTUSDT"]) == 1
        for _ in range(1000):
            status = manager.status("user", "TESTUSDT")
            if status["status"] == "RUNNING":
                break
            await asyncio.sleep(.005)
        assert status["status"] == "RUNNING"
        other_instance = ProductionWorkerManager(gateway, FakePaperStore(), BackendEventBus(), object(), object(), runtime)
        try:
            await other_instance.start("user", "TESTUSDT", mode="paper")
            raise AssertionError("a second manager must not claim an active worker lease")
        except ValueError as exc:
            assert "otra instancia" in str(exc)
        stopped = await manager.stop("user", "TESTUSDT")
        assert stopped["running"] is False
        assert gateway.listeners["TESTUSDT"] == set()
        assert ("user", "TESTUSDT") not in runtime.leases
        assert ("user", "TESTUSDT") not in runtime.configs

    asyncio.run(scenario())


def test_manager_switches_one_user_session_to_new_symbol_and_releases_old_listener():
    async def scenario():
        gateway = FakeGateway()
        gateway.bars["OTHERUSDT"] = {"1m": [bar(index * 60, 100, 100, 100, 100) for index in range(1500)]}
        manager = ProductionWorkerManager(gateway, FakePaperStore(), BackendEventBus(), object(), object(), FakeRuntimeStore())
        await manager.start("user", "TESTUSDT", mode="signals_only")
        old_worker = manager.workers[("user", "TESTUSDT")]
        await manager.start("user", "OTHERUSDT", mode="signals_only")
        assert list(manager.workers) == [("user", "OTHERUSDT")]
        assert old_worker.running is False
        assert gateway.listeners["TESTUSDT"] == set()
        assert len(gateway.listeners["OTHERUSDT"]) == 1
        await manager.stop("user", "OTHERUSDT")

    asyncio.run(scenario())


def test_open_execution_prevents_symbol_switch_and_stop_without_orphaning_it():
    async def scenario():
        manager = ProductionWorkerManager(FakeGateway(), FakePaperStore(), BackendEventBus(), object(), object())
        worker = SymbolWorker("user", "TESTUSDT", "1m", 5, .2, 1.0, PaperExecutionAdapter(), FakePaperStore(), BackendEventBus())
        worker.operation = {"id": "open", "side": "LONG", "entry_price": 100}
        manager.workers[("user", "TESTUSDT")] = worker
        with pytest.raises(ValueError, match="Cierra la operación abierta"):
            await manager.start("user", "OTHERUSDT", mode="signals_only")
        with pytest.raises(ValueError, match="operación abierta"):
            await manager.stop("user", "TESTUSDT")
        assert manager.workers[("user", "TESTUSDT")] is worker

    asyncio.run(scenario())


def test_signals_only_session_restores_open_paper_operation_for_supervision():
    async def scenario():
        store = FakePaperStore()
        store.rows["paper-1"] = {
            "id": "paper-1", "symbol": "TESTUSDT", "side": "long", "entry_price": 100,
            "stop_price": 99.8, "target_price": 101, "status": "OPEN", "source": "realtime-engine",
        }
        manager = ProductionWorkerManager(FakeGateway(), store, BackendEventBus(), object(), object())
        await manager.start("user", "TESTUSDT", mode="signals_only")
        worker = manager.workers[("user", "TESTUSDT")]
        assert worker.adapter.mode == "signals_only"
        assert worker.operation is None
        assert len(worker.background_operations) == 1
        assert worker.background_operations[0][1].mode == "paper"
        await manager._shutdown_worker(worker, status="PAUSED")

    asyncio.run(scenario())


def test_live_mode_fails_closed_when_deployment_gate_is_off():
    async def scenario():
        manager = ProductionWorkerManager(FakeGateway(), FakePaperStore(), BackendEventBus(), object(), object())
        worker = SymbolWorker("user", "TESTUSDT", "1m", 5, .2, 1, SignalOnlyExecutionAdapter(), FakePaperStore(), BackendEventBus())
        manager.workers[("user", "TESTUSDT")] = worker
        with pytest.raises(ValueError, match="bloqueada por configuración"):
            await manager.set_mode("user", "TESTUSDT", "live")
        assert worker.adapter.mode == "signals_only"

    asyncio.run(scenario())


def test_live_promotion_requires_ready_user_stream_and_keeps_paper_operation_independent(monkeypatch):
    async def scenario():
        class FakeBinanceManager:
            def __init__(self):
                self.listeners = set()

            def snapshot(self, user_id):
                return {"configured": True, "healthy": True, "stream_connected": True, "available_balance": 100, "positions": []}

            def set_symbol_margin_type(self, user_id, symbol, margin_type):
                return {"margin_type": "ISOLATED"}

            def set_symbol_leverage(self, user_id, symbol, leverage):
                return {"leverage": leverage}

            def subscribe_events(self, user_id, listener):
                self.listeners.add(listener)

            def unsubscribe_events(self, user_id, listener):
                self.listeners.discard(listener)

        monkeypatch.setattr(BinanceExecutionAdapter, "_rules", lambda self, symbol: (0, .001, .001, 5, .01, 8, 3))
        binance = FakeBinanceManager()
        manager = ProductionWorkerManager(FakeGateway(), FakePaperStore(), BackendEventBus(), binance, object(), live_enabled=True)
        worker = SymbolWorker("user", "TESTUSDT", "1m", 5, .2, 1, PaperExecutionAdapter(), FakePaperStore(), BackendEventBus())
        worker.event_loop = asyncio.get_running_loop()
        paper_operation = {"id": "paper-1", "side": "LONG", "entry_price": 100, "status": "OPEN"}
        worker.operation = paper_operation
        paper_adapter = worker.adapter
        worker.operation_adapter = paper_adapter
        manager.workers[("user", "TESTUSDT")] = worker

        result = await manager.set_mode("user", "TESTUSDT", "live")
        assert result["mode"] == "live"
        assert isinstance(worker.adapter, BinanceExecutionAdapter)
        assert worker.operation is None
        assert worker.background_operations == [(paper_operation, paper_adapter)]
        assert len(binance.listeners) == 1
        await manager._shutdown_worker(worker, status="PAUSED")
        assert binance.listeners == set()

    asyncio.run(scenario())


def test_live_adapter_sizes_from_risk_leverage_balance_and_exchange_step(monkeypatch):
    class FakeBinance:
        def snapshot(self, _user_id):
            return {"healthy": True, "stream_connected": True, "available_balance": 100}

    adapter = BinanceExecutionAdapter(FakeBinance(), object())
    monkeypatch.setattr(adapter, "_rules", lambda _symbol: (0, .1, .1, 5, .01, 8, 2))
    worker = SymbolWorker("user", "TESTUSDT", "1m", 5, .2, 1, adapter, FakePaperStore(), BackendEventBus())
    worker.adaptive_parameters = {"risk_percent": 1, "leverage": 10}
    assert adapter._sized_quantity(worker, 100) == 5


def test_live_user_stream_close_event_clears_matching_worker_operation():
    async def scenario():
        class FakeIntentStore:
            def reconcile_account_event(self, _user_id, _event):
                pass

            def get(self, _intent_id, _user_id):
                return {"id": "intent-1", "status": "CLOSED"}

        events = []

        class RecordingEvents:
            async def publish(self, event):
                events.append(event)

        manager = ProductionWorkerManager(FakeGateway(), FakePaperStore(), RecordingEvents(), object(), FakeIntentStore())
        live_adapter = BinanceExecutionAdapter(object(), FakeIntentStore())
        worker = SymbolWorker("user", "TESTUSDT", "1m", 5, .2, 1, live_adapter, FakePaperStore(), RecordingEvents())
        worker.operation = {"id": "intent-1", "side": "LONG"}
        worker.operation_adapter = live_adapter
        await manager._reconcile_live_event(worker, {"type": "ALGO_UPDATE", "event": {"e": "ALGO_UPDATE"}})
        assert worker.operation is None
        assert worker.operation_adapter is None
        assert events[-1]["type"] == "LIVE_EXIT"

    asyncio.run(scenario())


def test_worker_start_returns_while_cold_history_seeding_runs_in_background():
    class SlowPrimingGateway(FakeGateway):
        def __init__(self):
            self.bars = {"TESTUSDT": {"1m": []}}
            self.listeners = {}

        async def prime(self, symbol, interval, base_url):
            await asyncio.sleep(.2)
            self.bars[symbol][interval] = [bar(index * 60, 100, 100, 100, 100) for index in range(1500)]
            return self.snapshot(symbol, interval)

    async def scenario():
        gateway = SlowPrimingGateway()
        manager = ProductionWorkerManager(gateway, FakePaperStore(), BackendEventBus(), object(), object(), FakeRuntimeStore())
        started = asyncio.get_running_loop().time()
        status = await manager.start("user", "TESTUSDT", mode="paper")
        elapsed = asyncio.get_running_loop().time() - started
        assert elapsed < .1
        assert status["status"] == "STARTING"
        for _ in range(100):
            status = manager.status("user", "TESTUSDT")
            if status["status"] == "RUNNING":
                break
            await asyncio.sleep(.01)
        assert status["status"] == "RUNNING"
        assert status["bars"] == 480
        await manager.stop("user", "TESTUSDT")

    asyncio.run(scenario())


def test_stopping_during_history_seed_cancels_initialization_and_releases_worker():
    class SlowPrimingGateway(FakeGateway):
        def __init__(self):
            self.bars = {"TESTUSDT": {"1m": []}}
            self.listeners = {}

        async def prime(self, symbol, interval, base_url):
            await asyncio.sleep(1)
            return []

    async def scenario():
        gateway = SlowPrimingGateway()
        runtime = FakeRuntimeStore()
        manager = ProductionWorkerManager(gateway, FakePaperStore(), BackendEventBus(), object(), object(), runtime)
        await manager.start("user", "TESTUSDT", mode="paper")
        worker = manager.workers[("user", "TESTUSDT")]
        assert worker.initialization_task is not None and not worker.initialization_task.done()
        await manager.stop("user", "TESTUSDT")
        assert worker.initialization_task.cancelled()
        assert worker.task.cancelled()
        assert gateway.listeners["TESTUSDT"] == set()
        assert not runtime.leases

    asyncio.run(scenario())


def test_restart_restores_open_paper_operation_and_resumes_after_saved_cursor():
    async def scenario():
        gateway = FakeGateway()
        runtime = FakeRuntimeStore()
        paper_store = FakePaperStore()
        cursor = gateway.bars["TESTUSDT"]["1m"][-2]["time"]
        runtime.states[("user", "TESTUSDT")] = {"last_bar_time": cursor}
        paper_store.rows["engine-open-1"] = {
            "id": "engine-open-1", "symbol": "TESTUSDT", "side": "long",
            "entry_time": cursor, "entry_price": 100.0, "current_time": cursor,
            "current_price": 100.0, "stop_time": cursor, "stop_price": 99.8,
            "target_time": cursor, "target_price": 101.0, "status": "OPEN",
            "source": "realtime-engine", "notional": 500.0,
        }
        manager = ProductionWorkerManager(gateway, paper_store, BackendEventBus(), object(), object(), runtime)
        await manager.start("user", "TESTUSDT", mode="paper")
        worker = manager.workers[("user", "TESTUSDT")]
        for _ in range(100):
            if worker.events_processed:
                break
            await asyncio.sleep(.005)
        assert worker.last_bar_time == gateway.bars["TESTUSDT"]["1m"][-1]["time"]
        assert worker.operation["id"] == "engine-open-1"
        assert len(paper_store.rows) == 1
        await manager.shutdown()

        restarted = ProductionWorkerManager(gateway, paper_store, BackendEventBus(), object(), object(), runtime)
        await restarted.start("user", "TESTUSDT", mode="paper")
        restored = restarted.workers[("user", "TESTUSDT")]
        for _ in range(100):
            if restored.ready.is_set():
                break
            await asyncio.sleep(.005)
        assert restored.operation["id"] == "engine-open-1"
        assert restored.last_bar_time == gateway.bars["TESTUSDT"]["1m"][-1]["time"]
        assert restored.events_processed == 0
        assert len(paper_store.rows) == 1
        await restarted.shutdown()

    asyncio.run(scenario())


def test_worker_recovers_queue_overflow_from_shared_candle_snapshot():
    async def scenario():
        worker = SymbolWorker("user", "TESTUSDT", "1m", 5, .2, 1.0, PaperExecutionAdapter(), FakePaperStore(), BackendEventBus())
        worker.queue = asyncio.Queue(maxsize=1)
        worker.bars = [bar(index * 60, 100, 100, 100, 100) for index in range(1500)]
        worker.last_bar_time = worker.bars[-1]["time"]
        shared_bars = [bar((1500 + index) * 60, 100, 100, 100, 100) for index in range(5)]
        worker.history_provider = lambda: shared_bars
        processed = []

        async def slow_evaluate(candle):
            await asyncio.sleep(.01)
            processed.append(candle["time"])

        worker._evaluate = slow_evaluate
        worker.ready.set()
        worker.task = asyncio.create_task(worker.run())
        for candle in shared_bars:
            worker.offer_market_event({"type": "kline", "interval": "1m", "bar": candle})
        for _ in range(100):
            if worker.last_bar_time == shared_bars[-1]["time"] and worker.queue.empty():
                break
            await asyncio.sleep(.01)
        assert worker.last_bar_time == shared_bars[-1]["time"]
        assert processed == [candle["time"] for candle in shared_bars]
        assert worker.queue_overflows > 0
        worker.running = False
        worker.task.cancel()
        await asyncio.gather(worker.task, return_exceptions=True)

    asyncio.run(scenario())
