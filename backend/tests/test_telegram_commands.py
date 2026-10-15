import asyncio

from app.telegram_service import TelegramCommandService


class FakeSink:
    def __init__(self):
        self.messages = []

    async def send(self, message):
        self.messages.append(message)


class FakeWorkers:
    def __init__(self):
        self.started = []
        self.stopped = []

    def list(self, user_id):
        return []

    async def start(self, user_id, symbol, **kwargs):
        self.started.append((user_id, symbol, kwargs))
        return {"symbol": symbol, "status": "RUNNING"}

    async def stop(self, user_id, symbol):
        self.stopped.append((user_id, symbol))
        return {"symbol": symbol}


def test_telegram_paper_commands_are_chat_allowlisted_and_never_select_live():
    async def scenario():
        sink = FakeSink()
        workers = FakeWorkers()
        service = TelegramCommandService("token", "12345", "user-1", workers, sink)

        await service._handle_update({"update_id": 1, "message": {"chat": {"id": 999}, "text": "/startpaper BTCUSDT"}})
        assert workers.started == []

        await service._handle_update({"update_id": 2, "message": {"chat": {"id": 12345}, "text": "/startpaper BTCUSDT"}})
        assert workers.started == [("user-1", "BTCUSDT", {"mode": "paper"})]
        assert "Paper realtime iniciado" in sink.messages[-1]

        await service._handle_update({"update_id": 3, "message": {"chat": {"id": 12345}, "text": "/stoppaper BTCUSDT"}})
        assert workers.stopped == [("user-1", "BTCUSDT")]

    asyncio.run(scenario())
