import { localIdentity } from '../../analytics/identity';
import type { ActionRequest, Checkpoint, Decision } from '../types';
import { decisionReason } from './reason';

type Raw = Record<string, unknown>;

function s(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function eventName(payload: Raw): string {
  return s(payload.hook_event_name) ?? 'unknown';
}

function checkpointFor(name: string): Checkpoint | null {
  switch (name.toLowerCase()) {
    case 'pretooluse':
      return 'pre_tool';
    case 'userpromptsubmit':
      return 'goal';
    case 'posttooluse':
      return 'tool_result';
    case 'subagentstart':
      return 'spawn';
    case 'stop':
    case 'subagentstop':
      return 'response';
    default:
      return null;
  }
}

function stringify(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function requestId(payload: Raw, sessionId: string, name: string): string {
  return s(payload.tool_use_id) ?? s(payload.agent_id) ?? `${sessionId}:${name}:${s(payload.timestamp) ?? Date.now()}`;
}

export function toActionRequest(payload: unknown): ActionRequest | null {
  const p = (payload ?? {}) as Raw;
  const name = eventName(p);
  const checkpoint = checkpointFor(name);
  if (!checkpoint) return null;

  const sessionId = s(p.session_id) ?? 'unknown-session';
  const local = localIdentity();
  const toolName = s(p.tool_name);

  return {
    requestId: requestId(p, sessionId, name),
    sessionId,
    checkpoint,
    agent: {
      surface: 'vscode',
      externalId: s(p.agent_id) ?? s(p.agent_type) ?? 'local',
      name: s(p.agent_type),
      user: local.user,
      endpoint: local.endpoint,
      depth: s(p.agent_id) ? 1 : 0,
      cwd: s(p.cwd),
    },
    toolName,
    mcpServer: toolName?.match(/^mcp__([^_]+)__/i)?.[1],
    args: p.tool_input,
    result: checkpoint === 'tool_result' ? stringify(p.tool_response ?? p.tool_result) : undefined,
    text: checkpoint === 'goal'
      ? s(p.prompt)
      : checkpoint === 'response'
        ? (s(p.last_assistant_message) ?? s(p.response) ?? s(p.stop_reason))
        : undefined,
    occurredAt: s(p.timestamp),
    meta: {
      hook_event_name: name,
      transcript_path: p.transcript_path,
      stop_hook_active: p.stop_hook_active,
    },
  };
}

function blockReason(decision: Decision): string {
  return decisionReason(decision);
}

function finalVerdict(decision: Decision): 'allow' | 'deny' | 'ask' {
  if (decision.verdict === 'ask') return 'ask';
  if (decision.verdict === 'deny' || decision.verdict === 'escalate') return 'deny';
  return 'allow';
}

function isBlockingCheckpoint(lowerEventName: string): boolean {
  return lowerEventName === 'pretooluse';
}

function isExplicitGrant(decision: Decision): boolean {
  return decision.mode !== 'observe'
    && decision.verdict === 'allow'
    && !decision.wouldDeny
    && ['rules_allow', 'judge_fast', 'judge_escalation', 'human'].includes(decision.stage);
}

export function toNativeResponse(decision: Decision | null, payload: unknown): Record<string, unknown> {
  if (!decision) return {};
  const name = eventName((payload ?? {}) as Raw);
  const lower = name.toLowerCase();
  const v = finalVerdict(decision);
  const reason = blockReason(decision);

  if (lower === 'pretooluse') {
    if (v === 'allow' && !isExplicitGrant(decision)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: v,
        permissionDecisionReason: v === 'allow' ? decision.reason : reason,
      },
    };
  }

  if (!isBlockingCheckpoint(lower)) return {};
  if (v === 'allow') return {};

  return {};
}
