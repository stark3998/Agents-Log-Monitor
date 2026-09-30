# syntax=docker/dockerfile:1.7
# Monitoring fleet (agentmon-fleet): collectors + detectors loop, and the real-time hooks API.
# Build context is this folder:
#   docker build -t agentgov/fleet:<git-sha> fleet
# One image, two Container Apps (see infra/terraform/modules/fleet):
#   worker : agentmon-fleet run                                        (default CMD, no ingress)
#   hooks  : agentmon-fleet hooks --host 0.0.0.0 --port 8787           (GET /health)
# Azure auth is the user-assigned managed identity (FLEET_MANAGED_IDENTITY_CLIENT_ID) — never a client secret.

ARG PYTHON_IMAGE=python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

# ---------------------------------------------------------------------------------------------
# build: install the package + runtime deps (no dev extra) into an isolated virtualenv
# ---------------------------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS build
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
WORKDIR /src
COPY pyproject.toml ./
COPY src ./src
RUN pip install --upgrade pip \
 && pip install .

# ---------------------------------------------------------------------------------------------
# runtime: slim image, non-root, virtualenv + charters only
# ---------------------------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime
LABEL org.opencontainers.image.title="agentgov-fleet" \
      org.opencontainers.image.source="https://github.com/stark3998/Agents-Log-Monitor"

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    FLEET_STATE_DB=/data/fleet-state.db \
    FLEET_ALERTS_JSONL=/data/fleet-alerts.jsonl \
    FLEET_JEV_SHADOW_JSONL=/data/fleet-jev-shadow.jsonl

RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /home/app --create-home --shell /usr/sbin/nologin app \
 && mkdir -p /data \
 && chown 10001:10001 /data

COPY --from=build /opt/venv /opt/venv
COPY charters /app/charters
ENV FLEET_CHARTER_DIR=/app/charters

RUN agentmon-fleet --help > /dev/null

# SQLite state + local JSONL logs. In Container Apps this is an EmptyDir volume (see infra/README.md).
WORKDIR /data
USER 10001:10001
EXPOSE 8787

ENTRYPOINT ["agentmon-fleet"]
CMD ["run"]
