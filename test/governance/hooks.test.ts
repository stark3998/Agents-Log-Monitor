import express from 'express';
import http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Decision } from '../../src/governance/types';

vi.mock('../../src/governance/pdp', () => ({ decide: vi.fn() }));
vi.mock('../../src/pipeline', () => ({ processNormalizedEvent: vi.fn() }));

import { decide } from '../../src/governance/pdp';
import router from '../../src/governance/hooks/router';
import * as claude from '../../src/governance/hooks/claude-code';
import * as copilot from '../../src/governance/hooks/copilot';
import * as vscode from '../../src/governance/hooks/vscode';

const decideMock = vi.mocked(decide);

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'd1',
    requestId: 'r1',
    sessionId: 's1',
    agentId: 'agent',
    laneId: 'lane',
    laneVersion: 1,
    mode: 'enforce',
    checkpoint: 'pre_tool',
    verdict: 'allow',
    effectiveVerdict: 'allow',
    wouldDeny: false,
    stage: 'rules_allow',
    reason: 'ok',
    ruleIds: [],
    tainted: false,
    latencyMs: 3,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('hook adapters', () => {
  it('maps Claude Code PreToolUse payloads to governance requests', () => {
    const req = claude.toActionRequest({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      agent_id: 'sub1',
      agent_type: 'Explore',
      parent_agent_id: 'main',
      cwd: 'C:\\repo',
      permission_mode: 'bypassPermissions',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_use_id: 'toolu_1',
    });

    expect(req).toMatchObject({
      requestId: 'toolu_1',
      sessionId: 's1',
      checkpoint: 'pre_tool',
      toolName: 'Bash',
      args: { command: 'npm test' },
      agent: { surface: 'claude-code', externalId: 'sub1', parentAgentId: 'main', depth: 1, cwd: 'C:\\repo' },
      meta: { permission_mode: 'bypassPermissions' },
    });
  });

  it('returns Claude Code native allow, deny, ask, and neutral observe JSON', () => {
    const payload = { hook_event_name: 'PreToolUse' };

    expect(claude.toNativeResponse(decision({ verdict: 'allow', reason: 'safe' }), payload)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow', permissionDecisionReason: 'safe' },
    });

    expect(claude.toNativeResponse(decision({ verdict: 'deny', effectiveVerdict: 'deny', reason: 'not in lane' }), payload)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('Blocked by governance policy: not in lane') },
    });

    expect(claude.toNativeResponse(decision({ verdict: 'ask', effectiveVerdict: 'ask', reason: 'needs human' }), payload)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: expect.stringContaining('needs human') },
    });

    expect(claude.toNativeResponse(decision({ mode: 'observe', verdict: 'allow', effectiveVerdict: 'deny', wouldDeny: true, reason: 'observe only' }), payload)).toEqual({});
    expect(claude.toNativeResponse(decision({ verdict: 'allow', stage: 'fail_mode', reason: 'fail open' }), payload)).toEqual({});
    expect(claude.toNativeResponse(decision({ verdict: 'allow', stage: 'default', reason: 'default allow' }), payload)).toEqual({});
  });

  it('only emits native allow for explicit grants across hook adapters', () => {
    const explicit = decision({ verdict: 'allow', stage: 'judge_fast', reason: 'judge allowed' });
    const failOpen = decision({ verdict: 'allow', stage: 'fail_mode', reason: 'fail open' });
    const observed = decision({ mode: 'observe', verdict: 'allow', effectiveVerdict: 'allow', stage: 'rules_allow', reason: 'observe allow' });

    expect(copilot.toNativeResponse(explicit, { hookEventName: 'preToolUse' })).toMatchObject({ permissionDecision: 'allow' });
    expect(copilot.toNativeResponse(failOpen, { hookEventName: 'preToolUse' })).toEqual({});
    expect(copilot.toNativeResponse(observed, { hookEventName: 'preToolUse' })).toEqual({});

    expect(vscode.toNativeResponse(explicit, { hook_event_name: 'PreToolUse' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(vscode.toNativeResponse(failOpen, { hook_event_name: 'PreToolUse' })).toEqual({});
    expect(vscode.toNativeResponse(observed, { hook_event_name: 'PreToolUse' })).toEqual({});

    expect(claude.toNativeResponse(decision({ verdict: 'allow', stage: 'human', reason: 'approved' }), { hook_event_name: 'PermissionRequest' })).toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
    expect(claude.toNativeResponse(failOpen, { hook_event_name: 'PermissionRequest' })).toEqual({});
  });

  it('maps Copilot payloads and cloud ask decisions', () => {
    const req = copilot.toActionRequest({
      hookEventName: 'preToolUse',
      sessionId: 's2',
      cwd: 'C:\\repo',
      toolName: 'bash',
      toolArgs: { command: 'git status' },
    }, 'copilot-cloud-agent');

    expect(req).toMatchObject({
      sessionId: 's2',
      checkpoint: 'pre_tool',
      toolName: 'bash',
      args: { command: 'git status' },
      agent: { surface: 'copilot-cloud-agent', externalId: 'copilot-cloud-agent' },
    });

    expect(copilot.toNativeResponse(decision({ verdict: 'ask', effectiveVerdict: 'ask', reason: 'approval needed' }), { hookEventName: 'preToolUse' }, 'copilot-cloud-agent')).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('approval needed'),
    });
  });

  it('maps VS Code Local user prompts without blocking prompt submission', () => {
    const req = vscode.toActionRequest({
      hook_event_name: 'UserPromptSubmit',
      session_id: 's3',
      cwd: 'C:\\repo',
      prompt: 'Delete production data',
    });
    expect(req).toMatchObject({ checkpoint: 'goal', text: 'Delete production data', agent: { surface: 'vscode' } });

    expect(vscode.toNativeResponse(decision({ checkpoint: 'goal', verdict: 'deny', effectiveVerdict: 'deny', reason: 'unsafe goal' }), { hook_event_name: 'UserPromptSubmit' })).toEqual({});
  });

  it('does not block non-enforcement hook phases even on deny verdicts', () => {
    const deniedStop = decision({ checkpoint: 'response', verdict: 'deny', effectiveVerdict: 'deny', reason: 'stop error' });
    expect(claude.toNativeResponse(deniedStop, { hook_event_name: 'Stop', stop_hook_active: true })).toEqual({});
    expect(copilot.toNativeResponse(deniedStop, { hookEventName: 'agentStop' })).toEqual({});
    expect(vscode.toNativeResponse(deniedStop, { hook_event_name: 'Stop' })).toEqual({});

    const deniedPost = decision({ checkpoint: 'tool_result', verdict: 'deny', effectiveVerdict: 'deny', reason: 'tainted' });
    expect(claude.toNativeResponse(deniedPost, { hook_event_name: 'PostToolUse' })).toEqual({});
    expect(vscode.toNativeResponse(deniedPost, { hook_event_name: 'PostToolUse' })).toEqual({});
  });
});

