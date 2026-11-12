"""
LLM-based text processing: summarization, keyword extraction, category classification.
All use OpenRouter API (no local LLM).

TMIP Phase 14: copied as-is from the source project
(docs/plans/006-ai-processor-integration.md §2.1). TMIP calls `/summarize`
once; `/keywords` and `/classify` are thin wrappers that re-run the same
single-LLM-call logic and are intentionally NOT exposed by TMIP's API
(ADR-006 §17).
"""

from .openrouter import LlmProviderError, call_openrouter, is_available

CONTENT_CATEGORIES = [
    "Kuliner", "Cooking Show", "Dokumenter", "Edukasi", "Berita", "Vlog",
    "Tutorial", "Bisnis/UMKM", "Profil Perusahaan", "Hiburan", "Talkshow",
    "Reality Show", "Travel/Jalan-jalan", "Musik", "Religi", "Kesehatan",
    "Olahraga", "Otomotif", "Teknologi", "Pertanian/Perikanan", "Sosial/Budaya",
    "Anak-anak", "Investigasi", "Motivasi/Inspirasi", "Lainnya",
]

# Output budget for the single summarize call.
#
# TMIP deviation from the source value of 400, with recorded evidence: at 400
# the provider (deepseek-v4-flash via an [OI]-compatible endpoint) returned an
# HTTP 200 whose assistant content was EMPTY, so the response never reached the
# KEYWORDS/CATEGORY lines. Observed production effect: summary truncated
# mid-sentence (146 chars), keywords `[]`, category defaulted to "Lainnya".
# Re-running the same prompt with a larger budget produced a complete,
# well-formed response (full summary, 10 keywords, category "Dokumenter").
# The response is also non-deterministic at the same budget, so a bounded retry
# can recover — hence an incomplete response is classified TRANSIENT below.
MAX_SUMMARY_TOKENS = 1500

# The prompt asks for exactly these three labelled sections. A response that
# does not yield all three is treated as a controlled failure, never as a
# partial-but-valid result (see summarize()).
_REQUIRED_SECTIONS = ("SUMMARY", "KEYWORDS", "CATEGORY")


def summarize(full_text: str) -> dict | None:
    """
    Generate summary, keywords, and category from full transcript text.
    Makes a single LLM call.

    Returns dict with:
        - summary: str
        - keywords: list[str]
        - category: str

    Returns None when no LLM API key is configured (graceful degradation —
    ADR-006 §11). Raises `LlmProviderError` when a key IS configured but the
    provider call fails, so the caller can classify the failure (auth, model,
    quota, transient) instead of collapsing every cause into one generic error.
    An empty or incomplete response (missing SUMMARY/KEYWORDS/CATEGORY) is such
    a controlled failure — classified TRANSIENT because the provider is
    non-deterministic — rather than being returned as a partial result.
    """
    if not is_available():
        return None

    # Truncate very long transcripts to avoid token limits
    text_for_llm = full_text[:8000] if len(full_text) > 8000 else full_text

    categories_str = ", ".join(CONTENT_CATEGORIES)

    prompt = (
        f"Berikut adalah transkrip lengkap sebuah video:\n\n"
        f"---TRANSCRIPT START---\n{text_for_llm}\n---TRANSCRIPT END---\n\n"
        f"TUGAS (jawab persis format berikut, tanpa tambahan):\n"
        f"SUMMARY: <ringkasan isi video 2-3 kalimat dalam Bahasa Indonesia>\n"
        f"KEYWORDS: <kata kunci pisah koma, maksimal 10, dalam Bahasa Indonesia>\n"
        f"CATEGORY: <pilih SATU dari daftar ini: {categories_str}>\n"
    )

    response = call_openrouter(prompt, max_tokens=MAX_SUMMARY_TOKENS)

    # An empty body is the provider's response to an exhausted/too-small budget.
    # Treat it as a controlled, retryable failure — never as "no content".
    if not response:
        raise LlmProviderError(
            "EMPTY_RESPONSE",
            "TRANSIENT",
            "LLM provider returned an empty response for /summarize",
        )

    summary, keywords, category = None, [], None
    seen = set()

    for line in response.splitlines():
        line = line.strip()
        if line.upper().startswith("SUMMARY:"):
            summary = line.split(":", 1)[1].strip()
            seen.add("SUMMARY")
        elif line.upper().startswith("KEYWORDS:"):
            kw_text = line.split(":", 1)[1].strip()
            keywords = [kw.strip() for kw in kw_text.split(",") if kw.strip()]
            seen.add("KEYWORDS")
        elif line.upper().startswith("CATEGORY:"):
            cat_text = line.split(":", 1)[1].strip()
            category = cat_text
            # Match against known categories (case-insensitive)
            for cat in CONTENT_CATEGORIES:
                if cat_text.lower() == cat.lower():
                    category = cat
                    break
            seen.add("CATEGORY")

    # A response missing any required section is incomplete (the third line was
    # cut off, as observed at the old 400-token budget). Fail controlled instead
    # of persisting a partial result.
    missing = [name for name in _REQUIRED_SECTIONS if name not in seen]
    if missing:
        raise LlmProviderError(
            "INCOMPLETE_RESPONSE",
            "TRANSIENT",
            f"LLM response missing section(s): {', '.join(missing)}",
        )

    return {
        "summary": summary or full_text[:200] + "...",
        "keywords": keywords,
        "category": category,
    }


def extract_keywords(full_text: str) -> list[str] | None:
    """Extract keywords only (uses summarize internally for efficiency)."""
    result = summarize(full_text)
    if result:
        return result.get("keywords", [])
    return None


def classify_category(full_text: str) -> str | None:
    """Classify category only (uses summarize internally for efficiency)."""
    result = summarize(full_text)
    if result:
        return result.get("category")
    return None
