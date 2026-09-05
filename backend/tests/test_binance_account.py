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


def test_close_protection_uses_current_algo_order_contract(monkeypatch):
    instance = monitor()
    captured = {}

    def fake_request(method, path, params=None, signed=False):
        captured.update({"method": method, "path": path, "params": params, "signed": signed})
        return {"algoId": 123, "clientAlgoId": "helloworld_sl"}

    monkeypatch.setattr(instance, "_request", fake_request)
    response = instance.place_close_protection("BULLAUSDT", "SELL", 0.0735, "helloworld_sl", "STOP_MARKET")
    assert response["algoId"] == 123
    assert captured["path"] == "/fapi/v1/algoOrder"
    assert captured["params"]["algoType"] == "CONDITIONAL"
    assert captured["params"]["triggerPrice"] == "0.0735"
    assert captured["params"]["clientAlgoId"] == "helloworld_sl"
    assert "stopPrice" not in captured["params"]


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


def test_position_risk_projection_preserves_binance_risk_fields():
    projected = monitor()._position({
        "symbol": "BULLAUSDT", "positionAmt": "5", "entryPrice": "0.0743230",
        "markPrice": "0.0726349", "unRealizedProfit": "-0.11",
        "notional": "5.05", "isolatedMargin": "5.05", "isolatedWallet": "4.9403",
        "leverage": "1", "marginType": "isolated", "positionSide": "BOTH",
    })
    assert projected["symbol"] == "BULLAUSDT"
    assert projected["notional"] == "5.05"
    assert projected["isolated_margin"] == "5.05"
    assert projected["isolated_wallet"] == "4.9403"


def test_max_leverages_reads_first_bracket_per_symbol(monkeypatch):
    instance = monitor()
    monkeypatch.setattr(instance, "_signed_get", lambda path: [
        {"symbol": "BTCUSDT", "brackets": [{"initialLeverage": 125}, {"initialLeverage": 50}]},
        {"symbol": "XRPUSDT", "brackets": [{"initialLeverage": 75}]},
    ])
    assert instance.max_leverages() == {"BTCUSDT": 125, "XRPUSDT": 75}


def test_symbol_config_reads_account_specific_margin_and_leverage(monkeypatch):
    instance = monitor()
    monkeypatch.setattr(instance, "_request", lambda method, path, params=None, signed=False: [
        {"symbol": "BTCUSDT", "marginType": "isolated", "leverage": 20},
    ])
    assert instance.symbol_config("btcusdt") == {
        "symbol": "BTCUSDT", "margin_type": "ISOLATED", "leverage": 20, "isolated_balance": 0.0,
    }


def test_invalid_api_key_or_ip_gets_actionable_message():
    instance = monitor()
    response = HTTPError("https://fapi.example.test/fapi/v2/account", 401, "Unauthorized", {}, None)
    response.read = lambda: b'{"code":-2015,"msg":"Invalid API-key, IP, or permissions for action"}'
    kind, title, message, action = instance._friendly_error(response)
    assert kind == "BINANCE_AUTH_OR_IP"
    assert "IP" in title
    assert "whitelist" in action
    assert "API key" in message
