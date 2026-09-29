import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEYS = ['AGENT_MONITOR_ENV_FILE', 'ENV_TEST_FROM_FILE', 'ENV_TEST_SHELL_WINS', 'ENV_TEST_EMPTY', 'ENV_TEST_QUOTED'];
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

function writeEnv(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-monitor-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, content);
  return file;
}

describe('.env loader', () => {
  it('loads values without overriding the real environment or applying empty values', async () => {
    const file = writeEnv([
      '# comment',
      'ENV_TEST_FROM_FILE=from-file',
      'ENV_TEST_SHELL_WINS=from-file',
      'ENV_TEST_EMPTY=',
      'ENV_TEST_QUOTED="a#b c"',
      'AGENT_MONITOR_ENV_FILE=/elsewhere/.env',
    ].join('\n'));
    process.env.AGENT_MONITOR_ENV_FILE = file;
    process.env.ENV_TEST_SHELL_WINS = 'from-shell';
    delete process.env.ENV_TEST_FROM_FILE;
    delete process.env.ENV_TEST_EMPTY;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { ENV_FILE } = await import('../src/env');

    expect(ENV_FILE).toBe(path.resolve(file));
    expect(process.env.ENV_TEST_FROM_FILE).toBe('from-file');
    expect(process.env.ENV_TEST_SHELL_WINS).toBe('from-shell');
    expect(process.env.ENV_TEST_EMPTY).toBeUndefined();
    expect(process.env.ENV_TEST_QUOTED).toBe('a#b c');
    expect(process.env.AGENT_MONITOR_ENV_FILE).toBe(file);
  });

  it('can be disabled with AGENT_MONITOR_ENV_FILE=none', async () => {
    process.env.AGENT_MONITOR_ENV_FILE = 'none';
    const { ENV_FILE } = await import('../src/env');
    expect(ENV_FILE).toBeNull();
  });

  it('defaults to the repo root .env', async () => {
    delete process.env.AGENT_MONITOR_ENV_FILE;
    const { resolveEnvFile } = await import('../src/env-path');
    expect(resolveEnvFile()).toBe(path.join(path.resolve(__dirname, '..'), '.env'));
  });
});
