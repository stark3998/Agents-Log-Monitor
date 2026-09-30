#!/usr/bin/env node
import { scanEndpoint } from './scanner';

interface Args { json?: boolean; post?: string; token?: string; orgDomains?: string[]; disable?: string[] }
function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--post') args.post = argv[++i];
    else if (a === '--token') args.token = argv[++i];
    else if (a === '--org-domains') args.orgDomains = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--disable') args.disable = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await scanEndpoint({ orgDomains: args.orgDomains, disabledChecks: args.disable });
  if (args.post) {
    const res = await fetch(new URL('/api/gov/posture/reports', args.post), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(args.token ? { Authorization: `Bearer ${args.token}` } : {}) }, body: JSON.stringify(report) });
    console.log(`POST ${res.status} ${res.statusText}`);
  } else if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Endpoint ${report.endpoint.hostname} (${report.endpoint.endpointId}) posture scan`);
    console.log(`Inventory: ${report.inventory.agents.length} agents, ${report.inventory.mcpServers.length} MCP servers, ${report.inventory.extensions.length} extensions, ${report.inventory.scheduledTasks.length} scheduled tasks`);
    if (!report.findings.length) console.log('No findings.');
    else {
      console.log('Findings:');
      for (const f of report.findings) console.log(`${f.severity.toUpperCase()}\t${f.title}\t${f.subject}\t${f.summary}`);
    }
    if (report.inventory.errors.length) console.log(`Collector errors: ${report.inventory.errors.length}`);
    console.log(`Duration: ${report.durationMs} ms`);
  }
  process.exitCode = report.findings.some(f => f.severity === 'critical') ? 2 : 0;
}

main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
