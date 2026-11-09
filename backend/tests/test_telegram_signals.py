import asyncio
from collections import deque
from app.production_worker import PaperExecutionAdapter, SymbolWorker
from app.telegram_service import TelegramSink, telegram_event_sink


class RecordingTelegram:
    def __init__(self):
        self._seen_signals = set()
        self._seen_signal_order = deque()
        self.messages = []

    async def send(self, message):
        self.messages.append(message)
        return True

    async def send_once(self, key, message):
        if key in self._seen_signals:
            return False
        self._seen_signals.add(key)
        self._seen_signal_order.append(key)
        self.messages.append(message)
        return True


def test_tracker_signal_is_formatted_once_and_execution_entry_is_not_duplicated():
    async def run():
        telegram = RecordingTelegram()
        sink = telegram_event_sink(telegram)
        event = {
            "type": "TRACKER_SIGNAL",
            "signal_id": "BTCUSDT:1m:123:LONG:H2",
            "symbol": "BTCUSDT",
            "side": "LONG",
            "level": "H2",
            "interval": "1m",
            "bar_time": 123,
            "price": 65000.5,
            "stop_percent": 0.2,
            "target_percent": 1.0,
            "mode": "paper",
        }

        await sink({"type": "PAPER_ENTRY", "symbol": "BTCUSDT", "side": "LONG", "price": 65000.5})
        await sink(event)
        await sink(event)

        assert len(telegram.messages) == 1
        assert telegram.messages[0] == "LONG ABIERTO · BTCUSDT"

    asyncio.run(run())


def test_paper_worker_publishes_a_structured_tracker_signal(monkeypatch):
    async def run():
        published = []

        class Events:
            async def publish(self, event):
                published.append(event)

        monkeypatch.setattr("app.production_worker._persist_open", lambda worker, operation: operation)
        class Store:
            def create(self, user_id, values):
                return values

        worker = SymbolWorker("user-1", "BTCUSDT", "1m", 2, 0.2, 1.0, PaperExecutionAdapter(), Store(), Events())
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": {"time": 60, "open": 100, "high": 100, "low": 100, "close": 100, "closed": True}})
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": {"time": 120, "open": 100, "high": 100, "low": 100, "close": 100, "closed": True}})
        await worker.on_market_event({"type": "kline", "interval": "1m", "bar": {"time": 180, "open": 100, "high": 101, "low": 99, "close": 101, "closed": True}})

        signal = next(event for event in published if event["type"] == "TRACKER_SIGNAL")
        assert signal == {
            "user_id": "user-1",
            "type": "TRACKER_SIGNAL",
            "signal_id": "BTCUSDT:1m:180:SHORT:H2",
            "symbol": "BTCUSDT",
            "side": "SHORT",
            "level": "H2",
            "interval": "1m",
            "bar_time": 180,
            "price": 101.0,
            "stop_percent": 0.2,
            "target_percent": 1.0,
            "tracker_period": 2,
            "parameter_version": 0,
            "mode": "paper",
        }

    asyncio.run(run())


def test_worker_event_subscribers_only_receive_events_for_their_owner():
    async def run():
        from app.telegram_service import BackendEventBus

        bus = BackendEventBus()
        owner_queue = bus.subscribe("owner-1")
        other_queue = bus.subscribe("owner-2")
        await bus.publish({"user_id": "owner-1", "type": "TRACKER_SIGNAL", "symbol": "BTCUSDT"})
        assert (await owner_queue.get())["symbol"] == "BTCUSDT"
        assert other_queue.empty()
        bus.unsubscribe("owner-1", owner_queue)
        bus.unsubscribe("owner-2", other_queue)
        assert not bus._subscribers

    asyncio.run(run())


def test_telegram_sink_deduplicates_signal_only_after_queue_accepts(monkeypatch):
    async def run():
        sink = TelegramSink("token", "chat")
        sent = []

        async def record(message):
            sent.append(message)
            return True

        monkeypatch.setattr(sink, "send", record)
        assert await sink.send_once("signal-1", "message") is True
        assert await sink.send_once("signal-1", "message") is False
        assert sent == ["message"]

    asyncio.run(run())


def test_worker_notifications_are_short_and_open_update_is_sent_only_once():
    async def run():
        telegram = RecordingTelegram()
        sink = telegram_event_sink(telegram)
        await sink({"type": "WORKER_STARTED", "symbol": "BTCUSDT", "mode": "paper"})
        opened = {"entry_time": 123, "side": "LONG", "unrealized_pnl": 2.5, "unrealized_roe_percent": 1.25}
        update = {"type": "WORKER_MARK_UPDATE", "symbol": "BTCUSDT", "tracker_operation": opened}
        await sink(update)
        await sink(update)
        await sink({"type": "TRACKER_PARAMETERS_UPDATED", "symbol": "BTCUSDT", "target_percent": 2})
        close_win = {"type": "TRACKER_OPERATION_CLOSED", "symbol": "BTCUSDT", "side": "LONG", "reason": "TP", "entry_time": 123, "result_roe_percent": 1.5, "pnl_usd": 3.0}
        await sink(close_win)
        await sink(close_win)
        await sink({"type": "TRACKER_OPERATION_CLOSED", "symbol": "ETHUSDT", "side": "SHORT", "reason": "SL", "entry_time": 456, "result_roe_percent": -2.5, "pnl_usd": -5.0})
        assert telegram.messages == [
            "WORKER INICIADO · BTCUSDT · PAPER",
            "UPDATE LONG BTCUSDT · WIN +1.25% · +2.50 USD",
            "WIN · LONG BTCUSDT · +1.50% · +3.00 USD",
            "FAIL · SHORT ETHUSDT · -2.50% · -5.00 USD",
        ]

    asyncio.run(run())


def test_worker_errors_are_forwarded_to_telegram_once_but_normal_logs_are_not():
    async def run():
        telegram = RecordingTelegram()
        sink = telegram_event_sink(telegram)
        await sink({
            "type": "WORKER_LOG", "symbol": "BTCUSDT",
            "log": {"id": "info-1", "level": "INFO", "event": "WORKER_READY", "message": "ready"},
        })
        await sink({
            "type": "WORKER_LOG", "symbol": "BTCUSDT",
            "log": {"id": "error-1", "level": "ERROR", "event": "CANDLE_PROCESSING_FAILED", "message": "ValueError: candle inválida"},
        })
        await sink({
            "type": "WORKER_LOG", "symbol": "BTCUSDT",
            "log": {"id": "error-1", "level": "ERROR", "event": "CANDLE_PROCESSING_FAILED", "message": "ValueError: candle inválida"},
        })

        assert telegram.messages == [
            "⚠️ ERROR WORKER · BTCUSDT\nCANDLE_PROCESSING_FAILED · ValueError: candle inválida",
        ]

    asyncio.run(run())


def test_worker_errors_reach_telegram_even_when_tracker_signals_are_disabled():
    async def run():
        telegram = RecordingTelegram()
        sink = telegram_event_sink(telegram, tracker_notifications_enabled=False)
        await sink({"type": "TRACKER_SIGNAL", "symbol": "BTCUSDT", "side": "LONG"})
        await sink({
            "type": "WORKER_LOG", "symbol": "BTCUSDT",
            "log": {"id": "error-2", "level": "ERROR", "event": "INITIALIZATION_FAILED", "message": "No se pudo inicializar."},
        })

        assert telegram.messages == ["⚠️ ERROR WORKER · BTCUSDT\nINITIALIZATION_FAILED · No se pudo inicializar."]

    asyncio.run(run())
