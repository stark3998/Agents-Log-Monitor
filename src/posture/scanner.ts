import os from 'os';
import type { EndpointInfo, PostureReport, ScanContext } from './types';
import { defaultScanContext } from './context';
import { collectInventory } from './inventory';
import { evaluateEndpoint } from './checks';
import { SCANNER_VERSION, stableEndpointId } from './utils';
import { sanitizeInventory } from './sanitize';

export async function scanEndpoint(ctxOverrides: Partial<ScanContext> = {}): Promise<PostureReport> {
  const started = Date.now();
  const ctx = defaultScanContext(ctxOverrides);
  const endpoint: EndpointInfo = {
    endpointId: ctx.env.AGENT_MONITOR_ENDPOINT_ID || stableEndpointId(ctx.hostname, ctx.user),
    hostname: ctx.hostname,
    os: ctx.platform,
    osRelease: os.release(),
    user: ctx.user,
  };
  const inventory = sanitizeInventory(await collectInventory(ctx));
  const findings = await evaluateEndpoint(inventory, ctx);
  return { scannerVersion: SCANNER_VERSION, scannedAt: new Date().toISOString(), endpoint, inventory, findings, durationMs: Date.now() - started };
}
