# TMIP AI Processor image — Phase 14 (docs/plans/006-ai-processor-integration.md)
#
# Adapted from the source AI Processor project with two deliberate changes:
#   1. The corporate SSL-inspection CA cert COPY + update-ca-certificates was
#      removed (ADR-006 finding 13): the cert is environment-specific and must
#      not be carried into TMIP.
#   2. The apt sources use HTTPS. This network's intermediary returns HTTP 500
#      for the plain-HTTP Debian mirror, so `http://deb.debian.org` is rewritten
#      to `https://deb.debian.org`. This changes only how packages are fetched,
#      not what is installed (ffmpeg/tesseract/tesseract-ocr-ind are unchanged).
# The multi-stage layout and system packages are otherwise kept unchanged.

# ---- Builder stage ----
FROM python:3.11-slim AS builder

WORKDIR /app

RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        tesseract-ocr \
        tesseract-ocr-ind \
        gcc \
        g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies into a user site-packages tree that is copied
# wholesale into the runtime stage.
COPY requirements.txt .
RUN pip install --no-cache-dir --user --timeout=180 --retries=3 -r requirements.txt

# ---- Runtime stage ----
FROM python:3.11-slim AS runner

WORKDIR /app

RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        tesseract-ocr \
        tesseract-ocr-ind \
    && rm -rf /var/lib/apt/lists/*

# Copy installed Python packages from builder
COPY --from=builder /root/.local /root/.local

# Ensure local Python packages are in PATH
ENV PATH=/root/.local/bin:$PATH

# Copy application code
COPY app ./app

# Port for FastAPI. The service is internal-only: docker-compose exposes this
# port on the compose network and does NOT publish it to the host (ADR-006 §10).
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
