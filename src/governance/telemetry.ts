/**
 * Read access to agent telemetry (sessions, timelines, tool actions) for the MCP server, the
 * Guardian and lane simulation. Local mode reads the node:sqlite event tables
 * (src/governance/telemetry-sqlite.ts); cloud mode reads Cosmos (src/governance/store/cosmos-telemetry.ts).
 */
export interface SessionSummary {
  id: string;
  agent: string;
  surface: string;
  title?: string | null;
  user?: string | null;
  endpoint?: string | null;
  projectPath?: string | null;
  startedAt?: string | null;
  lastActivityAt?: string | null;
  severity?: string | null;
  riskyActions: number;
  toolCalls: number;
}

export interface ActionRecord {
  eventId: number | string;
  sessionId: string;
  agentId: string;
  surface: string;
  occurredAt: string;
  eventType: string;
  toolName?: string | null;
  category?: string | null;
  mcpServer?: string | null;
  riskLevel?: string | null;
  status?: string | null;
  /** Redacted tool input (as stored). */
  input?: unknown;
  /** Redacted, clipped result text. */
  result?: string | null;
  findings?: { kind: string; key: string; label: string; severity?: string | null }[];
}

export interface ActionSearch {
  sessionId?: string;
  agent?: string;
  toolName?: string;
  category?: string;
  riskAtLeast?: 'low' | 'medium' | 'high' | 'critical';
  text?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface TelemetryReader {
  listSessions(q: { since?: string; until?: string; agent?: string; limit?: number }): Promise<SessionSummary[]>;
  getSessionTimeline(sessionId: string, opts?: { limit?: number; includeResults?: boolean }): Promise<ActionRecord[]>;
  searchActions(q: ActionSearch): Promise<ActionRecord[]>;
}

let _reader: TelemetryReader | null = null;
export function telemetry(): TelemetryReader {
  if (!_reader) throw new Error('telemetry reader not initialised');
  return _reader;
}
export function setTelemetryReader(r: TelemetryReader): void { _reader = r; }
