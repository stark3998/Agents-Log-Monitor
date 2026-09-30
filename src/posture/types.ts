export type PostureSeverity = 'low' | 'medium' | 'high' | 'critical';
export type PostureCategory = 'Policy Violations' | 'Configuration' | 'Permissions' | 'Vulnerabilities' | 'Credential Exposure' | 'Data Storage';
export interface PostureRemediation { summary: string; snippet?: string; snippetLang?: 'json' | 'yaml' | 'toml' | 'powershell' | 'bash' | 'text'; autoFix?: boolean; docsUrl?: string }
export interface PostureCheckDef {
  id: string;
  title: string; description: string;
  severity: PostureSeverity; category: PostureCategory;
  level: 'endpoint' | 'fleet';
  platforms: ('win32' | 'darwin' | 'linux')[];
  confidence: 'confirmed' | 'heuristic'; note?: string;
  remediation: PostureRemediation;
}
export interface EndpointInfo { endpointId: string; hostname: string; os: NodeJS.Platform; osRelease: string; user: string; }
export interface InventoryAgent { id: string; name: string; kind: 'ide' | 'cli' | 'desktop' | 'extension' | 'browser-extension'; version?: string; installPath?: string; configPaths: string[]; accounts?: string[]; running?: boolean; elevated?: boolean }
export interface InventoryMcpServer { name: string; client: string; configPath: string; transport: 'stdio' | 'http' | 'sse' | 'unknown'; command?: string; package?: string; url?: string; identities: string[]; categories: string[] }
export interface InventoryExtension { id: string; name?: string; version?: string; host: 'vscode' | 'cursor' | 'windsurf' | 'antigravity' | 'kiro' | 'chrome' | 'edge' | 'brave' | 'claude-desktop'; permissions?: string[]; publisher?: string; path?: string }
export interface InventoryScheduledTask { source: 'cron' | 'launchd' | 'schtasks' | 'systemd'; name: string; command: string; agentId?: string }
export interface EndpointInventory { agents: InventoryAgent[]; mcpServers: InventoryMcpServer[]; extensions: InventoryExtension[]; scheduledTasks: InventoryScheduledTask[]; accounts: { agentId: string; account: string }[]; errors: string[] }
export interface PostureFindingDraft {
  checkId: string; severity: PostureSeverity; category: PostureCategory; title: string;
  subject: string;
  summary: string;
  evidence: Record<string, unknown>;
  fixable: boolean;
}
export interface PostureReport { scannerVersion: string; scannedAt: string; endpoint: EndpointInfo; inventory: EndpointInventory; findings: PostureFindingDraft[]; durationMs: number }
export interface ScanContext { home: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; hostname: string; user: string; readFile(p: string): Promise<string | null>; exists(p: string): Promise<boolean>; listDir(p: string): Promise<string[]>; stat(p: string): Promise<{ mode: number; isDir: boolean; size: number } | null>; exec(cmd: string, args: string[], timeoutMs?: number): Promise<{ code: number; stdout: string } | null>; processes(): Promise<{ pid: number; name: string; cmdline: string; user?: string; elevated?: boolean }[]>; processElevation?(pids: number[]): Promise<Record<number, boolean | null>>; orgDomains?: string[]; corporateSaasDomains?: string[]; disabledChecks?: string[] }
