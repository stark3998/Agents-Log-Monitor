/**
 * Governance configuration (environment variables). Everything is optional; with nothing set the
 * monitor runs as a local enforcer with deterministic lanes only (no LLM judge, no Prompt Shields).
 */
function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : d;
}
function bool(v: string | undefined, d: boolean): boolean {
  if (v == null || v === '') return d;
  return !['0', 'false', 'no', 'off'].includes(v.toLowerCase());
}

export type DeploymentMode = 'local' | 'cloud';

export const govConfig = {
  /** `local` = desktop enforcer (node:sqlite, loopback); `cloud` = central control plane (Cosmos/Redis/Entra). */
  mode: (process.env.AGENT_MONITOR_MODE === 'cloud' ? 'cloud' : 'local') as DeploymentMode,
  /** Master switch for inline enforcement; when false every decision is forced to observe. */
  enforcementEnabled: bool(process.env.GOVERNANCE_ENFORCE, true),
  /** Folder of lanes-as-code YAML files (synced into the store on start and on change). */
  lanesDir: process.env.GOVERNANCE_LANES_DIR ?? '',
  /** Tenant id used for partitioning in cloud mode. */
  tenantId: process.env.GOVERNANCE_TENANT_ID ?? process.env.AZURE_TENANT_ID ?? 'default',

  foundry: {
    /** Azure OpenAI-compatible endpoint of the Foundry resource, e.g. https://xxx.openai.azure.com or https://xxx.services.ai.azure.com */
    endpoint: process.env.FOUNDRY_OPENAI_ENDPOINT ?? process.env.AZURE_OPENAI_ENDPOINT ?? '',
    apiVersion: process.env.FOUNDRY_OPENAI_API_VERSION ?? '2024-10-21',
    /** Optional API key; when absent DefaultAzureCredential is used (scope cognitiveservices). */
    apiKey: process.env.FOUNDRY_OPENAI_API_KEY ?? process.env.AZURE_OPENAI_API_KEY ?? '',
    fastDeployment: process.env.JUDGE_FAST_DEPLOYMENT ?? 'gpt-4.1-mini',
    escalationDeployment: process.env.JUDGE_ESCALATION_DEPLOYMENT ?? 'gpt-5',
    intentDeployment: process.env.INTENT_DEPLOYMENT ?? process.env.JUDGE_FAST_DEPLOYMENT ?? 'gpt-4.1-mini',
    fastTimeoutMs: num(process.env.JUDGE_FAST_TIMEOUT_MS, 4000),
    escalationTimeoutMs: num(process.env.JUDGE_ESCALATION_TIMEOUT_MS, 15000),
    get enabled(): boolean { return !!this.endpoint; },
  },

  contentSafety: {
    /** Azure AI Content Safety endpoint for Prompt Shields, e.g. https://xxx.cognitiveservices.azure.com */
    endpoint: process.env.CONTENT_SAFETY_ENDPOINT ?? '',
    apiKey: process.env.CONTENT_SAFETY_API_KEY ?? '',
    apiVersion: process.env.CONTENT_SAFETY_API_VERSION ?? '2024-09-01',
    timeoutMs: num(process.env.CONTENT_SAFETY_TIMEOUT_MS, 3000),
    get enabled(): boolean { return !!this.endpoint; },
  },

  cloud: {
    /** Control-plane base URL local enforcers sync with, e.g. https://agentgov.contoso.com */
    controlPlaneUrl: process.env.GOVERNANCE_CONTROL_PLANE_URL ?? '',
    /** Device token issued at enrollment (local mode → cloud). */
    deviceToken: process.env.GOVERNANCE_DEVICE_TOKEN ?? '',
    syncIntervalMs: num(process.env.GOVERNANCE_SYNC_INTERVAL_MS, 15000),
    cosmosEndpoint: process.env.COSMOS_ENDPOINT ?? '',
    cosmosDatabase: process.env.COSMOS_DATABASE ?? 'agentgov',
    redisUrl: process.env.REDIS_URL ?? '',
  },

  auth: {
    /** Entra app (API) client id / audience for tokens presented to the control plane and /mcp. */
    audience: process.env.ENTRA_API_AUDIENCE ?? '',
    /** Dashboard (SPA) app registration client id used by MSAL; falls back to the API audience. */
    spaClientId: process.env.ENTRA_SPA_CLIENT_ID ?? '',
    tenantId: process.env.ENTRA_TENANT_ID ?? process.env.AZURE_TENANT_ID ?? '',
    /** In local mode loopback callers are trusted as `local` principals with all roles unless disabled. */
    trustLoopback: bool(process.env.GOVERNANCE_TRUST_LOOPBACK, true),
  },

  alerts: {
    teamsWebhookUrl: process.env.TEAMS_WEBHOOK_URL ?? '',
    webhookUrls: (process.env.ALERT_WEBHOOK_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    webhookSecret: process.env.ALERT_WEBHOOK_SECRET ?? '',
    acsConnectionEndpoint: process.env.ACS_ENDPOINT ?? '',
    emailFrom: process.env.ALERT_EMAIL_FROM ?? '',
    emailTo: (process.env.ALERT_EMAIL_TO ?? '').split(',').map(s => s.trim()).filter(Boolean),
    /** Public base URL of the dashboard used in deep links (Teams cards, emails). */
    dashboardUrl: process.env.DASHBOARD_PUBLIC_URL ?? '',
  },

  intelligence: {
    /** Base URL of the Python intelligence service (Guardian, lane drafter, chat). */
    url: process.env.INTELLIGENCE_URL ?? '',
  },
};
