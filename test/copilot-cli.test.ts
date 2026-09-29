import fs from 'fs';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { mapLine, readLines, slim } from '../src/collectors/copilot-cli';

function state() {
  return { sessionId: 'session-1', toolNames: new Map<string, string>(), permissions: new Map<string, string>() };
}

describe('Copilot CLI log mapping', () => {
  it('maps session, prompt, assistant, tool, subagent, mode, and permission events', () => {
    const st = state();
    const start = mapLine({ type: 'session.start', id: '1', timestamp: '2026-01-01T00:00:00Z', data: { selectedModel: 'gpt-test', context: { cwd: 'C:\\repo', repository: 'repo', branch: 'main' } } }, st);
    expect(start[0]).toMatchObject({ eventType: 'lifecycle', rawEventName: 'SessionStart', model: 'gpt-test', cwd: 'C:\\repo' });

    const user = mapLine({ type: 'user.message', id: '2', timestamp: '2026-01-01T00:00:01Z', data: { content: 'hello agent' } }, st);
    expect(user[0]).toMatchObject({ eventType: 'prompt', rawEventName: 'UserPromptSubmit', scanText: 'hello agent' });

    const assistant = mapLine({ type: 'assistant.message', id: '3', timestamp: '2026-01-01T00:00:02Z', data: { model: 'gpt-test', reasoningText: 'thinking', content: 'answer' } }, st);
    expect(assistant.map(e => e.eventType)).toEqual(['thinking', 'assistant_text']);
    expect(new Set(assistant.map(e => e.externalId)).size).toBe(2);

    const call = mapLine({ type: 'tool.execution_start', id: '4', timestamp: '2026-01-01T00:00:03Z', agentId: 'agent-1', data: { toolCallId: 'tool-1', toolName: 'search_code', mcpServerName: 'github', arguments: { query: 'x' } } }, st);
    expect(call[0]).toMatchObject({ eventType: 'tool_call', agentId: 'agent-1', toolUseId: 'tool-1', toolName: 'search_code' });
    expect(call[0].payload).toMatchObject({ mcpServerName: 'github', tool_input: { query: 'x' } });

    const result = mapLine({ type: 'tool.execution_complete', id: '5', timestamp: '2026-01-01T00:00:04Z', data: { toolCallId: 'tool-1', success: false, error: { message: 'boom' }, result: { content: 'failed' } } }, st);
    expect(result[0]).toMatchObject({ eventType: 'tool_result', status: 'error', errorText: 'boom', toolName: 'search_code' });

    const subStart = mapLine({ type: 'subagent.started', id: '6', timestamp: '2026-01-01T00:00:05Z', agentId: 'agent-2', data: { agentType: 'reviewer', model: 'gpt-test' } }, st);
    expect(subStart[0]).toMatchObject({ rawEventName: 'SubagentStart', parentAgentId: 'main', agentType: 'reviewer' });

    const subDone = mapLine({ type: 'subagent.completed', id: '7', timestamp: '2026-01-01T00:00:06Z', agentId: 'agent-2', data: { totalToolCalls: 2, cancelled: false } }, st);
    expect(subDone[0]).toMatchObject({ rawEventName: 'SubagentStop', status: 'success' });

    expect(mapLine({ type: 'session.mode_changed', id: '8', timestamp: '2026-01-01T00:00:07Z', data: { previousMode: 'assisted', newMode: 'autopilot' } }, st)[0].autonomyLevel).toBe(3);
    expect(mapLine({ type: 'session.permissions_changed', id: '9', timestamp: '2026-01-01T00:00:08Z', data: { allowAllPermissions: true } }, st)[0].autonomyLevel).toBe(3);

    const requested = mapLine({ type: 'permission.requested', id: '10', timestamp: '2026-01-01T00:00:09Z', data: { requestId: 'perm-1', permissionRequest: { kind: 'command', command: 'git push', toolCallId: 'tool-2' } } }, st);
    expect(requested[0].policy).toMatchObject({ outcome: 'prompted' });
    const completed = mapLine({ type: 'permission.completed', id: '11', timestamp: '2026-01-01T00:00:10Z', data: { requestId: 'perm-1', result: { kind: 'denied_by_user' }, toolCallId: 'tool-2' } }, st);
    expect(completed[0].policy).toMatchObject({ outcome: 'denied' });

    expect(mapLine({ type: 'unknown.type', id: '12', timestamp: '2026-01-01T00:00:11Z', data: {} }, st)).toEqual([]);
  });

  it('recovers completed tool names through the lookup callback', () => {
    const st = state();
    const events = mapLine({ type: 'tool.execution_complete', id: 'lookup', timestamp: '2026-01-01T00:00:00Z', data: { toolCallId: 'tool-x', success: true, result: 'ok' } }, st, id => id === 'tool-x' ? 'Bash' : undefined);
    expect(events[0]).toMatchObject({ toolName: 'Bash', status: 'success' });
  });

  it('slims large payloads without mutating scalar meaning', () => {
    expect(slim('abcdef', 3)).toBe('abc…');
    expect(slim({ value: 'abcdef' }, 4)).toEqual({ value: 'abcd…' });
  });
});

describe('Copilot CLI line reader', () => {
  const artifactDir = path.join(process.cwd(), 'test', '.artifacts');
  const file = path.join(artifactDir, 'events.jsonl');

  afterAll(() => {
    try { fs.rmSync(artifactDir, { recursive: true, force: true }); } catch {}
  });

  it('returns only complete lines and leaves the offset after the final newline', () => {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(file, 'one\ntwo\npartial', 'utf8');
    const result = readLines(file, 0, 1024);
    expect(result.lines).toEqual(['one', 'two']);
    expect(result.newOffset).toBe(Buffer.byteLength('one\ntwo\n'));
    expect(result.more).toBe(true);
  });
});