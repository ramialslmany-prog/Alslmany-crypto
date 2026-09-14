"""Domain errors and the HTTP shape they take.

The distinction that matters in this system is between *we could not get the
data* and *the data says no*. A platform that renders both as a generic 500
teaches its operator to ignore errors, and an analysis engine that cannot tell
them apart will eventually trade on a value it should have refused.

Every error therefore carries a stable machine-readable ``code`` alongside the
human message, and upstream failures are explicitly not the client's fault.
"""

from __future__ import annotations

from typing import Any

from fastapi import Request, status
from fastapi.responses import JSONResponse


class AppError(Exception):
    """Base for every error this application raises deliberately."""

    code = "internal_error"
    http_status = status.HTTP_500_INTERNAL_SERVER_ERROR
    message = "An unexpected error occurred."

    def __init__(self, message: str | None = None, **details: Any) -> None:
        self.message = message or self.message
        self.details = details
        super().__init__(self.message)

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"error": {"code": self.code, "message": self.message}}
        if self.details:
            payload["error"]["details"] = self.details
        return payload


# --- client errors -------------------------------------------------------


class NotFoundError(AppError):
    code = "not_found"
    http_status = status.HTTP_404_NOT_FOUND
    message = "The requested resource does not exist."


class ValidationError(AppError):
    code = "validation_error"
    http_status = 422  # literal: the starlette constant was renamed mid-2.x
    message = "The request was not valid."


class UnsupportedSymbolError(NotFoundError):
    code = "unsupported_symbol"
    message = "That symbol is not tracked by this deployment."


class UnsupportedTimeframeError(ValidationError):
    code = "unsupported_timeframe"
    message = "That timeframe is not supported."


# --- upstream / data-availability errors ---------------------------------


class MarketDataError(AppError):
    """Base for anything that went wrong reaching or trusting an exchange."""

    code = "market_data_error"
    http_status = status.HTTP_502_BAD_GATEWAY
    message = "Market data could not be retrieved."


class ProviderUnavailableError(MarketDataError):
    code = "provider_unavailable"
    message = "The market data provider could not be reached."


class ProviderRateLimitedError(MarketDataError):
    code = "provider_rate_limited"
    http_status = status.HTTP_429_TOO_MANY_REQUESTS
    message = "The market data provider is rate limiting this deployment."


class MalformedUpstreamResponse(MarketDataError):
    """The provider answered, but not with something we are willing to trust.

    This is kept distinct from a transport failure on purpose: a parse failure
    means the contract changed, which is an alert, not a retry.
    """

    code = "malformed_upstream_response"
    message = "The market data provider returned a response we cannot trust."


class NoMarketDataError(MarketDataError):
    """Every configured provider failed.

    This is the error the rest of the platform is built to respect. Stage 5
    onward must treat it as a hard stop on opening new positions rather than as
    a reason to fall back on a stale or invented number.
    """

    code = "no_reliable_market_data"
    http_status = status.HTTP_503_SERVICE_UNAVAILABLE
    message = "Insufficient reliable market data."


class StaleMarketDataError(NoMarketDataError):
    code = "stale_market_data"
    message = "Insufficient reliable market data: the most recent quote is too old to trust."


# --- handlers ------------------------------------------------------------


async def app_error_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, AppError)
    return JSONResponse(status_code=exc.http_status, content=exc.to_payload())


async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Last resort.

    The message is deliberately generic: an unhandled exception may carry a
    connection string or an API key in its text, and this response is public.
    The full traceback goes to the log, which is not.
    """
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"error": {"code": "internal_error", "message": "An unexpected error occurred."}},
    )
