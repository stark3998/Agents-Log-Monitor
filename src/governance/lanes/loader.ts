import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import YAML from 'yaml';
import { z } from 'zod';
import { govConfig } from '../config';
import { govBus } from '../events';
import { govStore } from '../store';
import type { Lane, LaneCondition, LaneRecord, Surface, ToolCategory } from '../types';
import { BUILTIN_DEFAULT_LANE } from './engine';

const categories = ['READ', 'WRITE', 'EXEC', 'NETWORK', 'AGENT', 'MCP', 'OTHER'] as const;
const surfaces = ['claude-code', 'copilot-cli', 'copilot-cloud-agent', 'vscode', 'mcp-gateway', 'sdk', 'foundry', 'copilot-studio', 'monitor', 'unknown'] as const;

const strArray = z.array(z.string()).default([]);
const categoryArray = z.array(z.enum(categories)).default([]);
const commandArray = z.array(z.string()).superRefine((patterns, ctx) => {
  for (let i = 0; i < patterns.length; i++) {
    try { new RegExp(patterns[i]); } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid command regex "${patterns[i]}": ${(err as Error).message}`, path: [i] });
    }
  }
}).default([]);
const conditionSchema: z.ZodType<LaneCondition> = z.object({
  id: z.string().optional(),
  category: categoryArray.optional(),
  tool: strArray.optional(),
  mcpServer: strArray.optional(),
  risk: strArray.optional(),
  path: strArray.optional(),
  domain: strArray.optional(),
  command: commandArray.optional(),
  detector: strArray.optional(),
  tainted: z.boolean().optional(),
  description: z.string().optional(),
}).passthrough();

const laneSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().default(1),
  name: z.string().optional(),
  priority: z.number().int().default(0),
  appliesTo: z.object({
    surfaces: z.array(z.union([z.enum(surfaces), z.literal('*')])).optional(),
    platforms: z.array(z.union([z.enum(surfaces), z.literal('*')])).optional(),
    agents: strArray.optional(), repos: strArray.optional(), users: strArray.optional(),
  }).passthrough().default({}),
  purpose: z.string().min(1),
  dos: strArray,
  never: strArray,
  rules: z.object({
    deny: z.array(conditionSchema).default([]),
    allow: z.array(conditionSchema).default([]),
    judge: z.array(conditionSchema).default([]),
    approve: z.array(conditionSchema).default([]),
  }).default({ deny: [], allow: [], judge: [], approve: [] }),
  defaultVerdict: z.enum(['allow', 'deny', 'judge']).default('allow'),
  mode: z.enum(['observe', 'enforce', 'enforce+approval']).default('observe'),
  failMode: z.object({ default: z.enum(['open', 'closed']).default('closed') }).catchall(z.enum(['open', 'closed'])).default({ default: 'closed' }),
  approval: z.object({
    channels: z.array(z.enum(['native', 'dashboard', 'teams'])).default(['dashboard']),
    timeoutSec: z.number().positive().default(120),
    approvers: z.array(z.string()).optional(),
  }).default({ channels: ['dashboard'], timeoutSec: 120 }),
  judge: z.object({
    model: z.string().optional(),
    escalateBelow: z.number().min(0).max(1).default(0.7),
    humanBelow: z.number().min(0).max(1).optional(),
    dataPolicy: z.enum(['redacted', 'full', 'metadata-only']).default('redacted'),
    timeoutMs: z.number().positive().optional(),
  }).default({ escalateBelow: 0.7, dataPolicy: 'redacted' }),
  limits: z.object({
    actionsPerMin: z.number().positive().optional(), maxSubagents: z.number().int().nonnegative().optional(),
    maxDepth: z.number().int().nonnegative().optional(), tokenBudget: z.number().nonnegative().optional(),
    loopThreshold: z.number().int().positive().optional(), maxSessionMinutes: z.number().positive().optional(),
  }).optional(),
  promptShields: z.object({ enabled: z.boolean().optional(), scan: categoryArray.optional(), taintTtlActions: z.number().int().positive().optional() }).optional(),
  alerts: z.record(z.string(), z.array(z.enum(['teams', 'webhook', 'email']))).optional(),
  sync: z.object({ dataPolicy: z.enum(['redacted', 'full', 'metadata-only']) }).optional(),
  guardian: z.object({ authority: z.enum(['recommend', 'contain', 'autonomous']) }).optional(),
  meta: z.object({ owner: z.string().optional(), createdBy: z.string().optional(), source: z.enum(['file', 'ui', 'ai-draft']).optional(), notes: z.string().optional() }).optional(),
}).passthrough();

type ParsedLane = z.infer<typeof laneSchema>;

function laneDir(): string {
  return govConfig.lanesDir || path.join(process.cwd(), 'lanes');
}

export function parseLaneYaml(yaml: string, _workspace?: string): Lane {
  const raw = YAML.parse(yaml);
  const parsed = laneSchema.parse(raw) as ParsedLane;
  const applies = parsed.appliesTo ?? {};
  const lane: Lane = {
    ...parsed,
    appliesTo: {
      surfaces: (applies.surfaces ?? applies.platforms ?? ['*']) as (Surface | '*')[],
      agents: applies.agents ?? ['*'], repos: applies.repos ?? ['*'], users: applies.users ?? ['*'],
    },
    failMode: { ...parsed.failMode, default: parsed.failMode.default ?? 'closed', READ: parsed.failMode.READ ?? 'open' },
    approval: { ...parsed.approval, channels: parsed.approval.channels?.length ? parsed.approval.channels : ['dashboard'], timeoutSec: parsed.approval.timeoutSec ?? 120 },
    judge: { ...parsed.judge, escalateBelow: parsed.judge.escalateBelow ?? 0.7, dataPolicy: parsed.judge.dataPolicy ?? 'redacted' },
    meta: { ...parsed.meta, source: parsed.meta?.source ?? 'file' },
  };
  return lane;
}

export function validateLaneYaml(yaml: string): { ok: boolean; lane?: Lane; errors: string[] } {
  try { return { ok: true, lane: parseLaneYaml(yaml), errors: [] }; }
  catch (err) {
    if (err instanceof z.ZodError) return { ok: false, errors: err.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    return { ok: false, errors: [(err as Error).message] };
  }
}

export function validateLane(lane: unknown): { ok: boolean; lane?: Lane; errors: string[] } {
  try { return { ok: true, lane: parseLaneYaml(YAML.stringify(lane)), errors: [] }; }
  catch (err) {
    if (err instanceof z.ZodError) return { ok: false, errors: err.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    return { ok: false, errors: [(err as Error).message] };
  }
}

function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function fileSyncAutoActivate(): boolean {
  return (process.env.GOVERNANCE_LANES_AUTO_ACTIVATE ?? '').toLowerCase() === 'true';
}

async function saveFileLane(file: string): Promise<LaneRecord | null> {
  const yaml = fs.readFileSync(file, 'utf8');
  const lane = parseLaneYaml(yaml);
  const versions = await govStore().listLaneVersions(lane.id);
  const newHash = contentHash(yaml);
  // Import only content that was never stored: UI/API edits persist until the file itself changes.
  if (versions.some(v => v.yaml != null && contentHash(v.yaml) === newHash)) return null;
  lane.version = versions.length ? Math.max(...versions.map(v => v.lane.version)) + 1 : lane.version;
  const status: LaneRecord['status'] = versions.length === 0 || fileSyncAutoActivate() ? 'active' : 'proposed';
  const rec: LaneRecord = { lane, status, yaml, updatedAt: new Date().toISOString(), updatedBy: 'file-sync' };
  const saved = await govStore().saveLane(rec);
  govBus.emit('lane.updated', saved);
  return saved;
}

export async function syncLaneFilesOnce(): Promise<LaneRecord[]> {
  const dir = laneDir();
  const saved: LaneRecord[] = [];
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).filter(f => /\.ya?ml$/i.test(f)).sort()) {
      const rec = await saveFileLane(path.join(dir, name));
      if (rec) saved.push(rec);
    }
  }
  if (!await govStore().getLane('default')) {
    const rec: LaneRecord = { lane: BUILTIN_DEFAULT_LANE, status: 'active', yaml: YAML.stringify(BUILTIN_DEFAULT_LANE), updatedAt: new Date().toISOString(), updatedBy: 'builtin' };
    await govStore().saveLane(rec);
    saved.push(rec);
  }
  return saved;
}

let watching = false;
export function startLaneFileSync(): void {
  if (watching) return;
  watching = true;
  const resync = () => {
    void syncLaneFilesOnce().catch(err => {
      if (String((err as Error).message ?? err).includes('not initialised')) setTimeout(resync, 1000).unref?.();
      else console.warn('[lanes] sync failed:', err);
    });
  };
  resync();
  const dir = laneDir();
  if (!fs.existsSync(dir)) return;
  try { fs.watch(dir, { persistent: false }, (_event, file) => { if (!file || /\.ya?ml$/i.test(String(file))) resync(); }); } catch { /* ignore */ }
  for (const name of fs.readdirSync(dir).filter(f => /\.ya?ml$/i.test(f))) {
    fs.watchFile(path.join(dir, name), { interval: 2000 }, resync);
  }
}
