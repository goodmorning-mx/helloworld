import asyncio

from app.telegram_service import TelegramCommandService


class FakeSink:
    def __init__(self):
        self.messages = []

    async def send(self, message):
        self.messages.append(message)


class FakeControl:
    def __init__(self):
        self.started = []
        self.stopped = []
        self.scanned = []
        self.modes = []

    def status(self, user_id):
        return {"workers": [], "text": "🟢 Workers Paper\nNo hay workers activos."}

    async def scan(self, user_id, limit):
        self.scanned.append((user_id, limit))
        return {"text": "📊 scanner listo"}

    async def start(self, user_id, symbol):
        self.started.append((user_id, symbol))
        return {"symbol": symbol, "status": "RUNNING"}

    async def set_mode(self, user_id, mode, symbol=None):
        self.modes.append((user_id, mode, symbol))
        if mode == "live":
            raise ValueError("Producción Binance está bloqueada.")
        return {"symbol": symbol or "BTCUSDT", "mode": mode}

    async def stop(self, user_id, symbol):
        self.stopped.append((user_id, symbol))
        return {"symbol": symbol}


def test_telegram_commands_are_private_allowlisted_and_select_future_execution_mode():
    async def scenario():
        sink = FakeSink()
        control = FakeControl()
        service = TelegramCommandService("token", "12345", "user-1", control, sink, sender_id="56789")

        await service._handle_update({"update_id": 1, "message": {"chat": {"id": 999, "type": "private"}, "from": {"id": 999}, "text": "start BTCUSDT"}})
        await service._handle_update({"update_id": 2, "message": {"chat": {"id": 12345, "type": "group"}, "from": {"id": 12345}, "text": "start BTCUSDT"}})
        assert control.started == []

        await service._handle_update({"update_id": 3, "message": {"chat": {"id": 12345, "type": "group"}, "from": {"id": 56789}, "text": "/start BTCUSDT"}})
        assert control.started == [("user-1", "BTCUSDT")]
        assert "Tracker activo" in sink.messages[-1]

        await service._handle_update({"update_id": 4, "message": {"chat": {"id": 12345, "type": "group"}, "from": {"id": 56789}, "text": "stop BTCUSDT"}})
        assert control.stopped == [("user-1", "BTCUSDT")]

        await service._handle_update({"update_id": 5, "message": {"chat": {"id": 12345, "type": "group"}, "from": {"id": 56789}, "text": "/scan"}})
        assert control.scanned == [("user-1", 20)]
        assert sink.messages[-1] == "📊 scanner listo"

        await service._handle_update({"update_id": 6, "message": {"chat": {"id": 12345, "type": "group"}, "from": {"id": 56789}, "text": "status"}})
        assert "No hay workers activos" in sink.messages[-1]

        await service._handle_update({"update_id": 6, "message": {"chat": {"id": 12345, "type": "group"}, "from": {"id": 56789}, "text": "status"}})
        await service._handle_update({"update_id": 7, "message": {"chat": {"id": 12345, "type": "group"}, "from": {"id": 56789}, "text": "/help"}})
        assert "/scan" in sink.messages[-1]
        assert "/start BTCUSDT" in sink.messages[-1]
        assert "/stop" in sink.messages[-1]
        assert "/paper" in sink.messages[-1]
        assert "/production" in sink.messages[-1]
        assert "/status" in sink.messages[-1]
        assert "Paper" in sink.messages[-1]
        assert service.commands_processed == 5

        await service._handle_update({"update_id": 8, "message": {"chat": {"id": 12345, "type": "group"}, "from": {"id": 56789}, "text": "/paper"}})
        assert control.modes[-1] == ("user-1", "paper", None)
        assert "señales nuevas" in sink.messages[-1]

        await service._handle_update({"update_id": 9, "message": {"chat": {"id": 12345, "type": "group"}, "from": {"id": 56789}, "text": "/production"}})
        assert "bloqueada" in sink.messages[-1]

    asyncio.run(scenario())


def test_telegram_command_menu_includes_help():
    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {"ok": True}

    class MenuClient:
        def __init__(self):
            self.payload = None
            self.posted = asyncio.Event()

        async def post(self, url, *, json):
            self.payload = json
            self.posted.set()
            return Response()

        async def get(self, url, *, params):
            await asyncio.Event().wait()

    async def scenario():
        client = MenuClient()
        service = TelegramCommandService("token", "12345", "user-1", FakeControl(), FakeSink(), sender_id="56789")
        service._client = client
        task = asyncio.create_task(service._run())
        await client.posted.wait()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        commands = [item["command"] for item in client.payload["commands"]]
        assert commands == ["scan", "start", "paper", "production", "stop", "status", "help"]

    asyncio.run(scenario())


def test_telegram_commands_ignore_non_command_messages_and_invalid_symbols():
    async def scenario():
        sink = FakeSink()
        control = FakeControl()
        service = TelegramCommandService("token", "12345", "user-1", control, sink, sender_id="56789")
        message = {"chat": {"id": 12345, "type": "group"}, "from": {"id": 56789}}
        await service._handle_update({"update_id": 1, "message": {**message, "text": "hola"}})
        assert sink.messages == []
        await service._handle_update({"update_id": 2, "message": {**message, "text": "start"}})
        assert sink.messages[-1] == "Uso: start BTCUSDT"
        assert control.started == []

    asyncio.run(scenario())
