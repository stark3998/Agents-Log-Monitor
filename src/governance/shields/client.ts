import { DefaultAzureCredential } from '@azure/identity';
import { govConfig } from '../config';
import type { ShieldResult } from '../contracts';

const TOKEN_SCOPE = 'https://cognitiveservices.azure.com/.default';
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;
const MAX_DOCUMENT_CHARS = 10000;
const MAX_DOCUMENTS = 5;

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
  if (!token) throw new Error('DefaultAzureCredential did not return a Content Safety token');
  cachedToken = { token: token.token, expiresOnTimestamp: token.expiresOnTimestamp };
  return cachedToken.token;
}

function endpointUrl(): string {
  const endpoint = govConfig.contentSafety.endpoint.replace(/\/+$/, '');
  const apiVersion = encodeURIComponent(govConfig.contentSafety.apiVersion);
  return `${endpoint}/contentsafety/text:shieldPrompt?api-version=${apiVersion}`;
}

function chunkDocuments(docs: string[]): string[] {
  const chunks: string[] = [];
  for (const doc of docs) {
    const text = String(doc ?? '');
    if (!text) continue;
    for (let i = 0; i < text.length && chunks.length < MAX_DOCUMENTS; i += MAX_DOCUMENT_CHARS) {
      chunks.push(text.slice(i, i + MAX_DOCUMENT_CHARS));
    }
    if (chunks.length >= MAX_DOCUMENTS) break;
  }
  return chunks;
}

function detailFromResponse(data: PromptShieldResponse, kind?: 'document' | 'prompt'): string | undefined {
  if (!kind) return undefined;
  if (kind === 'prompt') return data.userPromptAnalysis?.attackDetected ? 'Prompt Shields detected a direct prompt attack.' : undefined;
  const index = data.documentsAnalysis?.findIndex(d => d?.attackDetected);
  return index != null && index >= 0 ? `Prompt Shields detected an indirect prompt attack in document ${index + 1}.` : undefined;
}

interface PromptShieldResponse {
  userPromptAnalysis?: { attackDetected?: boolean };
  documentsAnalysis?: Array<{ attackDetected?: boolean }>;
}

export class PromptShieldsClient {
  get available(): boolean {
    return govConfig.contentSafety.enabled;
  }

  async scanDocuments(docs: string[], userPrompt?: string): Promise<ShieldResult> {
    const started = Date.now();
    if (!this.available) return { attackDetected: false, latencyMs: 0, scanned: false };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), govConfig.contentSafety.timeoutMs);
    try {
      const response = await fetch(endpointUrl(), {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({
          userPrompt: userPrompt ?? '',
          documents: chunkDocuments(docs),
        }),
        signal: controller.signal,
      });
      if (!response.ok) return this.notScanned(started);

      const data = await response.json() as PromptShieldResponse;
      const promptAttack = !!data.userPromptAnalysis?.attackDetected;
      const documentAttack = !!data.documentsAnalysis?.some(d => d?.attackDetected);
      const kind = promptAttack ? 'prompt' : documentAttack ? 'document' : undefined;
      return {
        attackDetected: promptAttack || documentAttack,
        kind,
        detail: detailFromResponse(data, kind),
        latencyMs: Date.now() - started,
        scanned: true,
      };
    } catch {
      return this.notScanned(started);
    } finally {
      clearTimeout(timer);
    }
  }

  private notScanned(started: number): ShieldResult {
    return { attackDetected: false, latencyMs: Date.now() - started, scanned: false };
  }

  private async headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (govConfig.contentSafety.apiKey) headers['Ocp-Apim-Subscription-Key'] = govConfig.contentSafety.apiKey;
    else headers.Authorization = `Bearer ${await bearerToken()}`;
    return headers;
  }
}
