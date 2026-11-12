"""LLM provider client — single entry point for all LLM calls in the AI processor.

TMIP Phase 14 adaptation of the source module (ADR-006). The endpoint is now
provider-generic: any OpenAI-compatible `/chat/completions` API works, including
OpenRouter (the default), OpenAgentic, or a local gateway.

Configuration precedence (ADR-006 §11, generic-first):
    LLM_BASE_URL  >  OPENROUTER_BASE_URL  >  https://openrouter.ai/api/v1
    LLM_API_KEY   >  OPENROUTER_API_KEY
    LLM_MODEL     >  OPENROUTER_MODEL     >  deepseek/deepseek-chat

The generic `LLM_*` names win when both are set, so a deployment can migrate
without breaking an existing `OPENROUTER_*`-only setup (backward compatible).

Secrets are read from the environment only (ADR-006 finding 11): no key is ever
embedded in source, persisted, or included in an error message. `*_API_KEY` may
be a comma-separated list for rate-limit round-robin.
"""

import os
import time

import httpx

DEFAULT_LLM_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_LLM_MODEL = "deepseek/deepseek-chat"


def _first_set(*names: str) -> str | None:
    """Return the first non-empty environment value among `names`."""
    for name in names:
        value = os.environ.get(name)
        if value is not None and value.strip() != "":
            return value.strip()
    return None


LLM_BASE_URL = (
    _first_set("LLM_BASE_URL", "OPENROUTER_BASE_URL") or DEFAULT_LLM_BASE_URL
).rstrip("/")
# Form the endpoint explicitly so a trailing slash on the base URL can never
# produce `//chat/completions`.
LLM_CHAT_COMPLETIONS_URL = f"{LLM_BASE_URL}/chat/completions"

LLM_MODEL = (
    _first_set("LLM_MODEL", "OPENROUTER_MODEL") or DEFAULT_LLM_MODEL
)

LLM_TIMEOUT = int(_first_set("LLM_TIMEOUT", "OPENROUTER_TIMEOUT") or "60")
LLM_MAX_RETRIES = int(_first_set("LLM_MAX_RETRIES", "OPENROUTER_MAX_RETRIES") or "3")

# Support multiple API keys (comma-separated) for rate-limit round-robin.
_raw_keys = _first_set("LLM_API_KEY", "OPENROUTER_API_KEY") or ""
_api_keys = [key.strip() for key in _raw_keys.split(",") if key.strip()]
_key_index = 0


# ── Error classification (ADR-006 §12) ──────────────────────────────────────
# Provider HTTP status -> failure class. The classification is deliberately
# explicit per status rather than "all provider errors are 503": an auth or
# model error must surface as PERMANENT so it is not retried uselessly, and its
# message must be actionable.
LLM_ERROR_KIND = {
    400: "BAD_REQUEST",
    401: "AUTHENTICATION",
    402: "QUOTA",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    408: "TIMEOUT",
    429: "RATE_LIMITED",
}

# Statuses that are plausibly transient (ADR-006 §6/§12): timeout, rate limit,
# and 5xx. Everything else is permanent.
_TRANSIENT_STATUSES = {408, 429}


def classify_status(status_code: int) -> tuple[str, str]:
    """Map a provider HTTP status to `(kind, class)`.

    `kind` is a stable, human-readable category; `class` is `TRANSIENT` or
    `PERMANENT` and mirrors the TMIP-side failure classification.
    """
    if status_code in LLM_ERROR_KIND:
        kind = LLM_ERROR_KIND[status_code]
    elif 500 <= status_code < 600:
        kind = "PROVIDER_ERROR"
    else:
        kind = "PROVIDER_ERROR"

    if status_code in _TRANSIENT_STATUSES or 500 <= status_code < 600:
        return kind, "TRANSIENT"
    return kind, "PERMANENT"