describe('governance hook router', () => {
  async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
    const app = express();
    app.use(express.json());
    app.use('/hooks', router);
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listen failed');
    try {
      return await fn(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  }

  it('blocks Copilot CLI preToolUse with a native JSON decision', async () => {
    decideMock.mockResolvedValueOnce(decision({ verdict: 'deny', effectiveVerdict: 'deny', reason: 'shell command out of lane' }));

    await withServer(async baseUrl => {
      const res = await fetch(`${baseUrl}/hooks/copilot-cli`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hookEventName: 'preToolUse', sessionId: 's1', cwd: 'C:\\repo', toolName: 'bash', toolArgs: { command: 'curl example.com' } }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('shell command out of lane'),
      });
    });

    expect(decideMock).toHaveBeenCalledWith(expect.objectContaining({
      checkpoint: 'pre_tool',
      agent: expect.objectContaining({ surface: 'copilot-cli' }),
    }), expect.objectContaining({ blocking: true, supportsAsk: true, deadlineMs: 110000 }));
  });

  it('returns a neutral response for non-enforcing events without calling the PDP', async () => {
    await withServer(async baseUrl => {
      const res = await fetch(`${baseUrl}/hooks/claude-code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hook_event_name: 'Notification', session_id: 's1', message: 'hello' }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({});
    });

    expect(decideMock).not.toHaveBeenCalled();
  });
});
