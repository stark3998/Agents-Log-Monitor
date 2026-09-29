export type ToolCategory = 'READ' | 'WRITE' | 'EXEC' | 'NETWORK' | 'AGENT' | 'MCP' | 'OTHER';

// Copilot CLI runtime names and Claude Code names mapped to one canonical (Claude-style) name,
// so hook payloads (Claude names) can be matched with log events (runtime names).
const CANONICAL: Record<string, string> = {
  bash: 'Bash', powershell: 'Bash', shell: 'Bash',
  view: 'Read', read: 'Read',
  create: 'Write', write: 'Write',
  edit: 'Edit', multiedit: 'Edit', str_replace_editor: 'Edit', apply_patch: 'Edit', notebookedit: 'Edit',
  grep: 'Grep', rg: 'Grep',
  glob: 'Glob', ls: 'Glob',
  web_fetch: 'WebFetch', webfetch: 'WebFetch',
  web_search: 'WebSearch', websearch: 'WebSearch',
  ask_user: 'AskUserQuestion', askuserquestion: 'AskUserQuestion',
  update_todo: 'TodoWrite', todowrite: 'TodoWrite',
  task: 'Agent', agent: 'Agent',
};

export function canonicalToolName(name: string | null | undefined): string {
  if (!name) return '';
  return CANONICAL[name.toLowerCase()] ?? name;
}

const CATEGORY: Record<string, ToolCategory> = {
  Bash: 'EXEC', Read: 'READ', Grep: 'READ', Glob: 'READ',
  Write: 'WRITE', Edit: 'WRITE', TodoWrite: 'OTHER',
  WebFetch: 'NETWORK', WebSearch: 'NETWORK',
  Agent: 'AGENT', AskUserQuestion: 'OTHER',
};

/** Parse `mcp__server__tool` (Claude Code) style names. */
export function mcpFromName(name: string | null | undefined): { server: string; tool: string } | null {
  if (!name) return null;
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : null;
}

export function classifyTool(name: string | null | undefined, mcpServer?: string | null): ToolCategory {
  if (mcpServer || mcpFromName(name)) return 'MCP';
  const canon = canonicalToolName(name);
  if (CATEGORY[canon]) return CATEGORY[canon];
  const n = (name ?? '').toLowerCase();
  if (/(^|_)(read|write|stop|list)_(powershell|bash|shell)$/.test(n)) return 'EXEC';
  if (/(^|_)(read|write|list)_agent$|^(task|agent)/.test(n)) return 'AGENT';
  if (/^(read|view|get|list|search|find|query|fetch_)/.test(n)) return 'READ';
  if (/^(write|create|update|delete|edit|set|put|patch|remove)/.test(n)) return 'WRITE';
  if (/(http|web|url|fetch|download)/.test(n)) return 'NETWORK';
  return 'OTHER';
}