class LlmProviderError(Exception):
    """A provider call failed. Carries a safe-to-log category and message.

    The message NEVER contains the API key, request headers, or the raw provider
    response body, so it can cross the HTTP boundary and reach TMIP's error
    fields without leaking secrets.
    """

    def __init__(self, kind: str, failure_class: str, message: str, status_code: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.failure_class = failure_class  # "TRANSIENT" | "PERMANENT"
        self.status_code = status_code


def _extract_safe_detail(response: httpx.Response) -> str:
    """Pull a short, sanitized error description from a provider error body.

    Only the provider's `error.message` / `message` / `detail` string is used,
    truncated. The raw body is never echoed, and nothing from request headers
    (which hold the key) is included.
    """
    try:
        data = response.json()
    except Exception:
        return ""

    detail = None
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            detail = error.get("message")
        elif isinstance(error, str):
            detail = error
        if detail is None:
            detail = data.get("message") or data.get("detail")

    if not isinstance(detail, str):
        return ""

    detail = detail.strip().replace("\n", " ")
    return detail[:200]


def _get_api_key() -> str | None:
    """Get the next API key in round-robin fashion."""
    global _key_index
    if not _api_keys:
        return None
    key = _api_keys[_key_index % len(_api_keys)]
    _key_index += 1
    return key


def _extract_content(data: dict) -> str:
    """Pull the assistant text out of an [OI] chat-completions response.

    Content is returned verbatim (no stripping) so streaming chunks keep their
    meaningful tokens — including a trailing space that separates two words.
    """
    choices = data.get("choices") or [{}]
    message = (choices[0] or {}).get("message") or {}
    content = message.get("content")
    return content if isinstance(content, str) else ""


def _parse_success_body(raw_text: str) -> str:
    """Parse a 200 response body into assistant text.

    Providers are not uniform about the success shape: some return a single JSON
    object, some stream newline-delimited `data: {...}` SSE chunks, and a few
    return concatenated JSON objects. A 200 with an unparseable body must not
    crash the endpoint, so each shape is attempted and a clear, typed error is
    raised when none applies (the failure is PERMANENT — retrying identical
    bytes cannot help).
    """
    import json

    stripped = raw_text.strip()
    if stripped == "":
        raise LlmProviderError(
            "INVALID_RESPONSE", "PERMANENT", "LLM provider returned an empty 200 response"
        )

    # Shape 1: a single JSON object.
    try:
        data = json.loads(stripped)
        if isinstance(data, dict):
            return _extract_content(data).strip()
    except json.JSONDecodeError:
        pass

    # Shape 2: SSE / newline-delimited `data: {...}` chunks. Concatenate the
    # content of every chunk (streaming providers split the answer this way).
    pieces: list[str] = []
    saw_json = False
    for line in stripped.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("data:"):
            line = line[len("data:"):].strip()
        if line in ("", "[DONE]"):
            continue
        try:
            chunk = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(chunk, dict):
            saw_json = True
            text = _extract_content(chunk)
            if text:
                pieces.append(text)

    if saw_json:
        return "".join(pieces).strip()

    # Shape 3: concatenated JSON objects with no separators (the provider may
    # append several objects). Decode them sequentially with raw_decode.
    decoder = json.JSONDecoder()
    index = 0
    length = len(stripped)
    while index < length:
        while index < length and stripped[index] in " \t\r\n":
            index += 1
        if index >= length:
            break
        try:
            obj, end = decoder.raw_decode(stripped, index)
        except json.JSONDecodeError:
            break
        if isinstance(obj, dict):
            saw_json = True
            text = _extract_content(obj)
            if text:
                pieces.append(text)
        index = end

    if saw_json:
        return "".join(pieces).strip()

    raise LlmProviderError(
        "INVALID_RESPONSE",
        "PERMANENT",
        "LLM provider returned a 200 response that was not valid JSON",
    )


def call_openrouter(prompt: str, max_tokens: int = 300) -> str | None:
    """Call the configured LLM chat-completions endpoint.

    Kept under its original name for backward compatibility with existing
    callers (`text_llm.summarize`, `ocr.parse_presenter_info`).

    Returns the response text, or None when no API key is configured (graceful
    degradation — ADR-006 §11). Raises `LlmProviderError` when a key IS
    configured but the call fails, so callers can classify the failure instead
    of silently returning None (which previously made every failure look like
    "not configured").
    """
    api_key = _get_api_key()
    if not api_key:
        return None

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://tmip.local",
        "X-Title": "TMIP-AI-Processor",
    }

    payload = {
        "model": LLM_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
    }

    last_error: LlmProviderError | None = None

    for attempt in range(LLM_MAX_RETRIES):
        try:
            with httpx.Client(timeout=LLM_TIMEOUT) as client:
                resp = client.post(LLM_CHAT_COMPLETIONS_URL, json=payload, headers=headers)

                if resp.status_code == 200:
                    # The body may be JSON, SSE, or concatenated JSON depending
                    # on the provider; parse defensively rather than assuming.
                    return _parse_success_body(resp.text)

                kind, failure_class = classify_status(resp.status_code)
                detail = _extract_safe_detail(resp)
                message = f"LLM provider returned HTTP {resp.status_code} ({kind})"
                if detail:
                    message = f"{message}: {detail}"
                last_error = LlmProviderError(
                    kind, failure_class, message, status_code=resp.status_code
                )

                # Only transient failures are retried here; permanent ones
                # (auth/model/quota/bad request) fail fast.
                if failure_class == "TRANSIENT" and attempt < LLM_MAX_RETRIES - 1:
                    time.sleep(min(2 ** (attempt + 1), 30))
                    continue
                raise last_error

        except LlmProviderError:
            raise
        except httpx.TimeoutException as exc:
            last_error = LlmProviderError(
                "TIMEOUT", "TRANSIENT", f"LLM provider request timed out after {LLM_TIMEOUT}s"
            )
            if attempt < LLM_MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
                continue
            raise last_error from exc
        except httpx.HTTPError as exc:
            # Connection/transport failure: transient.
            last_error = LlmProviderError(
                "NETWORK", "TRANSIENT", f"LLM provider unreachable: {type(exc).__name__}"
            )
            if attempt < LLM_MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
                continue
            raise last_error from exc

    # Unreachable in practice (the loop either returns or raises), but keeps the
    # contract explicit if retries are configured to zero.
    if last_error is not None:
        raise last_error
    return None


def is_available() -> bool:
    """Check whether an LLM API key is configured."""
    return len(_api_keys) > 0
