import { DefaultAzureCredential } from '@azure/identity';
import { govConfig } from '../config';
import type { ChatMessage } from './prompts';

const TOKEN_SCOPE = 'https://cognitiveservices.azure.com/.default';
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;

interface CachedToken {
  token: string;
  expiresOnTimestamp: number;
}

let credential: DefaultAzureCredential | undefined;
let cachedToken: CachedToken | undefined;

async function bearerToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresOnTimestamp - TOKEN_REFRESH_SKEW_MS > now) return cachedToken.token;
  credential ??= new DefaultAzureCredential();
  const token = await credential.getToken(TOKEN_SCOPE);
  if (!token) throw new Error('DefaultAzureCredential did not return an Azure OpenAI token');
  cachedToken = { token: token.token, expiresOnTimestamp: token.expiresOnTimestamp };
  return cachedToken.token;
}

function isReasoningDeployment(deployment: string): boolean {
  return /^(o\d|gpt-5)/i.test(deployment);
}

function trimEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

async function readError(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}

export interface ChatJsonRequest {
  deployment: string;
  messages: ChatMessage[];
  schemaName: string;
  jsonSchema: unknown;
  timeoutMs: number;
  maxTokens?: number;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatJsonResult {
  deployment: string;
  value: unknown;
  latencyMs: number;
  /** Token usage from the chat completion `usage` field, when the service reported it. */
  usage?: ChatUsage;
}

interface ChatAttemptResult {
  value: unknown;
  usage?: ChatUsage;
}

function parseUsage(raw: unknown): ChatUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const input = typeof u.prompt_tokens === 'number' && Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : undefined;
  const output = typeof u.completion_tokens === 'number' && Number.isFinite(u.completion_tokens) ? u.completion_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
}

export class FoundryChatClient {
  get available(): boolean {
    return govConfig.foundry.enabled;
  }

  async completeJson(req: ChatJsonRequest): Promise<ChatJsonResult> {
    if (!this.available) throw new Error('Foundry OpenAI endpoint is not configured');
    const started = Date.now();
    const result = await this.completeJsonAttempt(req, started, false);
    const out: ChatJsonResult = { deployment: req.deployment, value: result.value, latencyMs: Date.now() - started };
    if (result.usage) out.usage = result.usage;
    return out;
  }

  private async completeJsonAttempt(req: ChatJsonRequest, started: number, retried: boolean): Promise<ChatAttemptResult> {
    const elapsed = Date.now() - started;
    const remaining = Math.max(0, req.timeoutMs - elapsed);
    if (remaining <= 0) throw new Error('Foundry chat completion timed out');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetch(this.url(req.deployment), {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify(this.body(req)),
        signal: controller.signal,
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const afterResponseRemaining = req.timeoutMs - (Date.now() - started);
        if (!retried && retryable && afterResponseRemaining >= req.timeoutMs * 0.4) {
          return this.completeJsonAttempt(req, started, true);
        }
        const detail = await readError(response);
        throw new Error(`Foundry chat completion failed (${response.status}): ${detail.slice(0, 500)}`);
      }

      const json = await response.json() as { choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown };
      const content = json.choices?.[0]?.message?.content;
      const usage = parseUsage(json.usage);
      if (typeof content === 'string') return { value: JSON.parse(content), usage };
      if (content && typeof content === 'object') return { value: content, usage };
      throw new Error('Foundry chat completion response did not contain JSON content');
    } catch (err) {
      if (controller.signal.aborted) throw new Error('Foundry chat completion timed out');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private url(deployment: string): string {
    const endpoint = trimEndpoint(govConfig.foundry.endpoint);
    const apiVersion = encodeURIComponent(govConfig.foundry.apiVersion);
    return `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${apiVersion}`;
  }

  private async headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (govConfig.foundry.apiKey) headers['api-key'] = govConfig.foundry.apiKey;
    else headers.Authorization = `Bearer ${await bearerToken()}`;
    return headers;
  }

  private body(req: ChatJsonRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      messages: req.messages,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: req.schemaName,
          strict: true,
          schema: req.jsonSchema,
        },
      },
    };
    const tokenLimit = req.maxTokens ?? 800;
    if (isReasoningDeployment(req.deployment)) body.max_completion_tokens = tokenLimit;
    else {
      body.temperature = 0;
      body.max_tokens = tokenLimit;
    }
    return body;
  }
}
