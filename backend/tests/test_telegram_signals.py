import asyncio
from collections import deque
from types import SimpleNamespace

from app.production_worker import PaperExecutionAdapter
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


def test_tracker_signal_is_formatted_once_and_entry_event_is_not_duplicated():
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
        assert telegram.messages[0] == "Señal Tracker PAPER: LONG BTCUSDT · H2 · precio 65000.5 · marco 1m · 1970-01-01 00:02 UTC · SL -0.2% · TP +1.0%"

    asyncio.run(run())


def test_paper_worker_publishes_a_structured_tracker_signal(monkeypatch):
    async def run():
        published = []

        class Events:
            async def publish(self, event):
                published.append(event)

        monkeypatch.setattr("app.production_worker._persist_open", lambda worker, operation: operation)
        worker = SimpleNamespace(
            symbol="BTCUSDT", interval="1m", stop_percent=0.2, target_percent=1.0,
            user_id="user-1", operation=None, events=Events(), paper_store=object(),
        )
        adapter = PaperExecutionAdapter()
        await adapter.open(worker, "LONG", 65000.5, {"time": 123, "level": "H2"})

        signal = next(event for event in published if event["type"] == "TRACKER_SIGNAL")
        assert signal == {
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
