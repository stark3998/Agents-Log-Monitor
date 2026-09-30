import type { Express } from 'express';
import { broadcast } from '../broadcast';
import { authenticate, requireJsonForGovMutations, requireRole } from './auth';
import { govConfig } from './config';
import { govBus } from './events';
import { localAdminRouter } from './local-admin';
import { setGovernanceStore } from './store';
import type { GovernanceStore } from './store/repository';
import { SqliteGovernanceStore } from './store/sqlite';
import decideRouter from './routes/decide';
import adminRouter, { authBootstrap } from './routes/admin';
import intelligenceRouter from './routes/intelligence';
import hooksRouter from './hooks/router';
import enrollRouter from './routes/enroll';
import { startLaneFileSync } from './lanes/loader';
import { startPolicyFileSync } from './policies/loader';
import { startClassifierConfigRefresh } from './classifiers';
import policiesRouter from './routes/policies';
import postureRouter from './routes/posture';
import { startPostureScheduler } from './posture';
import { setLimits } from './limits';
import { initSqliteTelemetry } from './telemetry-sqlite';
import { mountMcp } from './mcp';
import { startSync } from './sync';
import { startAlerts } from './alerts';

/**
 * Governance bootstrap. Called from server.ts after initDb().
 *
 * Mount points (owned by separate modules):
 *   POST /v1/decide, /v1/goal, /v1/result, ... — PDP API for SDKs/gateway   (routes/decide.ts)
 *   POST /hooks/:surface                         — enforcing agent hooks      (hooks/router.ts)
 *   /api/gov/*                                   — dashboard/admin REST API   (routes/admin.ts)
 *   /api/gov/intelligence/*                      — proxy to Python service    (routes/intelligence.ts)
 *   /mcp                                         — monitor MCP server         (mcp/index.ts)
 */
export async function initGovernanceStore(): Promise<GovernanceStore> {
  let store: GovernanceStore;
  if (govConfig.mode === 'cloud' && govConfig.cloud.cosmosEndpoint) {
    // Loaded lazily (non-literal specifier) so local installs never touch the Cosmos SDK.
    const cosmosModule = './store/cosmos';
    const mod = await import(cosmosModule).catch(() => null) as { CosmosGovernanceStore?: new () => GovernanceStore } | null;
    if (!mod?.CosmosGovernanceStore) throw new Error('cloud mode requires src/governance/store/cosmos.ts');
    store = new mod.CosmosGovernanceStore();
  } else {
    store = new SqliteGovernanceStore();
  }
  await store.init();
  setGovernanceStore(store);
  return store;
}

/** Telemetry reader + cluster-wide runtime backends (cloud: Cosmos telemetry, Redis limits). */
async function initRuntime(): Promise<void> {
  if (govConfig.mode === 'cloud' && govConfig.cloud.cosmosEndpoint) {
    const cosmosTelemetry = './store/cosmos-telemetry';
    const { initCosmosTelemetry } = await import(cosmosTelemetry) as { initCosmosTelemetry: () => Promise<unknown> };
    await initCosmosTelemetry();
  } else {
    initSqliteTelemetry();
  }
  if (govConfig.mode === 'cloud' && govConfig.cloud.redisUrl) {
    const { RedisLimits } = await import('./runtime/redis-limits');
    setLimits(new RedisLimits());
  }
}

export async function initGovernance(app: Express): Promise<void> {
  await initGovernanceStore();
  await initRuntime();
  startLaneFileSync();
  startPolicyFileSync();
  startClassifierConfigRefresh();

  // Forward governance events to dashboard clients.
  govBus.on('decision', d => broadcast({ type: 'gov.decision', decision: d }));
  govBus.on('approval.requested', a => broadcast({ type: 'gov.approval', approval: a }));
  govBus.on('approval.resolved', a => broadcast({ type: 'gov.approval', approval: a }));
  govBus.on('agent.updated', a => broadcast({ type: 'gov.agent', agent: a }));
  govBus.on('lane.updated', l => broadcast({ type: 'gov.lane', lane: { id: l.lane.id, version: l.lane.version, status: l.status } }));
  govBus.on('policy.updated', p => broadcast({ type: 'gov.policy', policy: { id: p.policy.id, version: p.policy.version, status: p.status } }));
  govBus.on('posture.updated', p => broadcast({ type: 'gov.posture', endpointId: p.endpointId }));
  govBus.on('incident.created', i => broadcast({ type: 'gov.incident', incident: i }));
  govBus.on('incident.updated', i => broadcast({ type: 'gov.incident', incident: i }));

  app.use('/v1', authenticate, decideRouter);
  app.use('/hooks', authenticate, requireRole('Agent'), hooksRouter);
  // Public: the dashboard needs sign-in settings before it has a token.
  app.get('/api/gov/auth-config', (_req, res) => res.json(authBootstrap()));
  if (govConfig.mode === 'local') app.use('/api/gov', localAdminRouter());
  app.use('/api/gov', requireJsonForGovMutations);
  if (process.env.TEAMS_BOT_APP_ID) {
    // Bot Framework activities carry Bot Connector tokens, validated inside the router — not Entra API tokens.
    const { default: teamsBotRouter } = await import('./alerts/teams-bot');
    app.use(teamsBotRouter);
  }
  app.use('/api/gov/intelligence', authenticate, intelligenceRouter);
  app.use('/api/gov/devices', authenticate, enrollRouter);
  if (govConfig.mode === 'cloud') {
    const { default: syncIngestRouter } = await import('./sync/ingest-router');
    app.use('/api/gov', authenticate, syncIngestRouter);
  }
  app.use('/api/gov', authenticate, policiesRouter);
  app.use('/api/gov', authenticate, postureRouter);
  app.use('/api/gov', authenticate, adminRouter);
  mountMcp(app);

  startAlerts();
  startSync();
  startPostureScheduler();
  console.log(`[governance] mode=${govConfig.mode} store=${govConfig.mode === 'cloud' ? 'cosmos' : 'sqlite'} judge=${govConfig.foundry.enabled ? 'foundry' : 'off'} shields=${govConfig.contentSafety.enabled ? 'on' : 'off'}`);
}
