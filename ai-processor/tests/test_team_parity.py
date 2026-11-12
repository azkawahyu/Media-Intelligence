"""Team-repository parity tests for the AI text pipeline.

Purpose (integration brief §3, §5): prove that TMIP's text-enrichment pipeline
is semantically equivalent to the team repository that produced the accepted
output, using the team repository itself as a *traceable* source of truth —
not hand-copied expectations.

What is compared, and the file each side is read from:

  criterion                     team source (truth)                TMIP source
  ----------------------------  ---------------------------------  ----------------------------------
  Whisper inference params      ai-processor/app/handlers/         ai-processor/app/handlers/
                                transcribe.py                      transcribe.py
  Content categories            ai-processor/app/handlers/         ai-processor/app/handlers/
                                text_llm.py                        text_llm.py
  Summarize prompt template     ai-processor/app/handlers/         ai-processor/app/handlers/
                                text_llm.py                        text_llm.py
  Response field shapes         backend/src/lib/ai-client.ts       apps/api/src/ai/adapter.ts
  Pipeline stage order          backend/src/workers/handlers/      apps/api/src/ai/runner.ts
                                {transcribe,summarize,ocr}.ts

The team repository is located via `TEAM_REPO_PATH` (default
`D:/DEVELOP/tvri-media-intelligence-platform`). When it is absent the whole
module skips with a recorded reason — matching TMIP's env-gated test pattern
(TESTING.md §"external dependencies must be mockable") rather than failing.

This is a CONTRACT/CONFIGURATION parity suite. It does not and cannot prove
live output/quality parity: that requires running both pipelines on the same
media with a real LLM key (see the integration report's parity status).

Deliberate, documented divergences (asserted below so they cannot silently
grow): TMIP adds multi-frame OCR sampling (ADR-006 §20) and a provider-generic
LLM client with per-status error classification (ADR-006 §11/§12).
"""

import ast
import os
import re
import sys
from pathlib import Path

import pytest

TEAM_REPO = Path(os.environ.get("TEAM_REPO_PATH", "D:/DEVELOP/tvri-media-intelligence-platform"))
TMIP_ROOT = Path(__file__).resolve().parents[2]

TEAM_AI = TEAM_REPO / "ai-processor" / "app"
TMIP_AI = TMIP_ROOT / "ai-processor" / "app"
TEAM_BACKEND = TEAM_REPO / "backend" / "src"

pytestmark = pytest.mark.skipif(
    not TEAM_REPO.exists(),
    reason=f"team repository not found at {TEAM_REPO} (set TEAM_REPO_PATH to run parity tests)",
)


# ── helpers ─────────────────────────────────────────────────────────────────

def _read(path: Path) -> str:
    """Read a source file as LF-normalized text (CRLF must not fail parity)."""
    return path.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")


def _extract_list_literal(source: str, name: str) -> list[str]:
    """Return the literal list assigned to `name = [...]` (via ast, no import)."""
    tree = ast.parse(source)
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == name:
                    return ast.literal_eval(node.value)
    raise AssertionError(f"{name} assignment not found")


def _prompt_block(source: str) -> str:
    """Return the normalized `prompt = ( ... )` block, whitespace-trimmed."""
    match = re.search(r"prompt = \((.*?)\n\s*\)", source, re.DOTALL)
    assert match is not None, "prompt = ( ... ) block not found"
    lines = [line.rstrip() for line in match.group(1).split("\n")]
    return "\n".join(line for line in lines if line.strip() != "").strip()


def _interface_fields(source: str, interface_name: str) -> set[str]:
    """Return top-level field names of a TS `export interface <name> { ... }`."""
    match = re.search(
        rf"export interface {interface_name}\s*\{{(.*?)\n\}}", source, re.DOTALL
    )
    assert match is not None, f"interface {interface_name} not found"
    fields: set[str] = set()
    for line in match.group(1).split("\n"):
        field = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:", line)
        if field:
            fields.add(field.group(1))
    return fields


def _zod_object_fields(source: str, const_name: str) -> set[str]:
    """Return the keys of a TS `z.object({ ... })` assigned to `const_name`."""
    match = re.search(
        rf"const {const_name}\s*=\s*z\.object\(\{{(.*?)\n\}}\)", source, re.DOTALL
    )
    assert match is not None, f"z.object for {const_name} not found"
    fields: set[str] = set()
    for line in match.group(1).split("\n"):
        field = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*:", line)
        if field:
            fields.add(field.group(1))
    return fields


# ── Whisper inference parameters ────────────────────────────────────────────

def test_whisper_inference_params_parity():
    """Same model default, beam size, and word_timestamps on both sides."""
    team = _read(TEAM_AI / "handlers" / "transcribe.py")
    tmip = _read(TMIP_AI / "handlers" / "transcribe.py")

    def params(source: str) -> dict:
        call = re.search(r"\.transcribe\((.*?)\)", source, re.DOTALL)
        assert call is not None, "model.transcribe(...) call not found"
        body = call.group(1)
        return {
            "beam_size": re.search(r"beam_size=(\d+)", body).group(1),
            "word_timestamps": re.search(r"word_timestamps=(\w+)", body).group(1),
        }

    assert params(team) == params(tmip) == {"beam_size": "5", "word_timestamps": "False"}

    # The default model size is the same on both sides (the caller may override).
    team_default = re.search(r"def start_background_transcribe\(.*?model_size: str = \"(\w+)\"", team, re.DOTALL)
    tmip_default = re.search(r"def start_background_transcribe\(.*?model_size: str = \"(\w+)\"", tmip, re.DOTALL)
    assert team_default.group(1) == tmip_default.group(1) == "medium"


