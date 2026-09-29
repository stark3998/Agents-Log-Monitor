import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { ActionRequest, AgentStatus, Decision, Lane } from '../../src/governance/types';

const mockJudge = vi.hoisted(() => ({
  available: false,
  calls: [] as unknown[],
  verdict: { verdict: 'allow' as const, confidence: 0.9, rationale: 'mock allow', model: 'mock', tier: 'fast' as const, latencyMs: 1 },
}));
const mockShields = vi.hoisted(() => ({ available: true, attack: false }));

vi.mock('../../src/governance/judge', () => ({
  judge: {
    get available() { return mockJudge.available; },
    evaluate: vi.fn(async (input, tier) => {
      mockJudge.calls.push(input);
      return { ...mockJudge.verdict, tier };
    }),
  },
  extractGoal: vi.fn(async () => null),
}));

vi.mock('../../src/governance/shields', () => ({
  shields: {
    get available() { return mockShields.available; },
    scanDocuments: vi.fn(async () => ({
      attackDetected: mockShields.attack,
      kind: 'document',
      detail: 'mock prompt-shields attack',
      latencyMs: 1,
      scanned: true,
    })),
  },
}));

const dir = path.join(process.cwd(), '.test-data');
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, `redteam-${process.pid}-${Date.now()}.db`);
process.env.AGENT_MONITOR_DB = dbFile;
process.env.GOVERNANCE_ENFORCE = 'true';

interface ExpectedDecision {
  verdict: Decision['effectiveVerdict'];
  actualVerdict?: Decision['verdict'];
  stageIn?: Decision['stage'][];
  ruleIdIncludes?: string;
  reasonIncludes?: string;
  wouldDeny?: boolean;
  judgeCalled?: boolean;
}

type Step = Partial<ActionRequest> & {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  prompt?: string;
  tool_result?: unknown;
  expect: ExpectedDecision;
  shieldAttack?: boolean;
  shieldAvailable?: boolean;
  approvalDecision?: 'approved' | 'denied';
  deadlineMs?: number;
  judge?: Partial<typeof mockJudge.verdict> & { available?: boolean };
};

interface Scenario {
  id: string;
  description?: string;
  laneYaml?: string;
  agentStatus?: AgentStatus;
  judge?: Step['judge'];
  steps: Step[];
}

type Db = typeof import('../../src/db');
let db: Db;
let store: import('../../src/governance/store/repository').GovernanceStore;
let decide: typeof import('../../src/governance/pdp').decide;
let parseLaneYaml: typeof import('../../src/governance/lanes/loader').parseLaneYaml;
let toActionRequest: typeof import('../../src/governance/hooks/claude-code').toActionRequest;
let approvalsSvc: typeof import('../../src/governance/approvals');

beforeAll(async () => {
  db = await import('../../src/db');
  const storeMod = await import('../../src/governance/store');
  const sqliteMod = await import('../../src/governance/store/sqlite');
  await db.initDb();
  store = new sqliteMod.SqliteGovernanceStore();
  await store.init();
  storeMod.setGovernanceStore(store);
  ({ decide } = await import('../../src/governance/pdp'));
  ({ parseLaneYaml } = await import('../../src/governance/lanes/loader'));
  ({ toActionRequest } = await import('../../src/governance/hooks/claude-code'));
  approvalsSvc = await import('../../src/governance/approvals');
});

afterAll(() => {
  db.flushDb();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

function loadScenarios(): Scenario[] {
  const scenarioDir = path.join(process.cwd(), 'test', 'redteam', 'scenarios');
  return fs.readdirSync(scenarioDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(scenarioDir, f), 'utf8')) as Scenario);
}

function defaultLaneYaml(scenarioId: string): string {
  const base = fs.readFileSync(path.join(process.cwd(), 'lanes', 'coding-agent.yaml'), 'utf8');
  return base
    .replace(/^id:\s*.*$/m, `id: rt-default-${scenarioId}`)
    .replace(/^mode:\s*.*$/m, 'mode: enforce');
}

async function saveLaneFor(scenario: Scenario): Promise<Lane> {
  const yaml = scenario.laneYaml ?? defaultLaneYaml(scenario.id);
  const lane = parseLaneYaml(yaml, process.cwd());
  await store.saveLane({ lane, status: 'active', yaml, updatedAt: new Date().toISOString(), updatedBy: 'redteam-test' });
  return lane;
}

async function registerAgent(scenario: Scenario, lane: Lane): Promise<string> {
  const now = new Date().toISOString();
  const id = `rt-agent-${scenario.id}`;
  await store.upsertAgent({
    id,
    name: scenario.id,
    surface: 'claude-code',
    externalId: `rt-${scenario.id}`,
    status: scenario.agentStatus ?? 'active',
    statusReason: scenario.agentStatus ? `scenario ${scenario.agentStatus}` : undefined,
    laneId: lane.id,
    discovered: false,
    firstSeenAt: now,
    lastSeenAt: now,
  });
  return id;
}

