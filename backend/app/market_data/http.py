"""The one place this application talks to the internet.

Retries are deliberately narrow. Retrying a 400 is pointless and retrying a
non-idempotent call is dangerous; only transport failures, 5xx, and explicit
rate limits are worth a second attempt. Everything else fails immediately so
the real error is visible instead of being buried under three timeouts.
"""

from __future__ import annotations

import asyncio
import random
from typing import Any

import httpx

from app.core.errors import (
    MalformedUpstreamResponse,
    ProviderRateLimitedError,
    ProviderUnavailableError,
)
from app.core.logging import get_logger

logger = get_logger(__name__)

RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


class HttpClient:
    """A thin, retrying JSON client bound to one upstream base URL."""

    def __init__(
        self,
        base_url: str,
        *,
        provider: str,
        timeout: float = 10.0,
        max_retries: int = 3,
        backoff: float = 0.5,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.provider = provider
        self._max_retries = max(1, max_retries)
        self._backoff = backoff
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(timeout),
            transport=transport,
            headers={"Accept": "application/json", "User-Agent": "alslmany-paper-trading/0.1"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        last_error: Exception | None = None

        for attempt in range(1, self._max_retries + 1):
            try:
                response = await self._client.get(path, params=params)
            except httpx.HTTPError as exc:
                # Transport-level: DNS, connect, read timeout, TLS. Worth retrying.
                last_error = ProviderUnavailableError(
                    f"{self.provider}: {type(exc).__name__} contacting upstream.",
                    provider=self.provider,
                    path=path,
                )
                logger.warning(
                    "market data transport failure",
                    extra={
                        "provider": self.provider,
                        "path": path,
                        "attempt": attempt,
                        "error": type(exc).__name__,
                    },
                )
            else:
                if response.status_code == 429:
                    last_error = ProviderRateLimitedError(
                        f"{self.provider} rate limited this deployment.",
                        provider=self.provider,
                        retry_after=response.headers.get("Retry-After"),
                    )
                    logger.warning(
                        "market data rate limited",
                        extra={"provider": self.provider, "path": path, "attempt": attempt},
                    )
                elif response.status_code in RETRYABLE_STATUS:
                    last_error = ProviderUnavailableError(
                        f"{self.provider} returned HTTP {response.status_code}.",
                        provider=self.provider,
                        status_code=response.status_code,
                    )
                elif response.is_error:
                    # 4xx that is not a rate limit: our request is wrong, or the
                    # symbol does not exist upstream. Retrying cannot help.
                    raise ProviderUnavailableError(
                        f"{self.provider} rejected the request with HTTP {response.status_code}.",
                        provider=self.provider,
                        status_code=response.status_code,
                    )
                else:
                    try:
                        return response.json()
                    except ValueError as exc:
                        # A 200 that is not JSON is usually a captive portal or
                        # an error page. Never retried: the contract is broken.
                        raise MalformedUpstreamResponse(
                            f"{self.provider} returned a non-JSON body.",
                            provider=self.provider,
                            path=path,
                        ) from exc

            if attempt < self._max_retries:
                await asyncio.sleep(self._delay(attempt))

        assert last_error is not None
        raise last_error

    def _delay(self, attempt: int) -> float:
        """Exponential backoff with jitter.

        The jitter matters more than the exponent here: without it, every
        worker that failed on the same upstream blip retries in the same
        millisecond and reproduces the blip.
        """
        return self._backoff * (2 ** (attempt - 1)) * (0.5 + random.random())