# ── Content categories ──────────────────────────────────────────────────────

def test_content_categories_parity():
    """The classification label set is identical (drives category output)."""
    team = _extract_list_literal(_read(TEAM_AI / "handlers" / "text_llm.py"), "CONTENT_CATEGORIES")
    tmip = _extract_list_literal(_read(TMIP_AI / "handlers" / "text_llm.py"), "CONTENT_CATEGORIES")
    assert team == tmip
    assert "Lainnya" in tmip


# ── Summarize prompt template ───────────────────────────────────────────────

def test_summarize_prompt_parity():
    """The summarize prompt template is byte-identical (after LF normalization)."""
    team = _prompt_block(_read(TEAM_AI / "handlers" / "text_llm.py"))
    tmip = _prompt_block(_read(TMIP_AI / "handlers" / "text_llm.py"))
    assert team == tmip


# ── Response field shapes (Python processor vs team Node contract) ──────────

def test_summarize_response_contract_parity():
    """`/summarize` returns exactly the fields the team client expects."""
    team = _interface_fields(_read(TEAM_BACKEND / "lib" / "ai-client.ts"), "SummarizeResult")
    tmip = _zod_object_fields(_read(TMIP_ROOT / "apps" / "api" / "src" / "ai" / "adapter.ts"), "summarizeResultSchema")
    assert team == {"summary", "keywords", "category"}
    assert team <= tmip


def test_transcription_response_contract_parity():
    """`/transcribe/result` fields are a superset of the team contract."""
    team = _interface_fields(_read(TEAM_BACKEND / "lib" / "ai-client.ts"), "TranscribeResult")
    tmip = _zod_object_fields(
        _read(TMIP_ROOT / "apps" / "api" / "src" / "ai" / "adapter.ts"),
        "transcriptionResultSchema",
    )
    assert team == {"segments", "full_text", "duration_sec", "language"}
    # TMIP keeps every team field; extra TMIP fields are optional/additive.
    assert team <= tmip


def test_ocr_response_contract_parity():
    """`/ocr` keeps the team fields; TMIP adds only optional diagnostics."""
    team = _interface_fields(_read(TEAM_BACKEND / "lib" / "ai-client.ts"), "OcrResult")
    tmip = _zod_object_fields(_read(TMIP_ROOT / "apps" / "api" / "src" / "ai" / "adapter.ts"), "ocrResultSchema")
    assert team == {"raw_text", "presenter"}
    assert team <= tmip
    # The only additions are the ADR-006 §20 observability fields, both optional.
    assert tmip - team == {"sampled_count", "best_timestamp_sec"}


# ── Pipeline stage order ────────────────────────────────────────────────────

def test_pipeline_stage_order_parity():
    """Both pipelines run transcription -> summarize -> OCR, in that order."""
    team_transcribe = _read(TEAM_BACKEND / "workers" / "handlers" / "transcribe.ts")
    team_summarize = _read(TEAM_BACKEND / "workers" / "handlers" / "summarize.ts")

    # Team: transcribe handler enqueues SUMMARIZE; summarize handler enqueues OCR.
    assert "type: 'SUMMARIZE'" in team_transcribe
    assert "type: 'OCR'" in team_summarize

    # TMIP: the runner executes TRANSCRIPTION, then the LLM stages, then OCR.
    tmip_runner = _read(TMIP_ROOT / "apps" / "api" / "src" / "ai" / "runner.ts")
    i_transcription = tmip_runner.index("Stage 1: transcription")
    i_llm = tmip_runner.index("Stage 2: LLM summary/keywords/classification")
    i_ocr = tmip_runner.index("Stage 3: OCR")
    assert i_transcription < i_llm < i_ocr


# ── Deliberate divergences are bounded ──────────────────────────────────────

def test_documented_divergences_only():
    """The only intended differences are the two documented hardening changes.

    Guards against silent drift: the team source must NOT already contain these,
    so any future accidental copy of team code back into TMIP is caught.
    """
    team_ocr = _read(TEAM_AI / "handlers" / "ocr.py")
    tmip_ocr = _read(TMIP_AI / "handlers" / "ocr.py")
    # Divergence 1: multi-frame sampling (ADR-006 §20).
    assert "sample_lower_third_text" not in team_ocr
    assert "sample_lower_third_text" in tmip_ocr

    team_llm = _read(TEAM_AI / "handlers" / "openrouter.py")
    tmip_llm = _read(TMIP_AI / "handlers" / "openrouter.py")
    # Divergence 2: provider-generic config + per-status error classification
    # (ADR-006 §11/§12). The team client hardcodes the provider URL and has no
    # status classifier.
    assert "classify_status" not in team_llm
    assert "classify_status" in tmip_llm
    assert "LLM_BASE_URL" not in team_llm
    assert "LLM_BASE_URL" in tmip_llm
