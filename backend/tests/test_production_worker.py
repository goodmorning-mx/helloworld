import asyncio

from app.production_worker import PaperExecutionAdapter, SymbolWorker
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
        # A new signal while the operation is open must not create a second one.
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": bar(4, 101, 102, 100, 99)})
        assert worker.operation is None or worker.operation["id"] != opened_id
        assert len(store.rows) == 2
        assert store.rows[opened_id]["status"] == "CLOSED - FAILED"

    asyncio.run(scenario())
