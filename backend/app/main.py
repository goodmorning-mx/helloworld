from __future__ import annotations

from dataclasses import dataclass
import asyncio
import logging
import math
import json
import time
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR
from uuid import uuid4
from urllib.parse import urlencode
from zoneinfo import ZoneInfoNotFoundError

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Literal
from threading import Lock
import httpx
from openai import AsyncOpenAI
from urllib.error import HTTPError

from gm_agent import AgentService, Conversation, OpenAIProvider
from gm_agent.providers import ChatProvider, ProviderResponse
from gm_auth import AuthService, AuthSettings, create_auth_router, identity_dependency
from gm_auth.models import AuthIdentity
from gm_mcp import Permission, RequestContext, ToolRegistry, tool

from app.config import get_settings
from app.database import create_database_engine
from app.binance_credentials import BinanceCredentialStore, BinanceMonitorManager
from app.binance_account import BinanceAccountMonitor
from app.ctrader_credentials import CTraderCredentialStore
from app.ctrader_runtime import CTraderManager
from app.paper_operations import PaperOperationStore
from app.market_gateway import BinanceMarketGateway, SUPPORTED_INTERVALS
from app.binance_execution import BinanceExecutionStore, BinanceExecutionSupervisor
from app.binance_tp_worker import BinanceTakeProfitWorker
from app.backtest_engine import MAX_BACKTEST_DAYS, fetch_binance_history, run_storycard_backtest, _bar_context
from app.production_worker import ProductionWorkerConfigStore, ProductionWorkerManager
from app.telegram_service import BackendEventBus, TelegramSink, telegram_event_sink
from app.scanner_analysis import ScannerAnalysisConfig, activity_state, analyze_tracker
from app.profiling import Profiling

settings = get_settings()
logger = logging.getLogger(__name__)
engine = create_database_engine()
auth_service = AuthService(
    engine,
    AuthSettings(jwt_secret=settings.jwt_secret, issuer="helloworld"),
)
tool_registry = ToolRegistry()
conversations: dict[str, Conversation] = {}
paper_orders: list[dict[str, object]] = []
binance_credentials = BinanceCredentialStore(engine, settings)
binance_manager = BinanceMonitorManager(binance_credentials, settings)
ctrader_credentials = CTraderCredentialStore(engine, settings)
ctrader_manager = CTraderManager(settings, ctrader_credentials)
paper_operation_store = PaperOperationStore(engine)
binance_market_gateway = BinanceMarketGateway()
binance_execution_store = BinanceExecutionStore(engine)
binance_execution_supervisor = BinanceExecutionSupervisor(settings, binance_credentials, binance_manager, binance_execution_store)
binance_tp_worker = BinanceTakeProfitWorker(binance_manager, binance_execution_store, settings.binance_base_url)
telegram_sink = TelegramSink(settings.telegram_bot_token, settings.telegram_chat_id, settings.telegram_min_delay)
backend_events = BackendEventBus()
backend_events.add_sink(telegram_event_sink(telegram_sink))
production_worker_config_store = ProductionWorkerConfigStore(engine)
production_workers = ProductionWorkerManager(binance_market_gateway, paper_operation_store, backend_events, binance_manager, binance_execution_store, production_worker_config_store)
_binance_exchange_info_cache: tuple[float, dict[str, object]] | None = None
_binance_exchange_info_lock = Lock()
_scanner_analysis_cache: dict[str, tuple[float, dict[str, object]]] = {}
_scanner_analysis_states: dict[str, str] = {}
_scanner_analysis_lock = asyncio.Lock()


class FallbackProvider:
    name = "helloworld-demo"

    async def complete(self, *, model: str, messages: list[dict], tools: list[dict]) -> ProviderResponse:
        prompt = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        return ProviderResponse(
            content=(
                "Estoy en modo demo porque OPENAI_API_KEY aún no está configurada. "
                f"Recibí: {prompt}. Puedo preparar un backtest o una orden paper cuando el agente esté conectado."
            ),
            tool_calls=[],
        )


async def _backtest(*, context: RequestContext, symbol: str, strategy: str = "", storycard: dict[str, object] | None = None, interval: str = "5m", days: int = MAX_BACKTEST_DAYS) -> dict[str, object]:
    del context
    card = storycard if isinstance(storycard, dict) else {"events": []}
    bars = await fetch_binance_history(symbol=symbol, interval=interval, days=days, base_url=settings.binance_base_url)
    result = run_storycard_backtest(bars=bars, symbol=symbol, storycard={**card, "strategy": strategy}, timezone_name=str(card.get("timezone", "America/Mexico_City")))
    result["strategy"] = strategy
    return result


async def _backtest_context(*, context: RequestContext, symbol: str, interval: str = "5m", days: int = MAX_BACKTEST_DAYS, offset: int = 0, limit: int = 500) -> dict[str, object]:
    del context
    bars = await fetch_binance_history(symbol=symbol, interval=interval, days=days, base_url=settings.binance_base_url)
    offset = max(0, int(offset))
    limit = max(1, min(int(limit), 1000))
    selected = bars[offset : offset + limit]
    return {"symbol": symbol.upper(), "interval": interval, "days": MAX_BACKTEST_DAYS, "offset": offset, "limit": limit, "total_bars": len(bars), "bars": [_bar_context(bars, offset + index, 9) for index in range(len(selected))]}


def _open_order(*, context: RequestContext, symbol: str, side: str, quantity: float) -> dict[str, object]:
    order = {
        "id": f"paper-{uuid4().hex[:10]}",
        "symbol": symbol.upper(),
        "side": side.upper(),
        "quantity": quantity,
        "status": "paper_filled",
        "user_id": context.user_id,
    }
    paper_orders.append(order)
    return order


tool_registry.register(tool(
    name="trading.backtest",
    description="Run a paper backtest for a named trading strategy.",
    input_schema={"type": "object", "properties": {"symbol": {"type": "string"}, "strategy": {"type": "string"}, "interval": {"type": "string", "enum": ["1m", "5m", "15m"]}, "days": {"type": "integer", "maximum": 7}, "storycard": {"type": "object", "description": "Storycard with timezone and events. Events use weekday/time/action=open_long|open_short|close_all|observe and optional sl_percent, tp_percent, risk_usdt, notional and leverage."}}, "required": ["symbol", "storycard"]},
    permission=Permission.READ,
    permissions={"read"},
)(_backtest))
tool_registry.register(tool(
    name="trading.backtest_context",
    description="Read paginated historical candles and SSL context used by the seven-day backtest.",
    input_schema={"type": "object", "properties": {"symbol": {"type": "string"}, "interval": {"type": "string", "enum": ["1m", "5m", "15m"]}, "days": {"type": "integer", "maximum": 7}, "offset": {"type": "integer"}, "limit": {"type": "integer", "maximum": 1000}}, "required": ["symbol"]},
    permission=Permission.READ,
    permissions={"read"},
)(_backtest_context))
tool_registry.register(tool(
    name="trading.open_order",
    description="Open a paper order after explicit user confirmation.",
    input_schema={"type": "object", "properties": {"symbol": {"type": "string"}, "side": {"type": "string", "enum": ["BUY", "SELL"]}, "quantity": {"type": "number"}}, "required": ["symbol", "side", "quantity"]},
    permission=Permission.WRITE,
    permissions={"write"},
    write=True,
    requires_confirmation=True,
)(_open_order))


