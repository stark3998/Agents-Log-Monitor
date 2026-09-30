# Governance cloud mode

Run the same service as the central control plane with `AGENT_MONITOR_MODE=cloud`. Local desktops keep SQLite and sync to the cloud when `GOVERNANCE_CONTROL_PLANE_URL` is set.

## Environment

Cloud control plane:

- `AGENT_MONITOR_MODE=cloud`
- `GOVERNANCE_TENANT_ID` / `AZURE_TENANT_ID` — tenant partition value.
- `COSMOS_ENDPOINT` and `COSMOS_DATABASE` — Cosmos DB NoSQL account/database.
- `COSMOS_KEY` — optional emulator/dev key. Production uses `DefaultAzureCredential`/managed identity.
- `REDIS_URL` — optional Redis URL. Terraform provisions Azure Managed Redis (TLS-only on port 10000) and stores the URL in Key Vault as `rediss://:<access-key>@<name>.<region>.redis.azure.net:10000`. Any Redis that accepts `rediss://` URLs works.

Local enforcer sync:

- `GOVERNANCE_CONTROL_PLANE_URL=https://control-plane.example.com`
- `GOVERNANCE_DEVICE_TOKEN=<enrolled device bearer token>`
- `GOVERNANCE_SYNC_INTERVAL_MS=15000`
- `GOVERNANCE_DEVICE_ID=<stable device id>` (optional; hostname is used otherwise)

## Cosmos containers

| Container | Partition key | Purpose |
|---|---|---|
| `lanes` | `/tenantId` | Versioned lane records. Document id is `<laneId>:<version>`. |
| `agents` | `/tenantId` | Agent registry and pause/quarantine status. |
| `sessions` | `/sessionId` | Session intent docs (`intent:<sessionId>`) plus telemetry summaries (`summary:<sessionId>`). |
| `decisions` | `/sessionId` | Queryable decision documents for session timelines. |
| `audit` | `/tenantId` | Global tenant audit head (`head`) and per-sequence chain docs (`decision:<seq>`). |
| `approvals` | `/tenantId` | Approval workflow records. |
| `incidents` | `/tenantId` | Guardian/manual incidents. |
| `outbox` | `/box` | Cloud-side alert/sync outboxes. |
| `events` | `/sessionId` | Mirrored local telemetry events (per-item TTL). |
| `posture` | `/tenantId` | Endpoint posture: endpoints and inventories (`kind: endpoint`), findings (`kind: finding`). |
| `jev_shadow` | `/pk` | TypeSafe Jev shadow comparisons; non-authoritative, outside the audit chain ([jev.md](jev.md)). |
| `fleet` | `/tenantId` | Monitoring-fleet alerts (`kind: fleet_alert`) from `/api/gov/fleet/alerts` ([fleet.md](fleet.md)). |

Large or rarely filtered fields such as judge payloads, rule bodies, event payloads, and result text are excluded from indexing. Decision queries order by `createdAt DESC`; the store declares composite indexes for agent/time, lane/time, verdict/time, and session/time filters.

## Audit chain design

Cosmos decisions are partitioned by session for cheap timeline reads, but the audit chain is tenant-global. Appends serialize on the `audit/head` document using ETag optimistic concurrency: read head, compute `seq/prevHash/hash`, create tentative decision/audit docs, then replace the head with `If-Match`. A `412` means another replica won; the store removes tentative docs and retries with jitter. The cloud chain is authoritative. When local decisions are synced, their original `{deviceId, seq, hash}` is stored as extra Cosmos metadata outside the `Decision` type.

## Redis usage

`src/governance/runtime/redis.ts` exposes optional backends:

- `RedisLimitsBackend` — sliding-window counters and loop-signature windows.
- `RedisDecisionCache` — short TTL PDP decision cache.
- `RedisPauseFlags` — distributed agent/session pause flags with pub/sub invalidation.
- `RedisApprovalSignal` — pub/sub approval resolution notifications so any replica holding a blocked hook can resume.

Current in-memory PDP limit/approval code must opt into these interfaces in a follow-up integration.

## Sync protocol

Local mode with `GOVERNANCE_CONTROL_PLANE_URL` periodically:

1. Pulls active lanes from `GET /api/gov/lanes?status=active` and saves them locally. Cloud wins when a lane id/version collides; local-only file lanes with different ids remain.
2. Pulls agent statuses from `GET /api/gov/agents` for kill switches.
3. Enqueues local decisions from the governance event bus.
4. Polls new rows from the local `events` table and enqueues mirrored telemetry. The effective lane `sync.dataPolicy` is applied: `redacted` is the default, `full` keeps locally stored payloads, and `metadata-only` drops payload/input/result fields.
5. Drains the sync outbox to `POST /api/gov/sync/ingest` with the device bearer token. Failures nack the batch so it retries later.

Cloud ingest is implemented in `src/governance/sync/ingest-router.ts`. It must be mounted at `/api/gov` by the governance bootstrap.

## Device enrollment

Issue each local enforcer a device principal with the `Agent` role and a bearer token. The token is sent as `Authorization: Bearer <token>` on sync calls. Rotate by issuing a new token and restarting the local service. Production should replace the current loopback auth stub with Entra validation for device credentials.

## Failure behavior and RU notes

Local enforcers are offline tolerant: lane/agent pulls can fail, decisions/events stay in SQLite outbox, and batches retry with backoff through normal polling. Cloud Cosmos writes use SDK retry plus audit-head retry on contention. High-volume tenants should provision RU/s primarily on `decisions`, `events`, and `audit`; decision append costs include one decision create, one audit create, and one head replace. Use autoscale RU/s for bursty fleets and keep metadata-only lanes for high-volume low-risk telemetry.
