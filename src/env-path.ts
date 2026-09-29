import path from 'path';

/**
 * Path of the `.env` file the process reads: `AGENT_MONITOR_ENV_FILE` if set (`none`/`off` disables),
 * otherwise `<repo root>/.env`. Side-effect free so it can be used outside entry points.
 */
export function resolveEnvFile(): string | null {
  const configured = process.env.AGENT_MONITOR_ENV_FILE?.trim();
  if (configured) return /^(?:none|off|false|0)$/i.test(configured) ? null : path.resolve(configured);
  // Works from both src/ (ts-node) and dist/ (compiled): the parent is the repo root.
  return path.join(__dirname, '..', '.env');
}
