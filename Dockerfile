# syntax=docker/dockerfile:1.7
# Control plane: PDP (/v1/decide), hook adapters, dashboard (React build in public/), /mcp, sync API.
# Build:  docker build -t agentgov/control-plane:<git-sha> .
# Run:    docker run -p 4317:4317 -e COSMOS_ENDPOINT=... agentgov/control-plane:<git-sha>

# node:24-alpine pinned by multi-arch index digest (Renovate/Dependabot can bump it).
ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

# ---------------------------------------------------------------------------------------------
# deps: full dependency install (server + web UI)
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/
# Root install scripts are skipped: electron (desktop only) and the root postinstall that runs
# `npm --prefix web install` — the web deps are installed reproducibly with `npm ci` instead.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts \
 && npm --prefix web ci

# ---------------------------------------------------------------------------------------------
# build: tsc -> dist/, vite -> public/
# ---------------------------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build

# ---------------------------------------------------------------------------------------------
# prod-deps: runtime node_modules only
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
ENV npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="agentgov-control-plane" \
      org.opencontainers.image.source="https://github.com/stark3998/Agents-Log-Monitor"

ENV NODE_ENV=production \
    AGENT_MONITOR_MODE=cloud \
    HOST=0.0.0.0 \
    PORT=4317 \
    AGENT_MONITOR_DB=/app/data/agent-monitor.db \
    GOVERNANCE_LANES_DIR=/app/lanes \
    GOVERNANCE_POLICIES_DIR=/app/policies \
    GOVERNANCE_TRUST_LOOPBACK=false

WORKDIR /app
# Pick up Alpine security fixes released after the base image was built; npm is not needed at runtime.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && mkdir -p /app/data \
 && chown node:node /app/data

# Application files are root-owned and read-only for the runtime user; only /app/data is writable.
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/public ./public
COPY lanes ./lanes
COPY policies ./policies

USER node
EXPOSE 4317

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/server.js"]