def build_agent() -> AgentService:
    provider: ChatProvider
    if settings.openai_api_key:
        provider = OpenAIProvider(AsyncOpenAI(api_key=settings.openai_api_key))
    else:
        provider = FallbackProvider()
    return AgentService(provider, tool_registry)


agent_service = build_agent()

app = FastAPI(title=settings.app_name)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)
app.include_router(create_auth_router(auth_service))


class RegisterInput(BaseModel):
    email: str
    name: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=8)


class ChatInput(BaseModel):
    prompt: str = ""
    conversation_id: str | None = None
    confirm: bool = False


class BacktestEventInput(BaseModel):
    id: str | None = None
    action: Literal["open_long", "open_short", "close", "close_all", "close_position", "observe"] = "observe"
    weekday: str | int | None = None
    time: str | None = None
    timestamp: str | None = None
    sl_percent: float = Field(default=0.2, gt=0, le=100)
    tp_percent: float = Field(default=1.0, gt=0, le=1_000)
    risk_usdt: float = Field(default=1.0, gt=0)
    notional: float | None = Field(default=None, gt=0)
    leverage: float = Field(default=1.0, gt=0)


class BacktestStorycardInput(BaseModel):
    timezone: str = "America/Mexico_City"
    events: list[BacktestEventInput] = Field(default_factory=list, max_length=100)


class BacktestInput(BaseModel):
    symbol: str = Field(min_length=3, max_length=32)
    interval: Literal["1m", "5m", "15m"] = "5m"
    days: int = Field(default=7, ge=1, le=7)
    strategy: str = Field(default="storycard", max_length=200)
    storycard: BacktestStorycardInput


class BinanceCredentialsInput(BaseModel):
    api_key: str = Field(min_length=10, max_length=256)
    api_secret: str = Field(min_length=10, max_length=256)


class CTraderCredentialsInput(BaseModel):
    access_token: str = Field(min_length=10, max_length=4096)
    refresh_token: str = Field(min_length=10, max_length=4096)
    account_id: int = Field(default=0, ge=0)


class CTraderOAuthCodeInput(BaseModel):
    code: str = Field(min_length=10, max_length=4096)


class CTraderOrderInput(BaseModel):
    symbol: str = Field(min_length=3, max_length=32)
    side: Literal["BUY", "SELL"]
    volume: int = Field(gt=0, le=2_000_000_000)
    stop_loss: float | None = Field(default=None, gt=0)
    take_profit: float | None = Field(default=None, gt=0)
    comment: str = Field(default="helloworld", max_length=50)
    confirmed: bool = False


class CTraderCloseInput(BaseModel):
    position_id: int = Field(gt=0)
    volume: int = Field(gt=0, le=2_000_000_000)
    confirmed: bool = False


class CTraderAmendInput(BaseModel):
    position_id: int = Field(gt=0)
    stop_loss: float | None = Field(default=None, gt=0)
    take_profit: float | None = Field(default=None, gt=0)
    confirmed: bool = False


