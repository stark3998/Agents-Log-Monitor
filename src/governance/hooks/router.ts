import { Router, type Request, type Response } from 'express';
import type { Collector, NormalizedEvent } from '../../collectors/types';
import { claudeCodeCollector } from '../../collectors/claude-code';
import { copilotCliHooksCollector } from '../../collectors/copilot-cli-hooks';
import { processNormalizedEvent } from '../../pipeline';
import { decide } from '../pdp';
import type { ActionRequest, Decision, Surface } from '../types';
import * as claudeCode from './claude-code';
import * as copilot from './copilot';
import * as vscode from './vscode';

type Adapter = {
  toActionRequest(payload: unknown): ActionRequest | null;
  toNativeResponse(decision: Decision | null, payload: unknown): Record<string, unknown>;
};

const router = Router();

function hookDeadlineMs(): number {
  const n = Number(process.env.HOOK_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 ? n : 110_000;
}

function supportsNativeAsk(surface: Surface, action: ActionRequest): boolean {
  const event = String(action.meta?.hook_event_name ?? '').toLowerCase();
  return surface !== 'copilot-cloud-agent' && action.checkpoint === 'pre_tool' && event === 'pretooluse';
}

function policyFor(decision: Decision | null): NormalizedEvent['policy'] | undefined {
  if (!decision) return undefined;
  const label = decision.wouldDeny && decision.verdict === 'allow'
    ? `would-deny: ${decision.reason}`
    : decision.reason;
  if (decision.wouldDeny && decision.verdict === 'allow') return { outcome: 'approved', label };
  if (decision.verdict === 'ask') return { outcome: 'prompted', label };
  if (decision.verdict === 'deny' || decision.effectiveVerdict === 'deny') return { outcome: 'blocked', label };
  return { outcome: 'approved', label };
}

function forwardTelemetry(raw: unknown, collector: Collector, decision: Decision | null): void {
  setImmediate(() => {
    try {
      const policy = policyFor(decision);
      for (const event of collector.normalize(raw)) {
        if (policy) event.policy = policy;
        processNormalizedEvent(event, collector.id);
      }
    } catch (err) {
      console.error(`[governance hooks] telemetry normalize error for ${collector.id}:`, err);
    }
  });
}

function decisionError(surface: Surface, action: ActionRequest, err: unknown): Decision {
  const failMode = (process.env.AGENT_GOVERNANCE_FAIL_MODE ?? 'open').toLowerCase() === 'closed' ? 'closed' : 'open';
  const reason = err instanceof Error ? err.message : String(err);
  return {
    id: `hook-error-${Date.now()}`,
    requestId: action.requestId,
    sessionId: action.sessionId,
    agentId: action.agent.externalId ?? surface,
    laneId: 'unknown',
    laneVersion: 0,
    mode: 'enforce',
    checkpoint: action.checkpoint,
    toolName: action.toolName,
    verdict: failMode === 'closed' ? 'deny' : 'allow',
    effectiveVerdict: failMode === 'closed' ? 'deny' : 'allow',
    wouldDeny: false,
    stage: 'fail_mode',
    reason: failMode === 'closed' ? `PDP unavailable: ${reason}` : `PDP unavailable; fail-open: ${reason}`,
    ruleIds: [],
    tainted: false,
    latencyMs: 0,
    createdAt: new Date().toISOString(),
  };
}

async function handleHook(req: Request, res: Response, adapter: Adapter, collector: Collector, surface: Surface): Promise<void> {
  const action = adapter.toActionRequest(req.body);
  if (!action) {
    res.status(200).json(adapter.toNativeResponse(null, req.body));
    forwardTelemetry(req.body, collector, null);
    return;
  }

  let decision: Decision;
  try {
    decision = await decide(action, {
      blocking: true,
      supportsAsk: supportsNativeAsk(surface, action),
      deadlineMs: hookDeadlineMs(),
    });
  } catch (err) {
    decision = decisionError(surface, action, err);
  }

  res.status(200).json(adapter.toNativeResponse(decision, req.body));
  forwardTelemetry(req.body, collector, decision);
}

router.post('/claude-code', (req, res) => {
  void handleHook(req, res, claudeCode, claudeCodeCollector, 'claude-code');
});

router.post('/copilot-cli', (req, res) => {
  void handleHook(req, res, copilot, copilotCliHooksCollector, 'copilot-cli');
});

router.post('/vscode', (req, res) => {
  void handleHook(req, res, vscode, copilotCliHooksCollector, 'vscode');
});

router.post('/copilot-cloud-agent', (req, res) => {
  const cloudAdapter: Adapter = {
    toActionRequest: payload => copilot.toActionRequest(payload, 'copilot-cloud-agent'),
    toNativeResponse: (decision, payload) => copilot.toNativeResponse(decision, payload, 'copilot-cloud-agent'),
  };
  void handleHook(req, res, cloudAdapter, copilotCliHooksCollector, 'copilot-cloud-agent');
});

export default router;
