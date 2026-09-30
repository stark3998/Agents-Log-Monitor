import { z } from 'zod';
import type { PostureReport } from '../../posture/types';

const reportSchema = z.object({
  scannerVersion: z.string().max(64).optional(),
  scannedAt: z.string().max(64).optional(),
  endpoint: z.object({ endpointId: z.string().min(1).max(128), hostname: z.string().max(256), os: z.string().max(32), osRelease: z.string().max(128).optional(), user: z.string().max(256) }).passthrough(),
  inventory: z.object({
    agents: z.array(z.unknown()).max(500).default([]), mcpServers: z.array(z.unknown()).max(2000).default([]),
    extensions: z.array(z.unknown()).max(5000).default([]), scheduledTasks: z.array(z.unknown()).max(2000).default([]),
    accounts: z.array(z.unknown()).max(500).default([]), errors: z.array(z.string()).max(500).default([]),
  }).passthrough(),
  findings: z.array(z.object({
    checkId: z.string().min(1).max(100), severity: z.string(), category: z.string().max(60), title: z.string().max(300),
    subject: z.string().min(1).max(1000), summary: z.string().max(2000), evidence: z.record(z.string(), z.unknown()).default({}), fixable: z.boolean().default(false),
  }).passthrough()).max(1000).default([]),
  durationMs: z.number().optional(),
}).passthrough();

const MAX_REPORT_BYTES = 2 * 1024 * 1024;

/** Validate an untrusted posture report (CLI upload or device sync). */
export function parsePostureReport(raw: unknown): { report?: PostureReport; errors: string[] } {
  let size = 0;
  try { size = JSON.stringify(raw ?? null).length; } catch { return { errors: ['report is not serialisable'] }; }
  if (size > MAX_REPORT_BYTES) return { errors: [`report exceeds ${MAX_REPORT_BYTES} bytes`] };
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) return { errors: parsed.error.issues.slice(0, 20).map(i => `${i.path.join('.')}: ${i.message}`) };
  return { report: parsed.data as unknown as PostureReport, errors: [] };
}
