import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initDb } from '../../db';
import { LOCAL_PRINCIPAL } from '../auth';
import { initGovernanceStore } from '../index';
import { initSqliteTelemetry } from '../telemetry-sqlite';
import { createMcpServer } from './server';

async function main(): Promise<void> {
  await initDb();
  await initGovernanceStore();
  initSqliteTelemetry();
  const server = createMcpServer(LOCAL_PRINCIPAL);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] stdio server connected');
}

main().catch(err => {
  console.error('[mcp] stdio server failed:', err);
  process.exit(1);
});
