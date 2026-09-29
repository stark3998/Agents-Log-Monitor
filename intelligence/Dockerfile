# syntax=docker/dockerfile:1.7
# Intelligence service (FastAPI + Microsoft Agent Framework): Guardian, lane drafter, Ask-the-monitor.
# Build context is this folder:
#   docker build -t agentgov/intelligence:<git-sha> intelligence
# Assumes intelligence/pyproject.toml declares the `agentgov_intel` package and depends on
# fastapi + uvicorn; the ASGI app is `agentgov_intel.app:app` and exposes GET /health.

ARG PYTHON_IMAGE=python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

# ---------------------------------------------------------------------------------------------
# build: install the package + deps into an isolated virtualenv
# ---------------------------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS build
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
WORKDIR /src
# Dependency metadata first for layer caching, then the source (non-editable install).
COPY pyproject.toml ./
COPY . .
RUN pip install --upgrade pip setuptools wheel \
 && pip install .

# ---------------------------------------------------------------------------------------------
# runtime: slim image, non-root, only the virtualenv
# ---------------------------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime
LABEL org.opencontainers.image.title="agentgov-intelligence" \
      org.opencontainers.image.source="https://github.com/stark3998/Agents-Log-Monitor"

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000

RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /home/app --create-home --shell /usr/sbin/nologin app

COPY --from=build /opt/venv /opt/venv

WORKDIR /home/app
USER 10001:10001
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "-c", "import os,sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','8000'), timeout=4).status == 200 else 1)"]

# --proxy-headers: Container Apps terminates TLS at the Envoy ingress.
CMD ["uvicorn", "agentgov_intel.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
