import { localIdentity } from '../../analytics/identity';
import type { ActionRequest, Checkpoint, Decision, Surface } from '../types';
import { decisionReason } from './reason';

type Raw = Record<string, unknown>;

function s(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function eventName(payload: Raw): string {
  const named = s(payload.hook_event_name) ?? s(payload.hookEventName) ?? s(payload.hookType);
  if (named) return named;
  if (payload.toolResult !== undefined || payload.tool_result !== undefined) return 'postToolUse';
  if (payload.error !== undefined && (payload.toolName !== undefined || payload.tool_name !== undefined)) return 'postToolUseFailure';
  if (payload.toolName !== undefined || payload.tool_name !== undefined) return 'preToolUse';
  if (payload.prompt !== undefined) return 'userPromptSubmitted';
  if (payload.stopReason !== undefined || payload.stop_reason !== undefined || payload.transcriptPath !== undefined || payload.transcript_path !== undefined) return 'agentStop';
  if (payload.agentName !== undefined || payload.agent_name !== undefined) return 'subagentStart';
  return 'unknown';
}

function checkpointFor(name: string): Checkpoint | null {
  switch (name.toLowerCase()) {
    case 'pretooluse':
    case 'permissionrequest':
      return 'pre_tool';
    case 'userpromptsubmitted':
    case 'userpromptsubmit':
      return 'goal';
    case 'posttooluse':
    case 'posttoolusefailure':
      return 'tool_result';
    case 'subagentstart':
      return 'spawn';
    case 'agentstop':
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

function iso(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}

function resultText(payload: Raw): string | undefined {
  const tr = (payload.tool_result ?? payload.toolResult) as Raw | string | undefined;
  if (typeof tr === 'string') return tr;
  return s(tr?.text_result_for_llm) ?? s(tr?.textResultForLlm) ?? s(payload.error) ?? stringify(tr);
}

function requestId(payload: Raw, sessionId: string, name: string): string {
  return s(payload.tool_use_id) ?? s(payload.toolUseId) ?? s(payload.id) ?? `${sessionId}:${name}:${s(payload.timestamp) ?? Date.now()}`;
}

export function toActionRequest(payload: unknown, surface: Surface = 'copilot-cli'): ActionRequest | null {
  const p = (payload ?? {}) as Raw;
  const name = eventName(p);
  const checkpoint = checkpointFor(name);
  if (!checkpoint) return null;

  const sessionId = s(p.session_id) ?? s(p.sessionId) ?? 'unknown-session';
  const local = surface === 'copilot-cloud-agent' ? undefined : localIdentity();
  const toolName = s(p.tool_name) ?? s(p.toolName);
  const agentId = s(p.agent_id) ?? s(p.agentId) ?? s(p.agent_name) ?? s(p.agentName) ?? (surface === 'copilot-cloud-agent' ? 'copilot-cloud-agent' : 'copilot-cli');

  return {
    requestId: requestId(p, sessionId, name),
    sessionId,
    checkpoint,
    agent: {
      surface,
      externalId: agentId,
      name: s(p.agent_display_name) ?? s(p.agentDisplayName) ?? s(p.agent_type) ?? s(p.agentType),
      user: s(p.user) ?? local?.user,
      endpoint: s(p.endpoint) ?? local?.endpoint,
      parentAgentId: s(p.parent_agent_id) ?? s(p.parentAgentId),
      depth: typeof p.depth === 'number' && Number.isFinite(p.depth) ? p.depth : undefined,
      cwd: s(p.cwd),
      repo: s(p.repository) ?? s(p.repo),
    },
    toolName,
    mcpServer: toolName?.match(/^mcp__([^_]+)__/i)?.[1],
    args: p.tool_input ?? p.toolArgs ?? p.toolInput,
    result: checkpoint === 'tool_result' ? resultText(p) : undefined,
    text: checkpoint === 'goal'
      ? s(p.prompt)
      : checkpoint === 'response'
        ? (s(p.response) ?? s(p.last_assistant_message) ?? s(p.lastAssistantMessage) ?? s(p.stop_reason) ?? s(p.stopReason))
        : undefined,
    occurredAt: iso(p.timestamp),
    meta: {
      hook_event_name: name,
      transcript_path: p.transcript_path ?? p.transcriptPath,
      stop_hook_active: p.stop_hook_active ?? p.stopHookActive,
      cloud: surface === 'copilot-cloud-agent',
    },
  };
}

function blockReason(decision: Decision): string {
  return decisionReason(decision);
}

function finalVerdict(decision: Decision, askSupported: boolean): 'allow' | 'deny' | 'ask' {
  if (decision.verdict === 'ask') return askSupported ? 'ask' : 'deny';
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

export function toNativeResponse(decision: Decision | null, payload: unknown, surface: Surface = 'copilot-cli'): Record<string, unknown> {
  if (!decision) return {};
  const name = eventName((payload ?? {}) as Raw);
  const lower = name.toLowerCase();
  const v = finalVerdict(decision, surface !== 'copilot-cloud-agent');
  const reason = blockReason(decision);

  if (lower === 'pretooluse') {
    if (v === 'allow' && !isExplicitGrant(decision)) return {};
    return {
      permissionDecision: v,
      permissionDecisionReason: v === 'allow' && !decision.wouldDeny ? decision.reason : reason,
    };
  }

  if (lower === 'permissionrequest') {
    if (v === 'allow' && !isExplicitGrant(decision)) return {};
    return v === 'allow'
      ? { behavior: 'allow', message: decision.reason }
      : { behavior: 'deny', message: reason };
  }

  if (!isBlockingCheckpoint(lower)) return {};
  if (v === 'allow') return {};

  return {};
}
