from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    app_name: str = Field(default="GoodMorning MVP Template API", alias="APP_NAME")
    app_env: str = Field(default="local", alias="APP_ENV")
    cors_origins: str = Field(default="http://localhost:5173", alias="CORS_ORIGINS")
    database_url: str = Field(
        default="postgresql+psycopg://goodmorning:goodmorning_local_password@localhost:5432/goodmorning_mvp",
        alias="DATABASE_URL",
    )
    jwt_secret: str = Field(default="local-only-change-this-secret-helloworld-32", alias="JWT_SECRET")
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
    product_id: str = Field(default="helloworld", alias="PRODUCT_ID")
    binance_api_key: str = Field(default="", alias="APIKEY")
    binance_api_secret: str = Field(default="", alias="APISECRET")
    binance_base_url: str = Field(default="https://fapi.binance.com", alias="BINANCE_BASE_URL")
    binance_account_monitor_enabled: bool = Field(default=True, alias="BINANCE_ACCOUNT_MONITOR_ENABLED")
    # Safety gate: account monitoring may run in production, but real order
    # placement must be enabled explicitly in the deployment environment.
    # Real order placement is opt-in per deployment; Paper remains the safe default.
    binance_real_trading_enabled: bool = Field(default=False, alias="BINANCE_REAL_TRADING_ENABLED")
    binance_execution_worker_enabled: bool = Field(default=True, alias="BINANCE_EXECUTION_WORKER_ENABLED")
    production_worker_enabled: bool = Field(default=True, alias="PRODUCTION_WORKER_ENABLED")
    production_worker_live_enabled: bool = Field(default=False, alias="PRODUCTION_WORKER_LIVE_ENABLED")
    production_worker_live_validated: bool = Field(default=False, alias="PRODUCTION_WORKER_LIVE_VALIDATED")
    production_worker_resume_live: bool = Field(default=False, alias="PRODUCTION_WORKER_RESUME_LIVE")
    telegram_bot_token: str = Field(default="", alias="TELEGRAM_BOT_TOKEN")
    telegram_chat_id: str = Field(default="", alias="TELEGRAM_CHAT_ID")
    telegram_enabled: bool = Field(default=True, alias="TELEGRAM_ENABLED")
    telegram_signal_notifications_enabled: bool = Field(default=True, alias="TELEGRAM_SIGNAL_NOTIFICATIONS_ENABLED")
    telegram_min_delay: float = Field(default=0.25, alias="TELEGRAM_MIN_DELAY")
    telegram_commands_enabled: bool = Field(default=True, alias="TELEGRAM_COMMANDS_ENABLED")
    telegram_command_user_id: str = Field(default="", alias="TELEGRAM_COMMAND_USER_ID")
    telegram_command_sender_id: str = Field(default="", alias="TELEGRAM_COMMAND_SENDER_ID")
    binance_execution_poll_seconds: int = Field(default=15, alias="BINANCE_EXECUTION_POLL_SECONDS")
    binance_credentials_encryption_key: str = Field(default="", alias="BINANCE_CREDENTIALS_ENCRYPTION_KEY")
    ctrader_enabled: bool = Field(default=False, alias="CTRADER_ENABLED")
    ctrader_client_id: str = Field(default="", alias="CTRADER_CLIENT_ID")
    ctrader_client_secret: str = Field(default="", alias="CTRADER_CLIENT_SECRET")
    ctrader_host: str = Field(default="demo.ctraderapi.com", alias="CTRADER_HOST")
    ctrader_port: int = Field(default=5035, alias="CTRADER_PORT")
    ctrader_symbols: str = Field(default="AUDUSD,XAUUSD,XAGUSD", alias="CTRADER_SYMBOLS")
    ctrader_redirect_uri: str = Field(default="http://localhost:5173/ctrader/callback", alias="CTRADER_REDIRECT_URI")

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def allowed_origins(self) -> list[str]:
        origins = [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]
        if self.app_env in {"local", "dev", "development"}:
            origins.append("https://dev.helloworld.goodmorning.mx")
        return list(dict.fromkeys(origins))

    @property
    def ctrader_symbol_list(self) -> tuple[str, ...]:
        return tuple(symbol.strip().upper() for symbol in self.ctrader_symbols.split(",") if symbol.strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()
