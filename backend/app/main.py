from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Literal
from openai import AsyncOpenAI

from gm_agent import AgentService, Conversation, OpenAIProvider
from gm_agent.providers import ChatProvider, ProviderResponse
from gm_auth import AuthService, AuthSettings, create_auth_router, identity_dependency
from gm_auth.models import AuthIdentity
from gm_mcp import Permission, RequestContext, ToolRegistry, tool

from app.config import get_settings
from app.database import create_database_engine
from app.binance_credentials import BinanceCredentialStore, BinanceMonitorManager
from app.paper_operations import PaperOperationStore

settings = get_settings()
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
paper_operation_store = PaperOperationStore(engine)


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


def _backtest(*, context: RequestContext, symbol: str, strategy: str, days: int = 30) -> dict[str, object]:
    days = max(1, min(days, 365))
    return {
        "mode": "paper",
        "symbol": symbol.upper(),
        "strategy": strategy,
        "days": days,
        "trades": max(1, days // 3),
        "win_rate": 0.58,
        "net_pnl": 124.50,
        "max_drawdown": -48.20,
        "message": "Resultado demostrativo; conecta el motor histórico real en la siguiente iteración.",
    }


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
    input_schema={"type": "object", "properties": {"symbol": {"type": "string"}, "strategy": {"type": "string"}, "days": {"type": "integer"}}, "required": ["symbol", "strategy"]},
    permission=Permission.READ,
    permissions={"read"},
)(_backtest))
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
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
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


class BinanceCredentialsInput(BaseModel):
    api_key: str = Field(min_length=10, max_length=256)
    api_secret: str = Field(min_length=10, max_length=256)


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
    status: Literal["OPEN", "CLOSED - WIN", "CLOSED - FAILED"] = "OPEN"
    close_reason: Literal["TP", "SL"] | None = None


@app.on_event("startup")
def initialize_auth_schema() -> None:
    auth_service.create_schema()


@app.on_event("shutdown")
def stop_binance_monitor() -> None:
    binance_manager.stop_all()


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
        raise HTTPException(status_code=404, detail="Open paper operation not found.")
    return {"deleted": True}


@app.get("/trading/binance")
def binance_account(identity: AuthIdentity = Depends(identity_dependency(auth_service))) -> dict[str, object]:
    if not settings.binance_account_monitor_enabled:
        return {"enabled": False, "configured": False, "healthy": False, "error": "Monitor Binance deshabilitado"}
    return binance_manager.snapshot(identity.user_id)


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
