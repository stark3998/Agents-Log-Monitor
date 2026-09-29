import crypto from 'crypto';
import { canonicalToolName, classifyTool, mcpFromName } from '../analytics/classify';
import { detect, type Detection } from '../analytics/detectors';
import { extractDomains } from '../analytics/domains';
import { assessRisk, type RiskHit } from '../analytics/risk';
import type { ActionRequest, RiskLevel, ToolCategory } from './types';
import { canonicalJson } from './audit';

/**
 * Derived, deterministic view of an action used by lane rules, limits, the judge prompt and lane
 * replay. Computed once per request by `extractFeatures`.
 */
export interface ActionFeatures {
  checkpoint: ActionRequest['checkpoint'];
  toolName: string;
  canonicalTool: string;
  category: ToolCategory;
  mcpServer: string | null;
  /** Shell command text for EXEC tools. */
  command: string;
  /** File paths referenced by the args (explicit path fields plus paths in the command). */
  paths: string[];
  /** All hosts referenced, INCLUDING private/link-local ones (e.g. 169.254.169.254). */
  hosts: string[];
  /** External (public) domains only, as used by analytics. */
  domains: string[];
  detections: Detection[];
  risk: RiskHit[];
  riskLevel: RiskLevel | null;
  /** Stable, human-debuggable signature for loop detection. */
  signature: string;
  /** One-line human summary (unredacted — redact before storing/sending). */
  summary: string;
}

const HOST_RE = /\b(?:https?|wss?|ftp):\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d+)?/gi;
const BARE_IP_RE = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
const SSH_RE = /\b[\w.-]+@([a-z0-9.-]+\.[a-z]{2,}):/gi;
const PATH_TOKEN_RE = /(?:^|[\s"'=(])((?:~|[a-z]:)?[\\/][^\s"'|;&<>]+|\.{1,2}[\\/][^\s"'|;&<>]+|~[\\/]?[^\s"'|;&<>]*)/gim;

function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return ''; }
}

export function commandOf(args: unknown): string {
  if (typeof args === 'string') return args;
  if (!args || typeof args !== 'object') return '';
  const o = args as Record<string, unknown>;
  const c = o.command ?? o.cmd ?? o.script ?? o.input;
  return typeof c === 'string' ? c : '';
}

export function pathsOf(args: unknown, command: string): string[] {
  const out = new Set<string>();
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const o = args as Record<string, unknown>;
    for (const k of ['file_path', 'path', 'filePath', 'notebook_path', 'directory', 'dir', 'target', 'source', 'destination', 'cwd']) {
      const v = o[k];
      if (typeof v === 'string' && v) out.add(v);
    }
    const ps = o.paths;
    if (Array.isArray(ps)) for (const p of ps) if (typeof p === 'string') out.add(p);
  }
  if (command) {
    PATH_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PATH_TOKEN_RE.exec(command)) !== null && out.size < 40) out.add(m[1]);
  }
  return [...out];
}

export function hostsOf(text: string): string[] {
  const out = new Set<string>();
  for (const re of [HOST_RE, BARE_IP_RE, SSH_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && out.size < 40) out.add(m[1].toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''));
  }
  return [...out];
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function shortHash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16);
}

export function extractFeatures(req: ActionRequest): ActionFeatures {
  const toolName = req.toolName ?? '';
  const mcpServer = req.mcpServer ?? mcpFromName(toolName)?.server ?? null;
  const category = req.category ?? (toolName ? classifyTool(toolName, mcpServer) : 'OTHER');
  const canonicalTool = canonicalToolName(toolName) || toolName;
  const command = category === 'EXEC' ? commandOf(req.args) : '';
  const argText = str(req.args);
  const paths = pathsOf(req.args, command);
  const hosts = hostsOf(argText);
  const domains = extractDomains(req.args);
  const scan = req.checkpoint === 'tool_result' ? (req.result ?? '') : req.checkpoint === 'goal' || req.checkpoint === 'response' ? (req.text ?? '') : argText;
  const detections = scan ? detect(scan.slice(0, 256 * 1024)) : [];
  const risk = req.checkpoint === 'pre_tool'
    ? assessRisk({ toolName, category, input: req.args, cwd: req.agent.cwd, secretDetected: detections.some(d => d.cls === 'secret'), externalDomains: domains })
    : [];
  const target = command || paths[0] || hosts[0] || clip(argText, 120);
  const summary = `${category} ${toolName || req.checkpoint}${target ? ' ' + clip(target.replace(/\s+/g, ' '), 200) : ''}`;
  const signatureMaterial = req.args !== undefined
    ? req.args
    : req.result !== undefined
      ? { result: req.result }
      : req.text !== undefined
        ? { text: req.text }
        : null;
  const signaturePrefix = clip((command || paths.join(',') || hosts.join(',') || argText || req.text || req.result || req.checkpoint).replace(/\s+/g, ' '), 120);
  const signature = `${canonicalTool || req.checkpoint}|${signaturePrefix}|${shortHash(signatureMaterial)}`;
  return {
    checkpoint: req.checkpoint, toolName, canonicalTool, category, mcpServer, command, paths, hosts, domains, detections, risk,
    riskLevel: risk[0]?.level ?? null, signature, summary,
  };
}
