import { describe, expect, it } from 'vitest';
import { copilotCliHooksCollector } from '../src/collectors/copilot-cli-hooks';

describe('Copilot CLI hook collector', () => {
  it('maps PascalCase hook payloads with hook capture channel', () => {
    const common = { session_id: 's1', timestamp: '2026-01-01T00:00:00Z', cwd: 'C:\\repo' };

    const pre = copilotCliHooksCollector.normalize({ ...common, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } });
    expect(pre[0]).toMatchObject({ captureChannel: 'hook', eventType: 'tool_call', rawEventName: 'PreToolUse', toolName: 'Bash', status: 'pending', cwd: 'C:\\repo' });
    expect(pre[0].payload).toMatchObject({ tool_input: { command: 'echo hi' } });

    const post = copilotCliHooksCollector.normalize({ ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_result: { result_type: 'text', text_result_for_llm: 'done' } });
    expect(post[0]).toMatchObject({ captureChannel: 'hook', eventType: 'tool_result', rawEventName: 'PostToolUse', toolName: 'Bash', status: 'success', scanText: 'done' });
    expect(post[0].payload).toMatchObject({ tool_result: 'done' });

    const failure = copilotCliHooksCollector.normalize({ ...common, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'failed', tool_result: { text_result_for_llm: 'bad' } });
    expect(failure[0]).toMatchObject({ captureChannel: 'hook', eventType: 'tool_result', rawEventName: 'PostToolUseFailure', status: 'error', errorText: 'failed', scanText: 'bad' });

    const prompt = copilotCliHooksCollector.normalize({ ...common, hook_event_name: 'UserPromptSubmit', prompt: 'Build it' });
    expect(prompt[0]).toMatchObject({ captureChannel: 'hook', eventType: 'prompt', rawEventName: 'UserPromptSubmit' });
    expect(prompt[0].payload).toMatchObject({ prompt: 'Build it' });
  });

  it('maps camelCase postToolUse payloads', () => {
    const events = copilotCliHooksCollector.normalize({ sessionId: 's2', hookEventName: 'postToolUse', toolName: 'Read', toolResult: { textResultForLlm: 'file contents' } });
    expect(events[0]).toMatchObject({ captureChannel: 'hook', eventType: 'tool_result', rawEventName: 'postToolUse', toolName: 'Read', status: 'success', scanText: 'file contents' });
    expect(events[0].payload).toMatchObject({ tool_result: 'file contents' });
  });
});