class PaperOperationInput(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    side: Literal["long", "short"]
    chart: Literal["entry", "context"]
    entry_time: int
    entry_price: float
    current_time: int
    current_price: float
    stop_time: int
    stop_price: float
    target_time: int
    target_price: float
    risk_percent: float | None = None
    notional: float | None = None
    margin: float | None = None
    pnl: float | None = None
    status: Literal["OPEN", "CLOSED - WIN", "CLOSED - FAILED"] = "OPEN"
    close_reason: Literal["TP", "SL", "MANUAL"] | None = None


class BinanceMarginTypeInput(BaseModel):
    margin_type: Literal["ISOLATED", "CROSSED"] = "ISOLATED"


class BinanceLeverageInput(BaseModel):
    leverage: int = Field(ge=1, le=125)


class BinanceRealOrderInput(BaseModel):
    symbol: str = Field(min_length=3, max_length=32)
    side: Literal["LONG", "SHORT"]
    quantity: float = Field(gt=0)
    stop_loss: float = Field(gt=0)
    take_profit: float = Field(gt=0)
    leverage: int = Field(default=1, ge=1, le=125)
    stop_percent: float = Field(default=1, gt=0, le=100)
    target_percent: float = Field(default=1, gt=0, le=100)
    confirmed: bool = False


class BinanceCloseOrderInput(BaseModel):
    confirmed: bool = False


class BinanceTakeProfitUpdateInput(BaseModel):
    take_profit: float = Field(gt=0)
    confirmed: bool = False


class ProductionWorkerInput(BaseModel):
    symbol: str = Field(min_length=3, max_length=32)
    mode: Literal["paper", "live"] = "paper"
    interval: Literal["1m", "3m", "5m", "15m"] = "1m"
    tracker_period: int = Field(default=5, ge=1, le=300)
    stop_percent: float = Field(default=0.2, gt=0, le=100)
    target_percent: float = Field(default=1.0, gt=0, le=1_000)
    quantity: float = Field(default=0, ge=0)
    confirmed: bool = False


def _binance_public_execution_rules(symbol: str) -> tuple[float, float, float, float, int, int]:
    """Return live price and the current public exchange filters for a symbol."""
    base = settings.binance_base_url.rstrip("/")
    global _binance_exchange_info_cache
    now = time.monotonic()
    with _binance_exchange_info_lock:
        cached = _binance_exchange_info_cache
    if cached is None or now - cached[0] > 300:
        exchange = httpx.get(f"{base}/fapi/v1/exchangeInfo", timeout=10)
        exchange.raise_for_status()
        payload = exchange.json()
        with _binance_exchange_info_lock:
            _binance_exchange_info_cache = (now, payload)
    else:
        payload = cached[1]
    item = next((value for value in payload.get("symbols", []) if value.get("symbol") == symbol), None)
    if not item:
        raise RuntimeError(f"Binance no encontró el símbolo {symbol}.")
    filters = {str(value.get("filterType")): value for value in item.get("filters", [])}
    price_filter = filters.get("PRICE_FILTER", {})
    lot = filters.get("LOT_SIZE", {})
    notional = filters.get("NOTIONAL") or filters.get("MIN_NOTIONAL") or {}
    ticker = httpx.get(f"{base}/fapi/v1/ticker/price", params={"symbol": symbol}, timeout=10)
    ticker.raise_for_status()
    return (float(ticker.json().get("price", 0)), float(lot.get("stepSize", 0) or 0),
            float(price_filter.get("tickSize", 0) or 0), float(notional.get("notional", 0) or 0),
            int(item.get("pricePrecision", 8)), int(item.get("quantityPrecision", 8)))


def _binance_public_mark_price(symbol: str) -> float:
    """Read Binance's current Futures mark price before placing a trigger."""
    base = settings.binance_base_url.rstrip("/")
    response = httpx.get(f"{base}/fapi/v1/premiumIndex", params={"symbol": symbol}, timeout=5)
    response.raise_for_status()
    return float(response.json().get("markPrice", 0) or 0)


def _align_binance_value(value: float, step: float, precision: int, *, ceiling: bool) -> float:
    """Align a quantity/price to Binance's exact decimal grid."""
    if value <= 0 or step <= 0:
        return float(f"{value:.{precision}f}")
    decimal_value = Decimal(str(value))
    decimal_step = Decimal(str(step))
    units = decimal_value / decimal_step
    rounding = ROUND_CEILING if ceiling else ROUND_FLOOR
    aligned = units.to_integral_value(rounding=rounding) * decimal_step
    return float(f"{aligned:.{precision}f}")


def _binance_error_message(exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        try:
            payload = exc.response.json()
            if isinstance(payload, dict):
                return f"Binance HTTP {exc.response.status_code} ({payload.get('code', 'sin código')}): {payload.get('msg', str(exc))}"
        except (ValueError, json.JSONDecodeError):
            pass
        return f"Binance HTTP {exc.response.status_code}: {exc.response.text or str(exc)}"
    if isinstance(exc, HTTPError):
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            return f"Binance HTTP {exc.code} ({payload.get('code', 'sin código')}): {payload.get('msg', str(exc))}"
        except (ValueError, UnicodeDecodeError, OSError):
            return f"Binance HTTP {exc.code}: {exc.reason}"
    return str(exc)


@app.on_event("startup")
def initialize_auth_schema() -> None:
    auth_service.create_schema()
    ctrader_manager.start_configured()
    binance_execution_supervisor.start()
    # Native Binance TP/SL orders survive backend and browser restarts. The
    # execution supervisor still reconciles their state through User Stream.


@app.on_event("startup")
async def start_backend_services() -> None:
    if settings.telegram_enabled and telegram_sink.configured:
        await telegram_sink.start()
    if settings.production_worker_enabled:
        await production_workers.restore(resume_live=settings.production_worker_resume_live and settings.binance_real_trading_enabled)


@app.on_event("shutdown")
def stop_binance_monitor() -> None:
    for user_id, symbol in list(production_workers.workers):
        # Workers are paper/live process-local sessions; stop their market listeners
        # before closing the shared gateway.
        production_workers.workers[(user_id, symbol)].running = False
    production_workers.workers.clear()
    binance_execution_supervisor.stop()
    binance_tp_worker.stop()
    binance_manager.stop_all()
    ctrader_manager.stop_all()


@app.on_event("shutdown")
async def stop_market_gateway() -> None:
    await telegram_sink.stop()
    await binance_market_gateway.close()


@app.post("/auth/register")
def register(payload: RegisterInput) -> dict[str, object]:
    organization_id = f"org-{uuid4().hex}"
    try:
        auth_service.create_organization(
            organization_id=organization_id,
            slug=payload.email.lower().replace("@", "-").replace(".", "-"),
            name=f"{payload.name}'s workspace",
        )
        identity = auth_service.create_user(
            email=payload.email,
            name=payload.name,
            password=payload.password,
            organization_id=organization_id,
            roles={"trader"},
            permissions={"read", "write", "confirm"},
        )
        return identity.as_dict()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Unable to create account.") from exc


@app.get("/health")
def health() -> dict[str, str]:
    return {"service": settings.app_name, "status": "ok", "environment": settings.app_env}


@app.post("/trading/backtest")
async def run_backtest(payload: BacktestInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    """Run a read-only seven-day storycard backtest with real Binance history."""
    del identity
    try:
        bars = await fetch_binance_history(symbol=payload.symbol, interval=payload.interval, days=payload.days, base_url=settings.binance_base_url)
        return run_storycard_backtest(
            bars=bars,
            symbol=payload.symbol,
            storycard=payload.storycard.model_dump(),
            timezone_name=payload.storycard.timezone,
        ) | {"strategy": payload.strategy, "interval": payload.interval}
    except (httpx.HTTPError, ValueError, ZoneInfoNotFoundError) as exc:
        raise HTTPException(status_code=502, detail=f"No se pudo ejecutar el backtest: {exc}") from exc


@app.get("/trading/backtest/context/{symbol}")
async def backtest_context(symbol: str, interval: Literal["1m", "5m", "15m"] = "5m", days: int = 7, offset: int = 0, limit: int = 500, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    """Expose the same paginated OHLC + SSL context available to gm-agent."""
    del identity
    try:
        bars = await fetch_binance_history(symbol=symbol, interval=interval, days=min(days, MAX_BACKTEST_DAYS), base_url=settings.binance_base_url)
        offset = max(0, offset)
        selected = bars[offset : offset + max(1, min(limit, 1000))]
        return {"symbol": symbol.upper(), "interval": interval, "days": MAX_BACKTEST_DAYS, "offset": offset, "limit": limit, "total_bars": len(bars), "bars": [_bar_context(bars, offset + index, 9) for index in range(len(selected))]}
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"No se pudo cargar el contexto histórico: {exc}") from exc


@app.get("/trading/summary")
def summary(identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    return {"mode": "paper", "balance": 10000, "currency": "USD", "open_orders": paper_orders, "operations": paper_operation_store.list(identity.user_id)}


@app.get("/trading/paper/operations")
def list_paper_operations(identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> list[dict[str, object]]:
    return paper_operation_store.list(identity.user_id)


@app.post("/trading/paper/operations")
def create_paper_operation(payload: PaperOperationInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    return paper_operation_store.create(identity.user_id, payload.model_dump())


@app.put("/trading/paper/operations/{operation_id}")
def update_paper_operation(operation_id: str, payload: PaperOperationInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    operation = paper_operation_store.update(identity.user_id, operation_id, payload.model_dump())
    if operation is None:
        raise HTTPException(status_code=404, detail="Paper operation not found.")
    return operation


@app.delete("/trading/paper/operations/{operation_id}")
def delete_paper_operation(operation_id: str, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, bool]:
    if not paper_operation_store.delete(identity.user_id, operation_id):
        raise HTTPException(status_code=404, detail="Paper operation not found.")
    return {"deleted": True}


@app.get("/trading/binance")
def binance_account(identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    if not settings.binance_account_monitor_enabled:
        return {"enabled": False, "configured": False, "healthy": False, "error": "Monitor Binance deshabilitado"}
    return binance_manager.snapshot(identity.user_id)


@app.get("/trading/binance/runtime")
def binance_runtime(identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    """Expose backend worker health without exposing credentials or secrets."""
    snapshot = binance_manager.snapshot(identity.user_id)
    return {"real_trading_enabled": settings.binance_real_trading_enabled, "worker": binance_execution_supervisor.status(), "account": snapshot}


@app.get("/trading/production/workers")
def list_production_workers(identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> list[dict[str, object]]:
    """Return strategy worker status without exposing credentials."""
    return production_workers.list(identity.user_id)


@app.post("/trading/production/workers")
async def start_production_worker(payload: ProductionWorkerInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    """Start one per-symbol strategy session; live mode is explicitly gated."""
    if not settings.production_worker_enabled:
        raise HTTPException(status_code=503, detail="Los workers de producción están deshabilitados.")
    if payload.mode == "live":
        if not settings.binance_real_trading_enabled:
            raise HTTPException(status_code=503, detail="El trading real está bloqueado en este entorno.")
        if not payload.confirmed:
            raise HTTPException(status_code=409, detail="Confirma explícitamente el modo live.")
    try:
        return await production_workers.start(identity.user_id, payload.symbol, mode=payload.mode, interval=payload.interval, tracker_period=payload.tracker_period, stop_percent=payload.stop_percent, target_percent=payload.target_percent, quantity=payload.quantity)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.delete("/trading/production/workers/{symbol}")
async def stop_production_worker(symbol: str, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    return await production_workers.stop(identity.user_id, symbol)


@app.get("/trading/binance/execution-intents")
def list_binance_execution_intents(identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> list[dict[str, object]]:
    """List durable execution intents; no exchange order is created by this endpoint."""
    return binance_execution_store.list(identity.user_id)


@app.post("/trading/binance/real/operations")
def open_binance_real_operation(payload: BinanceRealOrderInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    """Open one real isolated position with exchange-side SL protection.

    The TP is intentionally not submitted to Binance: it is managed by the
    application strategy so it can move with the live indicator.
    """
    if not settings.binance_real_trading_enabled:
        raise HTTPException(status_code=503, detail="El trading real de Binance está bloqueado en este entorno.")
    if not payload.confirmed:
        raise HTTPException(status_code=409, detail="Confirma explícitamente la operación real.")
    started_at = time.perf_counter()
    symbol = payload.symbol.upper()
    order_side = "BUY" if payload.side == "LONG" else "SELL"
    close_side = "SELL" if order_side == "BUY" else "BUY"
    live_price, step_size, tick_size, min_notional, price_precision, quantity_precision = _binance_public_execution_rules(symbol)
    if live_price <= 0 or min_notional <= 0:
        raise HTTPException(status_code=502, detail=f"No se pudieron cargar las reglas actuales de {symbol}.")
    # Add a tiny boundary buffer: an exact min-notional quantity can fall
    # below the exchange limit between the public ticker read and the market
    # order. The buffer is only used when the requested order is below it.
    requested_quantity = max(payload.quantity, (min_notional * 1.001) / live_price)
    quantity = _align_binance_value(requested_quantity, step_size, quantity_precision, ceiling=True)
    # Never let an entry inherit Crossed mode accidentally.
    current_config = binance_manager.symbol_config(identity.user_id, symbol)
    if current_config.get("margin_type") != "ISOLATED":
        binance_manager.set_symbol_margin_type(identity.user_id, symbol, "ISOLATED")
    # Apply the leverage selected by the risk profile before submitting the
    # market entry. Binance stores this setting per symbol.
    current_leverage = int(current_config.get("leverage") or 0)
    if current_leverage != payload.leverage:
        binance_manager.set_symbol_leverage(identity.user_id, symbol, payload.leverage)
    intent = binance_execution_store.create(identity.user_id, {
        "symbol": symbol, "side": payload.side, "quantity": quantity,
        "stop_loss": payload.stop_loss, "take_profit": payload.take_profit,
    })
    entry = None
    stop_order = None
    try:
        entry = binance_manager.place_market_order(identity.user_id, symbol, order_side, quantity, str(intent["client_order_id"]))
        binance_execution_store.update(intent["id"], identity.user_id, status="ENTRY_SUBMITTED", exchange_order_id=str(entry.get("orderId")))
        # RESULT normally contains the final MARKET fill. Use it immediately
        # and only fall back to positionRisk when Binance returns a projected
        # response with no average price/filled quantity. This removes a REST
        # round trip from the normal protection path.
        average_open = next((float(value) for value in (entry.get("avgPrice"), entry.get("price"), live_price) if value is not None and float(value) > 0), live_price)
        actual_quantity = next((abs(float(value)) for value in (entry.get("executedQty"), quantity) if value is not None and float(value) > 0), quantity)
        if not entry.get("avgPrice") or not entry.get("executedQty"):
            filled_position = binance_manager.position_risk(identity.user_id, symbol)
            average_open = next((float(value) for value in (filled_position.get("entryPrice"), average_open) if value is not None and float(value) > 0), average_open)
            actual_quantity = next((abs(float(value)) for value in (filled_position.get("positionAmt"), actual_quantity) if value is not None and float(value) > 0), actual_quantity)
        quantity = _align_binance_value(actual_quantity, step_size, quantity_precision, ceiling=False)
        if quantity <= 0 or average_open <= 0:
            raise RuntimeError("Binance no devolvió una posición rellenada válida para proteger.")
        direction = 1 if payload.side == "LONG" else -1
        stop = average_open * (1 - direction * payload.stop_percent / 100)
        target = average_open * (1 + direction * payload.target_percent / 100)
        # Keep protective triggers on Binance's tick grid. A protective level
        # is biased away from the entry so rounding cannot turn it into an
        # immediately-triggering order.
        stop = _align_binance_value(stop, tick_size, price_precision, ceiling=payload.side == "SHORT")
        target = _align_binance_value(target, tick_size, price_precision, ceiling=payload.side == "LONG")
        entry_time = int(float(entry.get("transactTime") or entry.get("updateTime") or time.time() * 1000) / 1000)
        binance_execution_store.update(intent["id"], identity.user_id, quantity=quantity, entry_time=entry_time, entry_price=average_open, stop_loss=stop, take_profit=target)
        # Binance validates conditional orders against the current MARK_PRICE,
        # not against the entry fill. The market can cross a level while the
        # entry response is travelling back to us, which would make the next
        # STOP/TAKE_PROFIT request fail with -2021.
        mark_price = _binance_public_mark_price(symbol)
        if mark_price > 0:
            stop_valid = stop < mark_price if close_side == "SELL" else stop > mark_price
            target_valid = target > mark_price if close_side == "SELL" else target < mark_price
            if not stop_valid or not target_valid:
                raise RuntimeError(
                    f"El mark price {mark_price:g} ya cruzó una protección "
                    f"(SL {stop:g}, TP {target:g}); se solicitará cierre de seguridad."
                )
        stop_order = binance_manager.place_close_protection(identity.user_id, symbol, close_side, stop, f"{intent['client_order_id']}_sl", "STOP_MARKET")
        if not isinstance(stop_order, dict) or not (stop_order.get("algoId") or stop_order.get("clientAlgoId")):
            raise RuntimeError("Binance no confirmó la orden STOP_MARKET de protección.")
        take_profit_order = binance_manager.place_close_protection(identity.user_id, symbol, close_side, target, f"{intent['client_order_id']}_tp", "TAKE_PROFIT_MARKET", working_type="CONTRACT_PRICE")
        if not isinstance(take_profit_order, dict) or not (take_profit_order.get("algoId") or take_profit_order.get("clientAlgoId")):
            raise RuntimeError("Binance no confirmó la orden TAKE_PROFIT_MARKET.")
        saved = binance_execution_store.update(
            intent["id"], identity.user_id, status="PROTECTED", stop_algo_id=str(stop_order.get("algoId") or stop_order.get("clientAlgoId")),
            take_profit_algo_id=str(take_profit_order.get("algoId") or take_profit_order.get("clientAlgoId")), last_error=None,
        )
        latency_ms = round((time.perf_counter() - started_at) * 1000, 3)
        return {"broker": "binance", "mode": "real", "operation": saved, "entry": entry, "stop": stop, "target": target, "take_profit_mode": "native", "backend_latency_ms": latency_ms}
    except Exception as exc:
        emergency_error = None
        if stop_order and stop_order.get("algoId"):
            try:
                binance_manager.cancel_close_protection(identity.user_id, symbol, str(stop_order["algoId"]))
            except Exception:
                pass
        if entry is not None:
            try:
                # Re-read the actual filled position. A partial fill, exchange
                # rounding, or a fast trigger can make the original quantity
                # stale by the time the emergency close is submitted.
                emergency_position = binance_manager.position_risk(identity.user_id, symbol)
                emergency_quantity = abs(float(emergency_position.get("positionAmt") or 0))
                emergency_quantity = _align_binance_value(emergency_quantity, step_size, quantity_precision, ceiling=False)
                if emergency_quantity > 0:
                    binance_manager.place_market_order(identity.user_id, symbol, close_side, emergency_quantity, f"{intent['client_order_id']}_emergency", reduce_only=True)
                else:
                    emergency_error = "Binance ya no reporta una posición abierta; se reconcilió el intento."
            except Exception as close_exc:  # surface this prominently for manual intervention
                emergency_error = str(close_exc)
        message = _binance_error_message(exc) if emergency_error is None else f"{_binance_error_message(exc)}; cierre de emergencia falló: {emergency_error}"
        binance_execution_store.update(intent["id"], identity.user_id, status="ERROR", last_error=message)
        raise HTTPException(status_code=502, detail=f"Binance rechazó la operación; revisa el estado antes de reintentar: {message}") from exc


@app.post("/trading/binance/real/operations/{symbol}/close")
def close_binance_real_operation(symbol: str, payload: BinanceCloseOrderInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    """Close the complete live Binance position with a reduce-only market order."""
    if not settings.binance_real_trading_enabled:
        raise HTTPException(status_code=503, detail="El trading real de Binance está bloqueado en este entorno.")
    if not payload.confirmed:
        raise HTTPException(status_code=409, detail="Confirma explícitamente el cierre real.")
    requested = symbol.strip().upper()
    position = binance_manager.position_risk(identity.user_id, requested)
    quantity = abs(float(position.get("positionAmt") or 0))
    if quantity <= 0:
        # The account stream can briefly retain a stale row after Binance has
        # already closed the position (for example after a triggered SL or an
        # emergency exit). Reconcile the durable intent instead of returning
        # an error that leaves a phantom position in the UI.
        stale_intent = next((item for item in binance_execution_store.list(identity.user_id)
                             if str(item.get("symbol", "")).upper() == requested
                             and str(item.get("status", "")) not in {"CLOSED", "ERROR"}), None)
        if stale_intent:
            binance_execution_store.update(str(stale_intent["id"]), identity.user_id, status="CLOSED", last_error="RECONCILED_NO_POSITION")
        return {"broker": "binance", "mode": "real", "symbol": requested, "closed": True, "already_closed": True}
    side = "SELL" if float(position.get("positionAmt") or 0) > 0 else "BUY"
    intent = next((item for item in binance_execution_store.list(identity.user_id)
                   if str(item.get("symbol", "")).upper() == requested
                   and str(item.get("status", "")) not in {"CLOSED", "ERROR"}), None)
    client_root = str(intent.get("client_order_id")) if intent else f"helloworld_manual_{uuid4().hex[:16]}"
    client_order_id = f"{client_root}_manual"
    if intent:
        binance_execution_store.update(str(intent["id"]), identity.user_id, status="CLOSING")
    try:
        order = binance_manager.place_market_order(identity.user_id, requested, side, quantity, client_order_id, reduce_only=True)
    except Exception as exc:
        if intent:
            binance_execution_store.update(str(intent["id"]), identity.user_id, status="PROTECTED", last_error=str(exc))
        raise HTTPException(status_code=502, detail=f"Binance no pudo cerrar {requested}: {exc}") from exc
    return {"broker": "binance", "mode": "real", "symbol": requested, "side": side, "quantity": quantity, "order": order}


@app.post("/trading/binance/real/operations/{symbol}/take-profit")
def update_binance_real_take_profit(symbol: str, payload: BinanceTakeProfitUpdateInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    """Replace the native Binance take-profit after explicit confirmation."""
    if not settings.binance_real_trading_enabled:
        raise HTTPException(status_code=503, detail="El trading real de Binance está bloqueado en este entorno.")
    if not payload.confirmed:
        raise HTTPException(status_code=409, detail="Confirma explícitamente el cambio de TP.")
    requested = symbol.strip().upper()
    intent = next((item for item in binance_execution_store.list(identity.user_id)
                   if str(item.get("symbol", "")).upper() == requested and item.get("status") == "PROTECTED"), None)
    if not intent:
        raise HTTPException(status_code=409, detail=f"No hay una operación Binance protegida de {requested}.")
    close_side = "SELL" if str(intent.get("side", "")).upper() == "LONG" else "BUY"
    new_order = binance_manager.place_close_protection(
        identity.user_id, requested, close_side, payload.take_profit,
        f"{intent['client_order_id']}_tp_{uuid4().hex[:8]}", "TAKE_PROFIT_MARKET", working_type="CONTRACT_PRICE",
    )
    algo_id = (new_order.get("algoId") or new_order.get("clientAlgoId")) if isinstance(new_order, dict) else None
    if not algo_id:
        raise HTTPException(status_code=502, detail="Binance no confirmó el nuevo TAKE_PROFIT_MARKET.")
    old_algo_id = intent.get("take_profit_algo_id")
    try:
        if old_algo_id:
            binance_manager.cancel_close_protection(identity.user_id, requested, str(old_algo_id))
    except Exception as exc:
        # Never leave two active take-profits if the old one cannot be
        # canceled. Remove the new order and keep the old protection.
        try:
            binance_manager.cancel_close_protection(identity.user_id, requested, str(algo_id))
        except Exception:
            pass
        raise HTTPException(status_code=502, detail=f"No se pudo reemplazar el TP anterior: {exc}") from exc
    saved = binance_execution_store.update(str(intent["id"]), identity.user_id, take_profit=float(payload.take_profit), take_profit_algo_id=str(algo_id), last_error=None)
    return {"broker": "binance", "mode": "real", "symbol": requested, "take_profit": payload.take_profit, "operation": saved}


@app.get("/trading/binance/symbol-config/{symbol}")
def binance_symbol_config(symbol: str, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    """Return account-specific margin mode and leverage for one Binance future."""
    if not settings.binance_account_monitor_enabled:
        return {"configured": False, "symbol": symbol.upper(), "margin_type": None, "leverage": None}
    return binance_manager.symbol_config(identity.user_id, symbol)


@app.post("/trading/binance/symbol-config/{symbol}/margin-type")
def set_binance_margin_type(symbol: str, payload: BinanceMarginTypeInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    """Set the margin mode for one Binance Futures symbol after explicit UI action."""
    if not settings.binance_account_monitor_enabled:
        raise HTTPException(status_code=503, detail="El monitor de Binance está deshabilitado.")
    try:
        return binance_manager.set_symbol_margin_type(identity.user_id, symbol, payload.margin_type)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Binance no pudo cambiar el margen de {symbol.upper()}: {exc}") from exc


@app.post("/trading/binance/symbol-config/{symbol}/leverage")
def set_binance_leverage(symbol: str, payload: BinanceLeverageInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    """Set the account leverage for one Binance Futures symbol after explicit UI action."""
    if not settings.binance_account_monitor_enabled:
        raise HTTPException(status_code=503, detail="El monitor de Binance está deshabilitado.")
    try:
        return binance_manager.set_symbol_leverage(identity.user_id, symbol, payload.leverage)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Binance no pudo cambiar el leverage de {symbol.upper()}: {exc}") from exc


@app.get("/market/binance/active-symbols")
def binance_active_symbols(
    limit: int = 30,
    min_quote_volume: float = 50_000_000,
    min_trades: int = 100_000,
    min_movement_pct: float = 0.5,
    horizon: int = 10,
    interval: Literal["1m", "5m"] = "5m",
    identity: AuthIdentity = Depends(identity_dependency(auth_service)),
) -> dict[str, object]:
    """Return liquid, active Binance Futures symbols ranked by observed movement.

    This endpoint uses public market data only. It intentionally does not
    reuse the legacy scanner or require a user's private Binance credentials.
    """
    limit = max(1, min(limit, 100))
    min_quote_volume = max(0, min(min_quote_volume, 10_000_000_000_000))
    min_trades = max(0, min(min_trades, 100_000_000))
    min_movement_pct = max(0, min(min_movement_pct, 100))
    horizon = max(1, min(horizon, 240))
    try:
        exchange_response = httpx.get("https://fapi.binance.com/fapi/v1/exchangeInfo", timeout=15)
        ticker_response = httpx.get("https://fapi.binance.com/fapi/v1/ticker/24hr", timeout=15)
        exchange_response.raise_for_status()
        ticker_response.raise_for_status()
        exchange_payload = exchange_response.json()
        ticker_payload = ticker_response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="No se pudo consultar el mercado público de Binance.") from exc

    tradable = {
        str(item.get("symbol", ""))
        for item in exchange_payload.get("symbols", [])
        if item.get("status") == "TRADING"
        and item.get("quoteAsset") == "USDT"
        and item.get("contractType") == "PERPETUAL"
    }


    ranked: list[dict[str, object]] = []
    for item in ticker_payload if isinstance(ticker_payload, list) else []:
        symbol = str(item.get("symbol", ""))
        try:
            movement_pct = abs(float(item.get("priceChangePercent", 0)))
            high = float(item.get("highPrice", 0))
            low = float(item.get("lowPrice", 0))
            range_pct = ((high - low) / low * 100) if low > 0 else 0
            quote_volume = float(item.get("quoteVolume", 0))
            trades = int(item.get("count", 0))
            last_price = float(item.get("lastPrice", 0))
        except (TypeError, ValueError):
            continue
        if symbol not in tradable or quote_volume < min_quote_volume or trades < min_trades or movement_pct < min_movement_pct:
            continue
        # Movement is primary; liquidity contributes logarithmically so a
        # single huge-volume market cannot drown out all other candidates.
        score = movement_pct * (1 + math.log10(max(quote_volume, 1)) / 10)
        ranked.append({
            "symbol": symbol,
            "last_price": last_price,
            "change_pct": float(item.get("priceChangePercent", 0)),
            "movement_pct": movement_pct,
            "range_pct": range_pct,
            "quote_volume": quote_volume,
            "trades": trades,
            "score": score,
        })
    ranked.sort(key=lambda row: (float(row["score"]), float(row["quote_volume"])), reverse=True)
    max_leverages: dict[str, int] = {}
    leverage_source = "no configurado"
    user_id = getattr(identity, "user_id", None)
    credentials = binance_credentials.get(user_id) if user_id else None
    if credentials:
        try:
            max_leverages = BinanceAccountMonitor(credentials[0], credentials[1], settings.binance_base_url).max_leverages()
            leverage_source = "Binance leverageBracket"
        except Exception:
            leverage_source = "no disponible"
    for row in ranked:
        row["max_leverage"] = max_leverages.get(str(row["symbol"]).upper())

    # The 24h ticker is only a universe filter. The scanner metric is the
    # accumulated absolute close-to-close variation of the latest N candles.
    def horizon_variation(symbol: str) -> tuple[float, float] | None:
        try:
            response = httpx.get(
                f"https://fapi.binance.com/fapi/v1/klines?symbol={symbol}&interval={interval}&limit=500",
                timeout=15,
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list):
                return None
            candles = []
            for candle in payload:
                if not isinstance(candle, list) or len(candle) < 5:
                    continue
                try:
                    candles.append((float(candle[1]), float(candle[2]), float(candle[3]), float(candle[4])))
                except (TypeError, ValueError):
                    continue
            if len(candles) <= horizon:
                return None
            recent = candles[-(horizon + 1):]
            variations = [abs(recent[index][3] - recent[index - 1][3]) / recent[index - 1][3] * 100 for index in range(1, len(recent)) if recent[index - 1][3] > 0]
            if len(variations) < horizon:
                return None
            return sum(variations), sum(variations) / len(variations)
        except (httpx.HTTPError, ValueError):
            return None

    for row in ranked[:limit]:
        variation = horizon_variation(str(row["symbol"]))
        variation_sum_pct, variation_average_pct = variation if variation else (0.0, 0.0)
        row.update({
            "horizon": horizon,
            "interval": interval,
            "variation_sum_pct": variation_sum_pct,
            "variation_average_pct": variation_average_pct,
        })
    ranked[:limit] = sorted(
        ranked[:limit],
        key=lambda row: (float(row.get("variation_sum_pct", 0)), float(row["quote_volume"])),
        reverse=True,
    )
    return {
        "broker": "binance",
        "interval": "24h",
        "horizon": horizon,
        "candle_interval": interval,
        "variation": "sum(abs(close-close_previous)/close_previous) for the last N candles",
        "filters": {"min_quote_volume": min_quote_volume, "min_trades": min_trades, "min_movement_pct": min_movement_pct},
        "leverage_source": leverage_source,
        "symbols": ranked[:limit],
    }


@app.get("/market/binance/candles/{symbol}")
async def binance_candles(
    symbol: str,
    interval: Literal["1m", "3m", "5m", "15m"] = "1m",
    limit: int = 500,
    identity: AuthIdentity = Depends(identity_dependency(auth_service)),
) -> dict[str, object]:
    """Serve historical candles and warm the same cache used by realtime."""
    del identity
    requested = symbol.upper()
    limit = max(1, min(limit, 1500))
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                f"https://fapi.binance.com/fapi/v1/klines?symbol={requested}&interval={interval}&limit={limit}"
            )
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="No se pudieron cargar las velas de Binance Futures.") from exc
    bars: list[dict[str, object]] = []
    for row in payload if isinstance(payload, list) else []:
        if not isinstance(row, list) or len(row) < 5:
            continue
        try:
            bars.append({
                "time": int(float(row[0]) / 1000),
                "open": float(row[1]), "high": float(row[2]),
                "low": float(row[3]), "close": float(row[4]), "closed": True,
            })
        except (TypeError, ValueError):
            continue
    binance_market_gateway.put_bars(requested, interval, bars)
    return {"symbol": requested, "interval": interval, "bars": bars}


@app.get("/market/binance/scanner-analysis")
async def binance_scanner_analysis(
    symbols: str = Query("", description="Comma-separated symbols currently visible in the scanner."),
    tracker_period: int = 5,
    stop_percent: float = 0.2,
    initial_balance: float = 100.0,
    risk_percent: float = 1.0,
    leverage: float = 1.0,
    limit: int = 1500,
    movement_averages: str = Query("", description="Optional comma-separated 1m movement averages matching symbols."),
    identity: AuthIdentity = Depends(identity_dependency(auth_service)),
) -> dict[str, object]:
    """Analyze the scanner universe without requiring a chart to be selected.

    The endpoint is intentionally read-only. Results are cached briefly so the
    browser and future Telegram consumers can poll it without repeating the
    expensive TP search until a new closed candle is available.
    """
    del identity
    requested = list(dict.fromkeys(value.strip().upper() for value in symbols.split(",") if value.strip()))[:30]
    if not requested:
        return {"symbols": [], "updated_at": int(time.time()), "cache_ttl_seconds": 50}
    config = ScannerAnalysisConfig(
        tracker_period=max(1, min(int(tracker_period), 50)),
        stop_percent=max(0.01, min(abs(float(stop_percent)), 20)),
        initial_balance=max(1.0, min(float(initial_balance), 1_000_000)),
        risk_percent=max(0.01, min(float(risk_percent), 100)),
        leverage=max(1.0, min(float(leverage), 125)),
    )
    cache_key = "|".join([*requested, str(config)])
    now = time.monotonic()
    async with _scanner_analysis_lock:
        cached = _scanner_analysis_cache.get(cache_key)
        if cached and now - cached[0] < 50:
            return cached[1]

        safe_limit = max(100, min(int(limit), 1500))
        semaphore = asyncio.Semaphore(5)
        request_profile = Profiling("scanner_analysis")

        async def analyze_symbol(symbol: str) -> dict[str, object]:
            async with semaphore:
                profile = Profiling(f"scanner_symbol:{symbol}")
                try:
                    with profile.measure("fetch_klines"):
                        async with httpx.AsyncClient(timeout=15) as client:
                            response = await client.get(f"{settings.binance_base_url.rstrip('/')}/fapi/v1/klines", params={"symbol": symbol, "interval": "1m", "limit": safe_limit})
                            response.raise_for_status()
                            payload = response.json()
                    with profile.measure("parse_response"):
                        bars = []
                        for row in payload if isinstance(payload, list) else []:
                            if isinstance(row, list) and len(row) >= 5:
                                bars.append({"time": int(float(row[0]) / 1000), "open": float(row[1]), "high": float(row[2]), "low": float(row[3]), "close": float(row[4])})
                    result = analyze_tracker(bars, config, profile)
                    return {"symbol": symbol, **result, "profiling": profile.snapshot()}
                except (httpx.HTTPError, ValueError, TypeError) as exc:
                    return {"symbol": symbol, "error": str(exc), "tp_optimal_percent": None, "average_duration_minutes": None, "operations": 0, "wins": 0, "losses": 0, "equity_final": None, "final_result_usdt": None, "last_bar_time": None, "bars": 0, "profiling": profile.snapshot()}

        with request_profile.measure("analyze_symbols"):
            rows = list(await asyncio.gather(*(analyze_symbol(symbol) for symbol in requested)))
        average_values = [value.strip() for value in movement_averages.split(",")]
        for index, row in enumerate(rows):
            try:
                movement = float(average_values[index]) if index < len(average_values) else 0.0
            except ValueError:
                movement = 0.0
            row["activity_state"] = activity_state(movement)
            previous_state = _scanner_analysis_states.get(str(row["symbol"]))
            if previous_state != row["activity_state"]:
                _scanner_analysis_states[str(row["symbol"])] = str(row["activity_state"])
                await backend_events.publish({"type": "SCANNER_STATE_CHANGED", "symbol": row["symbol"], "state": row["activity_state"], "tp_optimal_percent": row["tp_optimal_percent"], "average_duration_minutes": row["average_duration_minutes"], "movement_average_percent": movement})
        result = {"symbols": rows, "updated_at": int(time.time()), "cache_ttl_seconds": 50, "config": {"tracker_period": config.tracker_period, "stop_percent": config.stop_percent, "initial_balance": config.initial_balance, "risk_percent": config.risk_percent, "leverage": config.leverage}, "profiling": request_profile.snapshot()}
        _scanner_analysis_cache[cache_key] = (now, result)
        return result


@app.websocket("/market/binance/stream/{symbol}")
async def binance_market_stream(websocket: WebSocket, symbol: str) -> None:
    await binance_market_gateway.subscribe(symbol, websocket)


@app.websocket("/trading/binance/stream")
async def binance_account_stream(websocket: WebSocket) -> None:
    """Push private Binance account events without UI polling."""
    token = websocket.query_params.get("access_token", "")
    try:
        identity = auth_service.identity_from_access_token(token)
    except ValueError:
        await websocket.close(code=4401, reason="Invalid access token")
        return
    await websocket.accept()
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict[str, object]] = asyncio.Queue(maxsize=64)

    def on_event(event: dict[str, object]) -> None:
        def enqueue() -> None:
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(event)
        loop.call_soon_threadsafe(enqueue)

    binance_manager.subscribe_events(identity.user_id, on_event)
    try:
        # Credential decryption plus the first account/position bootstrap are
        # synchronous HTTP work. Never run them on FastAPI's event loop: one
        # slow Binance response otherwise blocks every private WebSocket and
        # leaves the UI stuck at "Sin conexión".
        snapshot = await asyncio.to_thread(binance_manager.snapshot, identity.user_id)
        latest_snapshot = snapshot
        execution_intents = jsonable_encoder(await asyncio.to_thread(binance_execution_store.list, identity.user_id))
        await websocket.send_json({"type": "snapshot", "snapshot": snapshot, "execution_intents": execution_intents, "server_time": int(time.time() * 1000)})
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=15)
            except asyncio.TimeoutError:
                # Keep the browser-side channel observable without polling
                # Binance account data. Account state still changes only from
                # Binance User Data Stream events.
                await websocket.send_json({
                    "type": "heartbeat",
                    "state_seq": latest_snapshot.get("state_seq", 0),
                    "server_time": int(time.time() * 1000),
                })
                continue
            if isinstance(event.get("snapshot"), dict):
                latest_snapshot = event["snapshot"]
            # Persist the exchange close before reading intents for this
            # frame. Listener callbacks run in an unordered set, so relying
            # on the background supervisor alone can send the UI one stale
            # intent snapshot after an SL/TP fill.
            await asyncio.to_thread(binance_execution_store.reconcile_account_event, identity.user_id, event)
            event["execution_intents"] = jsonable_encoder(await asyncio.to_thread(binance_execution_store.list, identity.user_id))
            await websocket.send_json(event)
    except Exception:
        logger.exception("binance_account_websocket_failed user=%s", identity.user_id)
    finally:
        binance_manager.unsubscribe_events(identity.user_id, on_event)


@app.get("/market/binance/symbol-info/{symbol}")
def binance_symbol_info(symbol: str, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    """Return Binance Futures execution rules for one symbol."""
    requested = symbol.upper()
    try:
        response = httpx.get("https://fapi.binance.com/fapi/v1/exchangeInfo", timeout=15)
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="No se pudo consultar la precisión del símbolo en Binance.") from exc
    item = next((value for value in payload.get("symbols", []) if value.get("symbol") == requested), None)
    if not item:
        raise HTTPException(status_code=404, detail="Símbolo no encontrado en Binance Futures.")
    filters = {str(value.get("filterType")): value for value in item.get("filters", [])}
    price_filter = filters.get("PRICE_FILTER", {})
    lot_size = filters.get("LOT_SIZE", {})
    notional_filter = filters.get("NOTIONAL") or filters.get("MIN_NOTIONAL") or {}
    return {
        "symbol": requested,
        "price_precision": int(item.get("pricePrecision", 8)),
        "quantity_precision": int(item.get("quantityPrecision", 8)),
        "tick_size": float(price_filter.get("tickSize", 0) or 0),
        "step_size": float(lot_size.get("stepSize", 0) or 0),
        "min_qty": float(lot_size.get("minQty", 0) or 0),
        "min_notional": float(notional_filter.get("notional", 0) or 0),
    }


@app.get("/trading/binance/credentials")
def binance_credentials_status(identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    return binance_credentials.status(identity.user_id)


@app.put("/trading/binance/credentials")
def save_binance_credentials(payload: BinanceCredentialsInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    try:
        return {**binance_manager.save(identity.user_id, payload.api_key, payload.api_secret), "message": "Credenciales guardadas de forma segura."}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.delete("/trading/binance/credentials")
def delete_binance_credentials(identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    binance_manager.delete(identity.user_id)
    return {"configured": False, "message": "Credenciales de Binance eliminadas."}


@app.get("/trading/ctrader/credentials")
def ctrader_credentials_status(identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    runtime = ctrader_manager.snapshot(identity.user_id)
    stored = ctrader_credentials.status(identity.user_id)
    return {
        **stored,
        "account_id": runtime.get("account_id") or stored.get("account_id"),
        "accounts": runtime.get("accounts", []),
        "enabled": settings.ctrader_enabled,
        "broker": "ctrader",
        "symbols": list(settings.ctrader_symbol_list),
    }


@app.get("/trading/ctrader/oauth/url")
def ctrader_oauth_url(identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, str]:
    del identity
    if not settings.ctrader_enabled or not settings.ctrader_client_id:
        raise HTTPException(status_code=503, detail="cTrader OAuth no está configurado en este entorno.")
    return {"url": "https://id.ctrader.com/my/settings/openapi/grantingaccess/?" + urlencode({
        "client_id": settings.ctrader_client_id,
        "redirect_uri": settings.ctrader_redirect_uri,
        "scope": "trading",
        "product": "web",
    })}


@app.post("/trading/ctrader/oauth/exchange")
def ctrader_oauth_exchange(payload: CTraderOAuthCodeInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    if not settings.ctrader_enabled:
        raise HTTPException(status_code=503, detail="cTrader no está habilitado en este entorno.")
    try:
        response = httpx.get("https://openapi.ctrader.com/apps/token", params={
            "grant_type": "authorization_code", "code": payload.code,
            "client_id": settings.ctrader_client_id, "client_secret": settings.ctrader_client_secret,
            "redirect_uri": settings.ctrader_redirect_uri,
        }, headers={"Accept": "application/json"}, timeout=15)
        token_payload = response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="No se pudo contactar el servicio OAuth de cTrader.") from exc
    access_token = str(token_payload.get("accessToken") or "").strip()
    refresh_token = str(token_payload.get("refreshToken") or "").strip()
    if not response.is_success or not access_token or not refresh_token:
        raise HTTPException(status_code=502, detail=token_payload.get("description") or token_payload.get("errorCode") or "cTrader no entregó tokens válidos.")
    ctrader_credentials.save(identity.user_id, access_token, refresh_token, 0)
    ctrader_manager.stop_user(identity.user_id)
    ctrader_manager.start_user(identity.user_id)
    return {"configured": True, "broker": "ctrader", "message": "cTrader autorizado. Detectando cuentas…"}


@app.put("/trading/ctrader/credentials")
def save_ctrader_credentials(payload: CTraderCredentialsInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    if not settings.ctrader_enabled:
        raise HTTPException(status_code=503, detail="El broker cTrader no está habilitado en este entorno.")
    saved = ctrader_credentials.save(identity.user_id, payload.access_token, payload.refresh_token, payload.account_id)
    ctrader_manager.start_user(identity.user_id)
    return {
        **saved,
        "enabled": settings.ctrader_enabled,
        "broker": "ctrader",
        "symbols": list(settings.ctrader_symbol_list),
        "message": "Credenciales cTrader guardadas de forma segura.",
    }


@app.delete("/trading/ctrader/credentials")
def delete_ctrader_credentials(identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    ctrader_credentials.delete(identity.user_id)
    ctrader_manager.stop_user(identity.user_id)
    return {"configured": False, "broker": "ctrader", "message": "Credenciales cTrader eliminadas."}


@app.get("/trading/ctrader")
def ctrader_account(identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    return ctrader_manager.snapshot(identity.user_id)


@app.get("/trading/ctrader/tick/{symbol}")
def ctrader_tick(symbol: str, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    status = ctrader_manager.snapshot(identity.user_id)
    requested = symbol.upper()
    ticks = status.get("last_ticks") if isinstance(status.get("last_ticks"), dict) else {}
    tick = ticks.get(requested) if isinstance(ticks, dict) else None
    return {"broker": "ctrader", "symbol": requested, "tick": tick, "connected": bool(status.get("healthy"))}


@app.get("/trading/ctrader/candles/{symbol}")
def ctrader_candles(symbol: str, interval: str = "1m", days: int = 1, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    if interval not in {"1m", "5m", "15m", "30m", "1h"}:
        raise HTTPException(status_code=400, detail="Intervalo cTrader no soportado.")
    if not 1 <= days <= 30:
        raise HTTPException(status_code=400, detail="days debe estar entre 1 y 30.")
    status = ctrader_manager.snapshot(identity.user_id)
    session = ctrader_manager.session(identity.user_id)
    if session is None or not status.get("healthy"):
        raise HTTPException(status_code=503, detail=status.get("error_message") or "cTrader no está conectado.")
    now_ms = int(__import__("time").time() * 1000)
    rows = session.candles(symbol, interval, now_ms - days * 86400000, now_ms)
    return {"broker": "ctrader", "symbol": symbol.upper(), "interval": interval, "data": rows}


@app.post("/trading/ctrader/orders")
def place_ctrader_order(payload: CTraderOrderInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    if not payload.confirmed:
        raise HTTPException(status_code=409, detail="Confirma explícitamente la operación real antes de enviarla a cTrader.")
    try:
        result = ctrader_manager.execute(identity.user_id, payload.model_dump(exclude={"confirmed"}))
    except (RuntimeError, ValueError, TimeoutError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"broker": "ctrader", "mode": "real", **result}


@app.post("/trading/ctrader/positions/close")
def close_ctrader_position(payload: CTraderCloseInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    if not payload.confirmed:
        raise HTTPException(status_code=409, detail="Confirma explícitamente el cierre real antes de enviarlo a cTrader.")
    try:
        result = ctrader_manager.execute_raw(identity.user_id, {"type": "CLOSE_POSITION", **payload.model_dump(exclude={"confirmed"})})
    except (RuntimeError, ValueError, TimeoutError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"broker": "ctrader", "mode": "real", **result}


@app.post("/trading/ctrader/positions/amend")
def amend_ctrader_position(payload: CTraderAmendInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    if not payload.confirmed:
        raise HTTPException(status_code=409, detail="Confirma explícitamente el cambio real antes de enviarlo a cTrader.")
    if payload.stop_loss is None and payload.take_profit is None:
        raise HTTPException(status_code=400, detail="Indica stop loss o take profit.")
    try:
        result = ctrader_manager.execute_raw(identity.user_id, {"type": "AMEND_POSITION", **payload.model_dump(exclude={"confirmed"})})
    except (RuntimeError, ValueError, TimeoutError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"broker": "ctrader", "mode": "real", **result}


@app.post("/agent/chat")
async def chat(payload: ChatInput, identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    if payload.conversation_id and payload.conversation_id not in conversations:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    conversation = conversations.setdefault(payload.conversation_id or str(uuid4()), Conversation())
    context = RequestContext(
        user_id=identity.user_id,
        organization_id=identity.organization_id,
        product_id=settings.product_id,
        permissions=frozenset({"read", "write", "confirm"}),
    )
    confirmation = (lambda _tool, _arguments: payload.confirm)
    service = AgentService(agent_service.provider, tool_registry, confirmation=confirmation)
    message = await service.respond(conversation=conversation, prompt=payload.prompt, context=context, model="gpt-4o-mini")
    conversations[conversation.id] = conversation
    return {"conversationId": conversation.id, "content": message.content, "confirmation": message.confirmation}
