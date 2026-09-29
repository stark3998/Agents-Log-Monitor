# Governance MCP gateway

The gateway is an MCP proxy that sits between MCP clients (Microsoft Foundry Agent Service, Copilot Studio, VS Code/Copilot, Claude, and custom agents) and one or more upstream MCP servers. It exposes one governed MCP endpoint and asks the governance PDP to approve every tool call before forwarding it. Tool results are sent to `/v1/result` for prompt-injection scanning; tainted results are logged and the original tool response is not modified.

## Architecture

```text
MCP client ──stdio or Streamable HTTP──> gateway ──MCP──> upstream servers
                                      │
                                      ├─ POST /v1/decide before tools/call
                                      ├─ POST /v1/result after allowed tool calls
                                      └─ GET  /v1/lanes/effective for fail-mode and list filtering
```

The gateway uses the low-level MCP `Server` APIs so arbitrary upstream tool schemas are preserved. Tool names are exposed unchanged unless two upstreams collide or an upstream sets `toolPrefix`; then the public name becomes `<prefix-or-upstream>__<tool>`.

## Configuration

Set `AGENT_GATEWAY_CONFIG` to a JSON file path. The default is `.\agent-gateway.json`; see `agent-gateway.example.json`.

Key fields:

| Field | Description |
|---|---|
| `upstreams[]` | MCP servers to proxy. `transport` is `stdio`, `http`, or `sse`. |
| `upstreams[].command`, `args`, `env` | Stdio launch settings. |
| `upstreams[].url`, `headers` | HTTP/SSE endpoint settings. |
| `upstreams[].toolPrefix` | Forces public tool names to `<toolPrefix>__<tool>`. |
| `pdpUrl` / `AGENT_GATEWAY_PDP_URL` | Governance API base URL, default `http://127.0.0.1:4317`. |
| `pdpTokenEnv` | Environment variable containing the PDP bearer token for stdio/local calls. |
| `AGENT_GATEWAY_PDP_AUDIENCE` | Entra API app id / URI of the control plane. When set, the gateway gets its own token with its managed identity (`DefaultAzureCredential`, scope `<audience>/.default`, needs the `Agent` app role) and uses it for every PDP call. Caller identity still travels in the `X-Agent-*` headers. |
| `AGENT_GATEWAY_AUDIENCE` | Required for HTTP mode. Entra audience/client id accepted from MCP callers; tokens must include the `Agent` app role. |
| `AGENT_GATEWAY_ALLOW_ANONYMOUS` | Explicit local-only HTTP opt-out. Set `true` only when binding to loopback; the gateway refuses to start anonymously on `0.0.0.0` or another non-loopback host. |
| `port`, `host` / `AGENT_GATEWAY_PORT`, `GATEWAY_HOST` | HTTP listener. Defaults to `127.0.0.1:4127`. |
| `failModeDefault` | `open` or `closed` when PDP/lane lookup is unavailable. |
| `identityHeaders` | Header names for agent/session identity. |

HTTP clients must pass `Authorization: Bearer <Entra token>` for `AGENT_GATEWAY_AUDIENCE` with the `Agent` role. The gateway derives agent identity from token claims (`appid`/`azp`/`oid`, display name, subject) and forwards the verified bearer token to the PDP unless the gateway is configured with its own PDP credential. `X-Agent-Id` may only add a sub-identity suffix (for example `gateway-app/foundry-agent-1`), and `X-Session-Id` is namespaced by the token subject. `X-Agent-Surface` remains metadata; `X-Agent-Name` and `X-User` are not trusted for authenticated identity. Stdio clients use `AGENT_ID`, `AGENT_NAME`, `AGENT_USER`, and optional `AGENT_SURFACE`.

## Running locally

Build first:

```powershell
npx tsc -p .
```

HTTP:

```powershell
$env:AGENT_GATEWAY_CONFIG = ".\agent-gateway.json"
npm run gateway
```

Stdio wrapping for VS Code, Claude, or another local MCP client:

```json
{
  "mcpServers": {
    "governed": {
      "command": "node",
      "args": ["dist/gateway/main.js", "--stdio"],
      "env": {
        "AGENT_GATEWAY_CONFIG": "C:\\path\\to\\agent-gateway.json",
        "AGENT_ID": "local-agent",
        "AGENT_NAME": "Local MCP client",
        "AGENT_USER": "user@contoso.com"
      }
    }
  }
}
```

## Running in the cloud

Package the app as a container, expose `/mcp` and `/health`, and set `GATEWAY_HOST=0.0.0.0` only behind a private or authenticated ingress. Set `AGENT_GATEWAY_AUDIENCE` and require caller Entra tokens with the `Agent` app role; do not enable `AGENT_GATEWAY_ALLOW_ANONYMOUS` outside loopback development. Use managed identity (`AGENT_GATEWAY_PDP_AUDIENCE`) for gateway-to-PDP calls when the caller token audience differs from the control-plane API. Store upstream credentials in Key Vault and inject them as environment variables. Keep `failModeDefault` closed for write-capable upstreams unless the lane explicitly allows fail-open.

## Microsoft Foundry Agent Service

Register the gateway as an MCP tool with `server_url` pointing to `https://<gateway-host>/mcp`. Add identity headers such as:

```json
{
  "X-Agent-Surface": "foundry",
  "X-Agent-Id": "<agent-id>",
  "X-Agent-Name": "<agent-name>",
  "X-Session-Id": "<thread-or-run-id>",
  "X-User": "<end-user-upn>"
}
```

Set Foundry `require_approval` according to your UX needs, but remember that governance approval happens at the gateway/PDP even if the client does not prompt.

## Copilot Studio MCP connector

Create an MCP connector that targets the gateway `/mcp` URL. Configure authentication so the connector sends a bearer token accepted by the PDP/control plane, and map bot/user identifiers into the gateway identity headers. Use the effective lane to keep destructive connector actions in enforce or enforce+approval mode.

## Limitations

- The HTTP front end is stateless Streamable HTTP; long-lived server-to-client notifications are not persisted.
- Tool list filtering only hides deterministic deny rules that contain only `tool` and/or `mcpServer` conditions.
- Ask/escalate verdicts are treated as blocked if the PDP returns them despite `blocking=true`.
- Upstream headers are static config values; secret expansion should be handled by the process environment or deployment platform.
