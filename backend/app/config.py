"""Application configuration, resolved once from the environment.

Every tunable lives here rather than being read from ``os.environ`` at the
point of use, so the full configuration surface of the system is one file long
and a missing or malformed value fails at startup instead of at 3am inside a
background worker.

Secrets are read from the environment only. Nothing in this module is ever
serialised to a client — see ``safe_summary()`` for what may be exposed.
"""

from __future__ import annotations

from decimal import Decimal
from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# The starting universe. Stage 1 ships five; adding a sixth is one entry here
# plus a row in the `coins` table, with no code change anywhere else.
DEFAULT_SYMBOLS: tuple[str, ...] = (
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "BNBUSDT",
    "XRPUSDT",
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ---- identity -------------------------------------------------------
    app_name: str = "Alslmany Paper Trading"
    environment: Literal["development", "test", "production"] = "development"
    debug: bool = False

    # ---- safety ---------------------------------------------------------
    # This is a paper-trading system. The flag exists so that the guarantee is
    # *checkable at runtime* rather than merely documented, and so any future
    # execution adapter has a single switch to interrogate. Nothing in this
    # codebase reads it expecting `False`.
    paper_trading_only: Literal[True] = True

    # ---- database -------------------------------------------------------
    # PostgreSQL is the production target. SQLite is permitted so the suite and
    # a local run need no server; the URL decides, and the code path is identical.
    database_url: str = "sqlite+aiosqlite:///./alslmany.db"
    database_echo: bool = False

    # ---- market data ----------------------------------------------------
    market_data_providers: str = "binance,okx"
    market_data_timeout_seconds: float = 10.0
    market_data_max_retries: int = 3
    market_data_backoff_seconds: float = 0.5
    # How long a quote may be served from cache before it is refetched.
    ticker_cache_seconds: float = 5.0
    candle_cache_seconds: float = 15.0
    orderbook_cache_seconds: float = 2.0
    # A quote older than this is not "slightly stale", it is unusable.
    max_quote_age_seconds: float = 90.0

    # Overridable so a deployment can use a regional mirror (Binance publishes
    # data-api.binance.vision for market data) or point at a local stub.
    binance_base_url: str = "https://api.binance.com"
    okx_base_url: str = "https://www.okx.com"

    symbols: str = ",".join(DEFAULT_SYMBOLS)

    # ---- paper trading defaults (consumed from Stage 5 onward) ----------
    initial_balance_usdt: Decimal = Decimal("10000")
    risk_per_trade_pct: Decimal = Decimal("1")
    max_open_trades: int = 5
    max_daily_loss_pct: Decimal = Decimal("3")
    max_drawdown_pct: Decimal = Decimal("10")
    # The cap `max_open_trades` only appears to provide. Five positions at 1%
    # each are a 5% bet when they are correlated, and in crypto they usually
    # are; this bounds the COMBINED loss of a joint adverse move.
    max_portfolio_heat_pct: Decimal = Decimal("2.5")

    # ---- AI provider (Stage 4; keys never reach the frontend) -----------
    ai_provider: str = "anthropic"
    ai_api_key: str | None = Field(default=None, repr=False)
    ai_model: str = "claude-sonnet-4-5"

    market_data_api_key: str | None = Field(default=None, repr=False)

    # Guards the bot tick endpoint. Unset means the endpoint is open, which is
    # acceptable for a local run and is not for a deployment — so the readiness
    # summary reports whether it is configured.
    cron_secret: str | None = Field(default=None, repr=False)

    # ---- http -----------------------------------------------------------
    cors_origins: str = "*"

    @field_validator("symbols", "market_data_providers", "cors_origins")
    @classmethod
    def _reject_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("must not be empty")
        return v

    @field_validator("initial_balance_usdt")
    @classmethod
    def _positive_balance(cls, v: Decimal) -> Decimal:
        if v <= 0:
            raise ValueError("initial_balance_usdt must be positive")
        return v

    @field_validator(
        "risk_per_trade_pct",
        "max_daily_loss_pct",
        "max_drawdown_pct",
        "max_portfolio_heat_pct",
    )
    @classmethod
    def _sane_percentage(cls, v: Decimal) -> Decimal:
        if not (0 < v <= 100):
            raise ValueError("percentage must be in (0, 100]")
        return v

    @field_validator("max_open_trades")
    @classmethod
    def _positive_int(cls, v: int) -> int:
        if v < 1:
            raise ValueError("max_open_trades must be at least 1")
        return v

    # ---- derived --------------------------------------------------------
    @property
    def symbol_list(self) -> list[str]:
        return [s.strip().upper() for s in self.symbols.split(",") if s.strip()]

    @property
    def provider_list(self) -> list[str]:
        return [p.strip().lower() for p in self.market_data_providers.split(",") if p.strip()]

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    def safe_summary(self) -> dict[str, object]:
        """Configuration that is safe to expose over the API.

        Deliberately enumerated rather than filtered by name, so adding a
        secret to this class cannot leak it by forgetting a denylist entry.
        """
        return {
            "app_name": self.app_name,
            "environment": self.environment,
            "paper_trading_only": self.paper_trading_only,
            "symbols": self.symbol_list,
            "providers": self.provider_list,
            "initial_balance_usdt": str(self.initial_balance_usdt),
            "risk_per_trade_pct": str(self.risk_per_trade_pct),
            "max_open_trades": self.max_open_trades,
            "max_daily_loss_pct": str(self.max_daily_loss_pct),
            "max_drawdown_pct": str(self.max_drawdown_pct),
            "max_portfolio_heat_pct": str(self.max_portfolio_heat_pct),
            "ai_provider": self.ai_provider,
            "ai_configured": self.ai_api_key is not None,
            "bot_endpoint_protected": self.cron_secret is not None,
        }


@lru_cache
def get_settings() -> Settings:
    return Settings()
