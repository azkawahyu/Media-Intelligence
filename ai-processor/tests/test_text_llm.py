"""Regression tests for summarize() output completeness (ADR-006 §11/§12).

Context (recorded evidence, 2026-10-13): at the source's `max_tokens=400` the
provider returned an HTTP 200 with EMPTY assistant content, so the response
never reached the KEYWORDS/CATEGORY lines. The observed production effect was a
summary truncated mid-sentence, `keywords: []`, and `category: "Lainnya"`.

These tests pin the corrected contract:
  - a complete response yields all three fields;
  - an EMPTY response is a controlled TRANSIENT failure, not a silent None;
  - an INCOMPLETE response (any section missing) is a controlled failure, never
    returned as a partial-but-valid result.

`call_openrouter` is stubbed, so no network or API key is needed.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.handlers import openrouter, text_llm  # noqa: E402


@pytest.fixture
def stub_llm(monkeypatch):
    """Enable the LLM and route call_openrouter through a controllable stub."""
    monkeypatch.setattr(text_llm, "is_available", lambda: True)
    captured = {}

    def _set(response):
        def fake(prompt, max_tokens=300):
            captured["prompt"] = prompt
            captured["max_tokens"] = max_tokens
            return response

        monkeypatch.setattr(text_llm, "call_openrouter", fake)
        return captured

    return _set


# ── output budget ───────────────────────────────────────────────────────────

def test_output_budget_is_raised_above_the_truncating_value():
    # 400 was empirically too small (empty response on a real transcript).
    assert text_llm.MAX_SUMMARY_TOKENS >= 800


def test_summarize_requests_the_configured_budget(stub_llm):
    captured = stub_llm(
        "SUMMARY: ringkasan.\nKEYWORDS: kopi, banten\nCATEGORY: Dokumenter"
    )
    text_llm.summarize("transkrip")
    assert captured["max_tokens"] == text_llm.MAX_SUMMARY_TOKENS


# ── complete response ───────────────────────────────────────────────────────

def test_complete_response_returns_all_fields(stub_llm):
    stub_llm(
        "SUMMARY: Video mendokumentasikan kopi Banten Kidul.\n"
        "KEYWORDS: Kopi Banten, Arabika, Robusta\n"
        "CATEGORY: Dokumenter"
    )
    result = text_llm.summarize("transkrip")
    assert result["summary"] == "Video mendokumentasikan kopi Banten Kidul."
    assert result["keywords"] == ["Kopi Banten", "Arabika", "Robusta"]
    assert result["category"] == "Dokumenter"


def test_category_is_normalised_to_the_known_label(stub_llm):
    stub_llm(
        "SUMMARY: s.\nKEYWORDS: a, b\nCATEGORY: dokumenter"
    )
    assert text_llm.summarize("t")["category"] == "Dokumenter"


def test_unknown_category_text_is_preserved(stub_llm):
    stub_llm("SUMMARY: s.\nKEYWORDS: a\nCATEGORY: Kategori Baru")
    assert text_llm.summarize("t")["category"] == "Kategori Baru"


# ── empty response is a controlled failure ──────────────────────────────────

def test_empty_response_raises_transient_not_none(stub_llm):
    stub_llm("")
    with pytest.raises(openrouter.LlmProviderError) as exc:
        text_llm.summarize("transkrip")
    assert exc.value.failure_class == "TRANSIENT"
    assert exc.value.kind == "EMPTY_RESPONSE"


def test_whitespace_only_response_raises(stub_llm):
    stub_llm("   \n  ")
    with pytest.raises(openrouter.LlmProviderError):
        text_llm.summarize("transkrip")


# ── incomplete response is a controlled failure ─────────────────────────────

def test_incomplete_response_missing_category_raises(stub_llm):
    # This is the exact shape observed at the 400-token budget: the third line
    # was cut off.
    stub_llm("SUMMARY: terpotong di tengah kalimat\nKEYWORDS: kopi, banten")
    with pytest.raises(openrouter.LlmProviderError) as exc:
        text_llm.summarize("transkrip")
    assert exc.value.failure_class == "TRANSIENT"
    assert exc.value.kind == "INCOMPLETE_RESPONSE"
    assert "CATEGORY" in str(exc.value)


def test_incomplete_response_missing_keywords_raises(stub_llm):
    stub_llm("SUMMARY: s.\nCATEGORY: Dokumenter")
    with pytest.raises(openrouter.LlmProviderError) as exc:
        text_llm.summarize("transkrip")
    assert "KEYWORDS" in str(exc.value)


def test_incomplete_response_never_returns_partial_dict(stub_llm):
    """A partial response must raise, never yield a half-filled result."""
    stub_llm("SUMMARY: hanya ringkasan saja")
    with pytest.raises(openrouter.LlmProviderError):
        text_llm.summarize("transkrip")


# ── no key: graceful degradation is preserved ───────────────────────────────

def test_no_key_returns_none(monkeypatch):
    monkeypatch.setattr(text_llm, "is_available", lambda: False)
    assert text_llm.summarize("transkrip") is None
