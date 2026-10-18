import asyncio

from app.production_worker import PaperExecutionAdapter, ProductionWorkerManager, SymbolWorker
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
