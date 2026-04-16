import asyncio
import random
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Iterable, Optional, Tuple

import aiohttp

# HTTP statuses that are typically transient and safe to retry.
DEFAULT_TRANSIENT_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})

# Provider-side messages frequently used for quota/rate limiting.
DEFAULT_RATE_LIMIT_KEYWORDS = (
    "429",
    "quota",
    "rate",
    "too many",
    "overforbruk",
    "vent litt",
)

# Conservative default timeout profile for elevation providers.
DEFAULT_TIMEOUT = aiohttp.ClientTimeout(
    total=45,
    connect=10,
    sock_connect=10,
    sock_read=30,
)


def make_timeout(
    *,
    total: float = 45,
    connect: float = 10,
    sock_connect: float = 10,
    sock_read: float = 30,
) -> aiohttp.ClientTimeout:
    """Return a reusable aiohttp timeout profile."""
    return aiohttp.ClientTimeout(
        total=total,
        connect=connect,
        sock_connect=sock_connect,
        sock_read=sock_read,
    )


def body_snippet(body: bytes, limit: int = 300) -> str:
    """Decode response body safely for logs/errors."""
    if not body:
        return ""
    text = body.decode("utf-8", errors="replace")
    text = text.replace("\r", " ").replace("\n", " ").strip()
    return text[:limit]


def _parse_retry_after_seconds(headers) -> Optional[float]:
    """Parse Retry-After header as seconds (delta or HTTP date)."""
    if not headers:
        return None
    raw = headers.get("Retry-After")
    if not raw:
        return None

    raw = raw.strip()
    try:
        seconds = float(raw)
        return max(0.0, min(seconds, 120.0))
    except ValueError:
        pass

    try:
        dt = parsedate_to_datetime(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        seconds = (dt - now).total_seconds()
        return max(0.0, min(seconds, 120.0))
    except Exception:
        return None


def _should_retry_from_body(
    content_type: str,
    body: bytes,
    retry_body_keywords: Iterable[str],
) -> bool:
    if not body:
        return False
    ct = (content_type or "").lower()
    if not any(kind in ct for kind in ("xml", "html", "text", "json")):
        return False

    text = body.decode("utf-8", errors="ignore").lower()
    return any(keyword.lower() in text for keyword in retry_body_keywords)


def _backoff_seconds(
    *,
    attempt: int,
    base_delay: float,
    max_delay: float,
    jitter: float,
    retry_after_s: Optional[float],
) -> float:
    if retry_after_s is not None:
        return retry_after_s
    exp = base_delay * (2 ** attempt)
    capped = min(exp, max_delay)
    if jitter <= 0:
        return capped
    return capped + random.uniform(0.0, jitter)


async def request_with_retry(
    session: aiohttp.ClientSession,
    method: str,
    url: str,
    *,
    params=None,
    data=None,
    headers=None,
    timeout: Optional[aiohttp.ClientTimeout] = None,
    max_attempts: int = 3,
    transient_statuses: Optional[Iterable[int]] = None,
    retry_body_keywords: Optional[Iterable[str]] = None,
    base_delay: float = 1.5,
    max_delay: float = 12.0,
    jitter: float = 0.35,
    verbose: bool = False,
    log_prefix: str = "HTTP",
) -> Tuple[int, bytes, str, str]:
    """Perform an HTTP request with retry logic for transient failures.

    Returns: (status_code, body_bytes, final_request_url, content_type_lower)
    Raises last network exception after final attempt.
    """
    statuses = set(transient_statuses or DEFAULT_TRANSIENT_STATUSES)
    keywords = tuple(retry_body_keywords or DEFAULT_RATE_LIMIT_KEYWORDS)
    req_timeout = timeout or DEFAULT_TIMEOUT

    for attempt in range(max_attempts):
        try:
            async with session.request(
                method,
                url,
                params=params,
                data=data,
                headers=headers,
                timeout=req_timeout,
            ) as resp:
                body = await resp.read()
                content_type = (resp.content_type or "").lower()
                status = resp.status
                req_url = str(resp.url)

                should_retry = status in statuses
                if not should_retry and status == 200:
                    should_retry = _should_retry_from_body(content_type, body, keywords)

                if should_retry and attempt < max_attempts - 1:
                    wait = _backoff_seconds(
                        attempt=attempt,
                        base_delay=base_delay,
                        max_delay=max_delay,
                        jitter=jitter,
                        retry_after_s=_parse_retry_after_seconds(resp.headers),
                    )
                    if verbose:
                        print(
                            f"    [{log_prefix}] transient response {status}, "
                            f"retrying in {wait:.1f}s "
                            f"(attempt {attempt + 1}/{max_attempts})"
                        )
                    await asyncio.sleep(wait)
                    continue

                return status, body, req_url, content_type

        except (
            aiohttp.ClientConnectionError,
            aiohttp.ClientPayloadError,
            aiohttp.ClientOSError,
            aiohttp.ServerTimeoutError,
            asyncio.TimeoutError,
        ) as exc:
            if attempt >= max_attempts - 1:
                raise
            wait = _backoff_seconds(
                attempt=attempt,
                base_delay=base_delay,
                max_delay=max_delay,
                jitter=jitter,
                retry_after_s=None,
            )
            if verbose:
                print(
                    f"    [{log_prefix}] network/timeout error ({type(exc).__name__}), "
                    f"retrying in {wait:.1f}s "
                    f"(attempt {attempt + 1}/{max_attempts})"
                )
            await asyncio.sleep(wait)

    # Unreachable because return/raise occurs in loop; defensive fallback.
    return 599, b"", url, ""
