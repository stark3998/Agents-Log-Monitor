import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { govConfig } from '../../src/governance/config';
import { localRequestGuard, requireJsonForGovMutations } from '../../src/governance/auth';
import { systemGuard } from '../../src/governance/system-guard';
import type { ActionFeatures } from '../../src/governance/features';
import type { ActionRequest } from '../../src/governance/types';

const ctx = {
  port: 4317,
  dbPath: 'C:\\Users\\me\\AppData\\Local\\agent-monitor\\agent-monitor.db',
  lanesDir: 'C:\\repo\\lanes',
  envFile: 'C:\\repo\\.env',
};

function req(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    requestId: 'r1',
    sessionId: 's1',
    checkpoint: 'pre_tool',
    agent: { surface: 'copilot-cli' },
    toolName: 'Bash',
    args: {},
    ...over,
  };
}

function feat(over: Partial<ActionFeatures> = {}): ActionFeatures {
  return {
    checkpoint: 'pre_tool',
    toolName: 'Bash',
    canonicalTool: 'bash',
    category: 'EXEC',
    mcpServer: null,
    command: '',
    paths: [],
    hosts: [],
    domains: [],
    detections: [],
    risk: [],
    riskLevel: null,
    signature: 'sig',
    summary: 'summary',
    ...over,
  };
}

function mockHttpReq(method: string, headers: Record<string, string>, localPort = 4317): Request {
  return {
    method,
    socket: { localPort },
    header: (name: string) => headers[name.toLowerCase()],
    is: (type: string) => headers['content-type']?.toLowerCase().startsWith(type) ? type : false,
  } as unknown as Request;
}

function mockRes(): Response & { code?: number; body?: unknown } {
  return {
    status(c: number) { this.code = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  } as unknown as Response & { code?: number; body?: unknown };
}

beforeEach(() => {
  govConfig.mode = 'local';
  process.env.NODE_ENV = 'test';
});

describe('local request hardening', () => {
  it('rejects DNS-rebinding Host headers in local mode', () => {
    const res = mockRes();
    const next = vi.fn<NextFunction>();
    localRequestGuard(4317)(mockHttpReq('GET', { host: 'evil.test:4317' }), res, next);
    expect(res.code).toBe(421);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows same-loopback and Vite dev origins but rejects cross-site mutation origins', () => {
    const next = vi.fn<NextFunction>();
    localRequestGuard(4317)(mockHttpReq('POST', { host: '127.0.0.1:4317', origin: 'http://localhost:5173' }), mockRes(), next);
    expect(next).toHaveBeenCalledOnce();

    const res = mockRes();
    localRequestGuard(4317)(mockHttpReq('POST', { host: '127.0.0.1:4317', origin: 'https://attacker.test' }), res, vi.fn());
    expect(res.code).toBe(403);
  });

  it('requires JSON content type for mutating governance API requests', () => {
    const res = mockRes();
    requireJsonForGovMutations(mockHttpReq('POST', { 'content-type': 'text/plain' }), res, vi.fn());
    expect(res.code).toBe(415);
  });
});

describe('systemGuard', () => {
  it('denies loopback calls to the monitor port on governance endpoints', () => {
    const f = feat({ command: 'curl http://127.0.0.1:4317/api/gov/approvals/ap-1/approve', hosts: ['127.0.0.1'] });
    expect(systemGuard(req({ args: { command: f.command } }), f, ctx)).toMatchObject({ ruleId: 'system.self.network' });
  });

  it('does not deny localhost calls to a different development port', () => {
    const f = feat({ command: 'curl http://127.0.0.1:3000/api/users', hosts: ['127.0.0.1'] });
    expect(systemGuard(req({ args: { command: f.command } }), f, ctx)).toBeNull();
  });

  it('denies writes to lanes, database sidecars, hook configs, forwarders, and the .env file', () => {
    const paths = [
      'C:\\repo\\lanes\\default.yaml',
      'C:\\Users\\me\\AppData\\Local\\agent-monitor\\agent-monitor.db-wal',
      'C:\\Users\\me\\.claude\\settings.local.json',
      'C:\\repo\\.github\\hooks\\agent-governance.json',
      'C:\\repo\\scripts\\copilot-hook-forward.ps1',
      'c:/repo/.env',
    ];
    for (const p of paths) {
      const f = feat({ category: 'WRITE', toolName: 'Edit', canonicalTool: 'edit', paths: [p] });
      expect(systemGuard(req({ toolName: 'Edit', args: { file_path: p } }), f, ctx)?.ruleId).toBe('system.self.files');
    }
  });

  it('does not deny ordinary source edits or reads of governance files', () => {
    expect(systemGuard(req({ toolName: 'Edit' }), feat({ category: 'WRITE', toolName: 'Edit', paths: ['C:\\repo\\src\\app.ts'] }), ctx)).toBeNull();
    expect(systemGuard(req({ toolName: 'Read' }), feat({ category: 'READ', toolName: 'Read', paths: ['C:\\repo\\lanes\\default.yaml'] }), ctx)).toBeNull();
    expect(systemGuard(req({ toolName: 'Edit' }), feat({ category: 'WRITE', toolName: 'Edit', paths: ['C:\\repo\\.env.example'] }), ctx)).toBeNull();
  });

  it('denies Windows and POSIX process-kill shapes for monitor runtimes', () => {
    expect(systemGuard(req(), feat({ command: 'Stop-Process -Name node -Force' }), ctx)?.ruleId).toBe('system.self.process');
    expect(systemGuard(req(), feat({ command: 'kill -9 node' }), ctx)?.ruleId).toBe('system.self.process');
    expect(systemGuard(req(), feat({ command: `kill -9 ${process.pid}` }), ctx)?.ruleId).toBe('system.self.process');
  });

  it('denies governance env changes and profile persistence', () => {
    expect(systemGuard(req(), feat({ command: '$env:GOVERNANCE_TRUST_LOOPBACK=1' }), ctx)?.ruleId).toBe('system.self.env');
    const f = feat({ category: 'WRITE', toolName: 'Edit', paths: ['C:\\Users\\me\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1'] });
    expect(systemGuard(req({ toolName: 'Edit', args: { file_path: f.paths[0], content: '$env:AGENT_MONITOR_MODE="cloud"' } }), f, ctx)?.ruleId).toBe('system.self.profile-env');
  });
});
