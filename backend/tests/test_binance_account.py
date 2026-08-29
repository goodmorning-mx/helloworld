import hashlib
import hmac
from urllib.parse import parse_qs, urlparse
from urllib.error import HTTPError

from app.binance_account import BinanceAccountMonitor
from app.config import Settings


def monitor() -> BinanceAccountMonitor:
    return BinanceAccountMonitor(Settings(
        APIKEY="key", APISECRET="secret", BINANCE_BASE_URL="https://fapi.example.test",
    ))


def test_signed_binance_request_has_valid_signature(monkeypatch):
    instance = monitor()
    captured = {}

    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self): return b"{}"

    def fake_urlopen(request, timeout):
        captured["request"] = request
        return Response()

    monkeypatch.setattr("app.binance_account.urlopen", fake_urlopen)
    instance._request("GET", "/fapi/v2/account", {"foo": "bar"}, signed=True)
    query = parse_qs(urlparse(captured["request"].full_url).query)
    unsigned = "&".join(f"{key}={query[key][0]}" for key in ("foo", "timestamp", "recvWindow"))
    expected = hmac.new(b"secret", unsigned.encode(), hashlib.sha256).hexdigest()
    assert query["signature"][0] == expected


def test_account_update_exposes_balance_position_and_order_event():
    instance = monitor()
    instance._handle_event({
        "e": "ACCOUNT_UPDATE",
        "a": {"B": [{"a": "USDT", "wb": "100", "cw": "90"}],
              "P": [{"s": "BTCUSDT", "ps": "LONG", "pa": "0.01", "ep": "60000", "up": "2"}]},
    })
    instance._handle_event({"e": "ORDER_TRADE_UPDATE", "o": {"s": "BTCUSDT", "S": "BUY", "X": "FILLED"}})
    snapshot = instance.snapshot()
    assert snapshot["wallet_balance"] == "100"
    assert snapshot["positions"][0]["symbol"] == "BTCUSDT"
    assert snapshot["events"][0]["status"] == "FILLED"


def test_max_leverages_reads_first_bracket_per_symbol(monkeypatch):
    instance = monitor()
    monkeypatch.setattr(instance, "_signed_get", lambda path: [
        {"symbol": "BTCUSDT", "brackets": [{"initialLeverage": 125}, {"initialLeverage": 50}]},
        {"symbol": "XRPUSDT", "brackets": [{"initialLeverage": 75}]},
    ])
    assert instance.max_leverages() == {"BTCUSDT": 125, "XRPUSDT": 75}


def test_invalid_api_key_or_ip_gets_actionable_message():
    instance = monitor()
    response = HTTPError("https://fapi.example.test/fapi/v2/account", 401, "Unauthorized", {}, None)
    response.read = lambda: b'{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action"}'
    kind, title, message, action = instance._friendly_error(response)
    assert kind == "BINANCE_AUTH_OR_IP"
    assert "IP" in title
    assert "whitelist" in action
    assert "API key" in message
