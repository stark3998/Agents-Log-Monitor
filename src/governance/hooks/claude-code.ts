import { localIdentity } from '../../analytics/identity';
import type { ActionRequest, Checkpoint, Decision } from '../types';
import { decisionReason as sharedReason } from './reason';

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
    case 'permissionrequest':
      return 'pre_tool';
    case 'userpromptsubmit':
      return 'goal';
    case 'posttooluse':
    case 'posttoolusefailure':
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
  return s(payload.tool_use_id) ?? s(payload.prompt_id) ?? `${sessionId}:${name}:${Date.now()}`;
}

function depth(payload: Raw): number {
  if (typeof payload.depth === 'number' && Number.isFinite(payload.depth)) return payload.depth;
  if (Array.isArray(payload.parent_chain)) return payload.parent_chain.length;
  return s(payload.parent_agent_id) ? 1 : 0;
}

export function toActionRequest(payload: unknown): ActionRequest | null {
  const p = (payload ?? {}) as Raw;
  const name = eventName(p);
  const checkpoint = checkpointFor(name);
  if (!checkpoint) return null;

  const sessionId = s(p.session_id) ?? 'unknown-session';
  const local = localIdentity();
  const toolName = s(p.tool_name);
  const resultText = name.toLowerCase() === 'posttoolusefailure'
    ? (s(p.error) ?? stringify(p.tool_result))
    : stringify(p.tool_result ?? p.tool_response);
  const text = checkpoint === 'goal'
    ? s(p.prompt)
    : checkpoint === 'response'
      ? (s(p.last_assistant_message) ?? s(p.response) ?? s(p.stop_reason))
      : undefined;

  return {
    requestId: requestId(p, sessionId, name),
    sessionId,
    checkpoint,
    agent: {
      surface: 'claude-code',
      externalId: s(p.agent_id) ?? s(p.agent_type) ?? 'main',
      name: s(p.agent_type),
      user: local.user,
      endpoint: local.endpoint,
      parentAgentId: s(p.parent_agent_id),
      depth: depth(p),
      cwd: s(p.cwd),
    },
    toolName,
    mcpServer: toolName?.match(/^mcp__([^_]+)__/i)?.[1],
    args: p.tool_input,
    result: checkpoint === 'tool_result' ? resultText : undefined,
    text,
    tokens: p.usage && typeof p.usage === 'object'
      ? {
          input: typeof (p.usage as Raw).input_tokens === 'number' ? (p.usage as Raw).input_tokens as number : undefined,
          output: typeof (p.usage as Raw).output_tokens === 'number' ? (p.usage as Raw).output_tokens as number : undefined,
        }
      : undefined,
    occurredAt: s(p.timestamp),
    meta: {
      hook_event_name: name,
      permission_mode: p.permission_mode,
      model: p.model,
      transcript_path: p.transcript_path,
      prompt_id: p.prompt_id,
    },
  };
}

function decisionReason(decision: Decision): string {
  return sharedReason(decision);
}

function verdict(decision: Decision): 'allow' | 'deny' | 'ask' {
  if (decision.verdict === 'ask') return 'ask';
  if (decision.verdict === 'deny' || decision.verdict === 'escalate') return 'deny';
  return 'allow';
}

function isBlockingCheckpoint(lowerEventName: string): boolean {
  return lowerEventName === 'pretooluse' || lowerEventName === 'permissionrequest';
}

function isExplicitGrant(decision: Decision): boolean {
  return decision.mode !== 'observe'
    && decision.verdict === 'allow'
    && !decision.wouldDeny
    && ['rules_allow', 'judge_fast', 'judge_escalation', 'human'].includes(decision.stage);
}

export function toNativeResponse(decision: Decision | null, payload: unknown): Record<string, unknown> {
  if (!decision) return {};
  const p = (payload ?? {}) as Raw;
  const name = eventName(p);
  const lower = name.toLowerCase();
  const v = verdict(decision);
  const reason = decisionReason(decision);

  if (lower === 'permissionrequest') {
    if (v === 'allow' && !isExplicitGrant(decision)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: v === 'allow'
          ? { behavior: 'allow', message: decision.reason }
          : { behavior: 'deny', message: reason },
      },
    };
  }

  if (lower === 'pretooluse') {
    if (v === 'allow' && !isExplicitGrant(decision)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: v,
        permissionDecisionReason: v === 'allow' && !decision.wouldDeny ? decision.reason : reason,
      },
    };
  }

  if (!isBlockingCheckpoint(lower)) return {};
  if (v === 'allow') return {};

  return {};
}
