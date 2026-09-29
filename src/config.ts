export const config = {
  copilotCli: {
    // Tails $COPILOT_HOME/session-state/*/events.jsonl. On by default when the folder exists.
    enabled: process.env.COPILOT_CLI_ENABLED !== 'false' && process.env.COPILOT_CLI_ENABLED !== '0',
    home: process.env.COPILOT_HOME || undefined,
    importDays: Number(process.env.COPILOT_CLI_IMPORT_DAYS ?? 7),
    pollIntervalMs: Number(process.env.COPILOT_CLI_POLL_INTERVAL_MS ?? 2000),
  },
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