function substituteWorkspace<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/__WORKSPACE__/g, process.cwd()) as T;
  if (Array.isArray(value)) return value.map(v => substituteWorkspace(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteWorkspace(v)])) as T;
  }
  return value;
}

function stepToRequest(scenario: Scenario, step: Step, index: number, agentId: string): ActionRequest {
  const shaped = substituteWorkspace(step);
  if (shaped.hook_event_name) {
    const req = toActionRequest(shaped);
    if (!req) throw new Error(`${scenario.id} step ${index}: hook payload did not convert to ActionRequest`);
    return { ...req, agent: { ...req.agent, agentId } };
  }
  return {
    requestId: shaped.requestId ?? `${scenario.id}-${index}`,
    sessionId: shaped.sessionId ?? scenario.id,
    checkpoint: shaped.checkpoint ?? 'pre_tool',
    agent: {
      surface: 'claude-code',
      agentId,
      externalId: `rt-${scenario.id}`,
      cwd: process.cwd(),
      ...(shaped.agent ?? {}),
    },
    toolName: shaped.toolName,
    category: shaped.category,
    mcpServer: shaped.mcpServer,
    args: shaped.args,
    result: shaped.result,
    text: shaped.text,
    tokens: shaped.tokens,
    occurredAt: shaped.occurredAt,
    meta: shaped.meta,
  };
}

function configureJudge(scenario: Scenario, step: Step): void {
  const cfg = step.judge ?? scenario.judge;
  mockJudge.calls = [];
  if (!cfg) {
    mockJudge.available = false;
    mockJudge.verdict = { verdict: 'allow', confidence: 0.9, rationale: 'mock allow', model: 'mock', tier: 'fast', latencyMs: 1 };
    return;
  }
  mockJudge.available = cfg.available ?? true;
  mockJudge.verdict = {
    verdict: cfg.verdict ?? 'allow',
    confidence: cfg.confidence ?? 0.9,
    rationale: cfg.rationale ?? 'mock judge',
    model: cfg.model ?? 'mock',
    tier: 'fast',
    latencyMs: cfg.latencyMs ?? 1,
  };
}

async function resolveApproval(req: ActionRequest, decision: 'approved' | 'denied'): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const pending = await store.listApprovals({ sessionId: req.sessionId, state: ['pending'] });
    const approval = pending.find(a => a.requestId === req.requestId);
    if (approval) {
      await approvalsSvc.approvals.resolve(approval.id, decision, 'redteam-test', `scenario ${decision}`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`approval was not created for ${req.sessionId}/${req.requestId}`);
}

function decisionMessage(scenario: Scenario, stepIndex: number, d: Decision): string {
  return `${scenario.id} step ${stepIndex}: got effective=${d.effectiveVerdict}, verdict=${d.verdict}, stage=${d.stage}, reason="${d.reason}", ruleIds=[${d.ruleIds.join(', ')}]`;
}

function assertDecision(scenario: Scenario, stepIndex: number, d: Decision, expected: ExpectedDecision): void {
  const msg = decisionMessage(scenario, stepIndex, d);
  expect(d.effectiveVerdict, msg).toBe(expected.verdict);
  if (expected.actualVerdict) expect(d.verdict, msg).toBe(expected.actualVerdict);
  if (expected.stageIn) expect(expected.stageIn, msg).toContain(d.stage);
  if (expected.ruleIdIncludes) {
    expect(d.ruleIds.some(r => r.includes(expected.ruleIdIncludes!)), msg).toBe(true);
  }
  if (expected.reasonIncludes) expect(d.reason, msg).toContain(expected.reasonIncludes);
  if (expected.wouldDeny != null) expect(d.wouldDeny, msg).toBe(expected.wouldDeny);
  if (expected.judgeCalled != null) expect(mockJudge.calls.length > 0, msg).toBe(expected.judgeCalled);
}

describe('red-team scenario replay', () => {
  it('replays governance regression scenarios', async () => {
    const rows: { scenario: string; steps: number; pass: boolean }[] = [];
    try {
      for (const scenario of loadScenarios()) {
        const lane = await saveLaneFor(scenario);
        const agentId = await registerAgent(scenario, lane);
        let passed = false;
        for (let i = 0; i < scenario.steps.length; i++) {
          const step = scenario.steps[i];
          configureJudge(scenario, step);
          mockShields.available = step.shieldAvailable ?? true;
          mockShields.attack = !!step.shieldAttack;
          const req = stepToRequest(scenario, step, i, agentId);
          const decisionPromise = decide(req, {
            blocking: true,
            supportsAsk: false,
            deadlineMs: step.deadlineMs ?? 500,
          });
          const approvalPromise = step.approvalDecision ? resolveApproval(req, step.approvalDecision) : undefined;
          const d = await decisionPromise;
          if (approvalPromise) await approvalPromise;
          assertDecision(scenario, i, d, step.expect);
        }
        passed = true;
        rows.push({ scenario: scenario.id, steps: scenario.steps.length, pass: passed });
      }
    } finally {
      console.table(rows);
    }
  });
});
