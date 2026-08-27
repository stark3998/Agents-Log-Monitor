export const config = {
  foundry: {
    enabled: !!process.env.FOUNDRY_ENDPOINT,
    // Full project endpoint, e.g. https://xxx.services.ai.azure.com/api/projects/myproject
    endpoint: process.env.FOUNDRY_ENDPOINT ?? '',
    pollIntervalMs: Number(process.env.FOUNDRY_POLL_INTERVAL_MS ?? 60_000),
  },
  copilotStudio: {
    enabled: !!process.env.DATAVERSE_ORG_URL,
    // Dataverse org URL, e.g. https://myorg.crm.dynamics.com
    orgUrl: process.env.DATAVERSE_ORG_URL ?? '',
    // Optional: filter to a specific bot GUID. Leave empty to ingest all bots.
    botId: process.env.COPILOT_BOT_ID ?? '',
    pollIntervalMs: Number(process.env.COPILOT_POLL_INTERVAL_MS ?? 300_000),
  },
};
