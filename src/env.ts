import fs from 'fs';
import { parseEnv } from 'util';
import { resolveEnvFile } from './env-path';

/**
 * Loads the project `.env` (see resolveEnvFile) into process.env. Must be the first import of every
 * entry point: config modules read process.env at import time. Variables already set in the environment
 * win, and empty values are ignored so code defaults still apply.
 */
export const ENV_FILE: string | null = resolveEnvFile();

function loadEnvFile(file: string | null): void {
  if (!file || !fs.existsSync(file)) return;
  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(fs.readFileSync(file, 'utf8')) as Record<string, string>;
  } catch (err) {
    console.warn(`[env] could not read ${file}: ${(err as Error).message}`);
    return;
  }
  let loaded = 0;
  for (const [key, value] of Object.entries(parsed)) {
    // The file cannot redirect itself; the system guard relies on the path staying stable.
    if (key === 'AGENT_MONITOR_ENV_FILE' || value === '' || process.env[key] !== undefined) continue;
    process.env[key] = value;
    loaded++;
  }
  // stderr keeps stdio transports (MCP, gateway --stdio) clean.
  console.error(`[env] loaded ${loaded} variable(s) from ${file}`);
}

loadEnvFile(ENV_FILE);
