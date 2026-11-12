"""Tests for LLM provider config precedence and error classification (ADR-006 §12).

Runs without network access: `httpx` is stubbed. Verifies that failures are
classified by HTTP status rather than collapsed into one generic error, and
that a message never leaks the API key.
"""

import importlib
import os
import sys
import types

import pytest


def _fresh_openrouter(monkeypatch, env: dict):
    """Import the module fresh with a controlled environment."""
    for key in (
        "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL",
        "OPENROUTER_BASE_URL", "OPENROUTER_API_KEY", "OPENROUTER_MODEL",
        "LLM_TIMEOUT", "LLM_MAX_RETRIES",
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    sys.modules.pop("app.handlers.openrouter", None)
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    return importlib.import_module("app.handlers.openrouter")


# ── Configuration precedence ────────────────────────────────────────────────

def test_generic_names_take_precedence_over_legacy(monkeypatch):
    mod = _fresh_openrouter(monkeypatch, {
        "LLM_BASE_URL": "https://openagentic.id/api/v1",
        "OPENROUTER_BASE_URL": "https://openrouter.ai/api/v1",
        "LLM_MODEL": "deepseek-v4-flash",
        "OPENROUTER_MODEL": "deepseek/deepseek-chat",
        "LLM_API_KEY": "k1",
    })
    assert mod.LLM_BASE_URL == "https://openagentic.id/api/v1"
    assert mod.LLM_MODEL == "deepseek-v4-flash"


def test_legacy_names_still_work(monkeypatch):
    mod = _fresh_openrouter(monkeypatch, {
        "OPENROUTER_API_KEY": "legacy-key",
        "OPENROUTER_MODEL": "openrouter/model",
    })
    assert mod.LLM_BASE_URL == "https://openrouter.ai/api/v1"  # default
    assert mod.LLM_MODEL == "openrouter/model"
    assert mod.is_available() is True


def test_url_has_no_double_slash(monkeypatch):
    mod = _fresh_openrouter(monkeypatch, {"LLM_BASE_URL": "https://x.test/api/v1/"})
    assert mod.LLM_CHAT_COMPLETIONS_URL == "https://x.test/api/v1/chat/completions"
    assert "//chat" not in mod.LLM_CHAT_COMPLETIONS_URL


def test_no_key_means_unavailable(monkeypatch):
    mod = _fresh_openrouter(monkeypatch, {})
    assert mod.is_available() is False


# ── Status classification ───────────────────────────────────────────────────

@pytest.mark.parametrize("status,expected_class", [
    (400, "PERMANENT"),
    (401, "PERMANENT"),
    (402, "PERMANENT"),
    (403, "PERMANENT"),
    (404, "PERMANENT"),
    (408, "TRANSIENT"),
    (429, "TRANSIENT"),
    (500, "TRANSIENT"),
    (502, "TRANSIENT"),
    (503, "TRANSIENT"),
])
def test_classify_status(monkeypatch, status, expected_class):
    mod = _fresh_openrouter(monkeypatch, {"LLM_API_KEY": "k"})
    _kind, cls = mod.classify_status(status)
    assert cls == expected_class


def test_auth_error_is_not_503(monkeypatch):
    """A 401 must be PERMANENT so a bad key is not retried as if transient."""
    mod = _fresh_openrouter(monkeypatch, {"LLM_API_KEY": "k"})
    kind, cls = mod.classify_status(401)
    assert kind == "AUTHENTICATION"
    assert cls == "PERMANENT"


# ── Failures raise a typed, sanitized error ─────────────────────────────────

class _Resp:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload

    @property
    def text(self):
        import json as _json
        if isinstance(self._payload, str):
            return self._payload
        return _json.dumps(self._payload)

    def json(self):
        return self._payload


class _Client:
    def __init__(self, resp, **_):
        self._resp = resp

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def post(self, *a, **k):
        return self._resp


def _install_httpx(monkeypatch, mod, resp):
    fake = types.ModuleType("httpx")
    fake.Client = lambda **kw: _Client(resp)
    fake.TimeoutException = type("TimeoutException", (Exception,), {})
    fake.HTTPError = type("HTTPError", (Exception,), {})
    monkeypatch.setattr(mod, "httpx", fake)


def test_auth_failure_raises_permanent_error_without_leaking_key(monkeypatch):
    mod = _fresh_openrouter(monkeypatch, {"LLM_API_KEY": "sk-super-secret-value"})
    _install_httpx(monkeypatch, mod, _Resp(401, {"error": {"message": "Missing Authentication header"}}))

    with pytest.raises(mod.LlmProviderError) as excinfo:
        mod.call_openrouter("hi")

    err = excinfo.value
    assert err.failure_class == "PERMANENT"
    assert err.kind == "AUTHENTICATION"
    # The key must never appear in the message.
    assert "sk-super-secret-value" not in str(err)
    assert "Missing Authentication header" in str(err)


def test_quota_failure_is_permanent(monkeypatch):
    mod = _fresh_openrouter(monkeypatch, {"LLM_API_KEY": "k"})
    _install_httpx(monkeypatch, mod, _Resp(402, {"error": {"message": "Insufficient credits"}}))
    with pytest.raises(mod.LlmProviderError) as excinfo:
        mod.call_openrouter("hi")
    assert excinfo.value.failure_class == "PERMANENT"
    assert excinfo.value.kind == "QUOTA"


def test_success_returns_content(monkeypatch):
    mod = _fresh_openrouter(monkeypatch, {"LLM_API_KEY": "k"})
    _install_httpx(monkeypatch, mod, _Resp(200, {
        "choices": [{"message": {"content": "  hasil ringkasan  "}}],
    }))
    assert mod.call_openrouter("hi") == "hasil ringkasan"


def test_missing_key_returns_none_not_error(monkeypatch):
    mod = _fresh_openrouter(monkeypatch, {})
    assert mod.call_openrouter("hi") is None


# ── Success-body shapes (providers are not uniform) ─────────────────────────

def test_parses_single_json_object(monkeypatch):
    mod = _fresh_openrouter(monkeypatch, {"LLM_API_KEY": "k"})
    body = '{"choices":[{"message":{"content":"ringkasan"}}]}'
    assert mod._parse_success_body(body) == "ringkasan"


def test_parses_sse_data_chunks(monkeypatch):
    mod = _fresh_openrouter(monkeypatch, {"LLM_API_KEY": "k"})
    body = (
        'data: {"choices":[{"message":{"content":"Halo "}}]}\n'
        'data: {"choices":[{"message":{"content":"dunia"}}]}\n'
        "data: [DONE]\n"
    )
    assert mod._parse_success_body(body) == "Halo dunia"


def test_parses_concatenated_json_objects(monkeypatch):
    """The real OpenAgentic body was concatenated JSON (JSONDecodeError: Extra data)."""
    mod = _fresh_openrouter(monkeypatch, {"LLM_API_KEY": "k"})
    body = '{"choices":[{"message":{"content":"A"}}]}{"choices":[{"message":{"content":"B"}}]}'
    assert mod._parse_success_body(body) == "AB"


def test_empty_200_body_is_a_permanent_error(monkeypatch):
    mod = _fresh_openrouter(monkeypatch, {"LLM_API_KEY": "k"})
    with pytest.raises(mod.LlmProviderError) as excinfo:
        mod._parse_success_body("")
    assert excinfo.value.failure_class == "PERMANENT"


def test_non_json_200_body_is_a_permanent_error(monkeypatch):
    mod = _fresh_openrouter(monkeypatch, {"LLM_API_KEY": "k"})
    with pytest.raises(mod.LlmProviderError) as excinfo:
        mod._parse_success_body("<html>gateway error</html>")
    assert excinfo.value.failure_class == "PERMANENT"


def test_non_json_200_never_raises_jsondecodeerror(monkeypatch):
    """Regression: a 200 with a non-JSON body must not surface a raw JSONDecodeError."""
    mod = _fresh_openrouter(monkeypatch, {"LLM_API_KEY": "k"})
    _install_httpx(monkeypatch, mod, _Resp(200, "<html>not json</html>"))
    # _Resp.json() returns the string; the code path uses resp.text instead, so
    # provide it here to exercise the defensive parser through the real caller.
    with pytest.raises(mod.LlmProviderError):
        mod.call_openrouter("hi")
