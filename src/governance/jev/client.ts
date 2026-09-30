/**
 * Thin wrapper over the TypeSafe SDK (`@typesafe-ai/sdk`) for Jev System One calls.
 *
 * - Always sends the pinned, versioned model from `jevConfig.model` (thresholds are tuned per version).
 * - Per-attempt timeout from `jevConfig.timeoutMs`, one retry by default (shadow/eval never needs more).
 * - The SDK logger only receives the message line, never extra args, so request/response bodies are
 *   never logged.
 * - Throws when no API key is configured; callers (shadow queue, eval) record the error.
 */
import {
  TypeSafeClient,
  type ChoiceResponse,
  type EntryType,
  type Logger,
  type NoulResponse,
  type Questions,
  type RequestOptions,
  type ScoreResponse,
  type SystemOneRequest,
} from '@typesafe-ai/sdk';
import { jevConfig } from './config';

export type { EntryType, Questions } from '@typesafe-ai/sdk';

/** One typed Jev answer. */
export type JevAnswer = NoulResponse | ChoiceResponse | ScoreResponse;

export interface JevCallResult {
  /** Versioned model id reported by the API (e.g. `jev-1.13.0`). */
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}

export interface JevAskOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxRetries?: number;
}

/** Minimal surface of `TypeSafeClient` used here (also the test seam). */
export interface JevTransport {
  systemOne: (req: SystemOneRequest, opts?: RequestOptions) => PromiseLike<unknown>;
}

const DEFAULT_MAX_RETRIES = 1;

/** Logs only the SDK's message line; drops extra args (which may carry request/response bodies). */
const quietLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message: string) => console.warn(`[jev] ${message}`),
  error: (message: string) => console.error(`[jev] ${message}`),
};

let testClient: JevTransport | null = null;
let cached: { key: string; client: TypeSafeClient } | undefined;

/** Test seam: replace the SDK client (pass `null` to restore). Always drops the cached real client. */
export function setJevClientForTests(c: { systemOne: (req: any, opts?: any) => Promise<any> } | null): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  testClient = c;
  cached = undefined;
}

function client(): JevTransport {
  if (testClient) return testClient;
  const key = `${jevConfig.apiKey}\u0000${jevConfig.baseUrl}\u0000${jevConfig.model}`;
  if (!cached || cached.key !== key) {
    cached = {
      key,
      client: new TypeSafeClient({
        apiKey: jevConfig.apiKey,
        baseURL: jevConfig.baseUrl || undefined,
        defaultModel: jevConfig.model,
        timeout: jevConfig.timeoutMs,
        retry: { maxRetries: DEFAULT_MAX_RETRIES },
        logLevel: 'warn',
        logger: quietLogger,
      }),
    };
  }
  return cached.client;
}

function isAnswer(v: unknown): v is JevAnswer {
  if (!v || typeof v !== 'object') return false;
  const a = v as { type?: unknown; noul?: unknown; score?: unknown; choice?: unknown };
  if (a.type === 'noul') return typeof a.noul === 'number';
  if (a.type === 'score') return typeof a.score === 'number';
  if (a.type === 'choice') return typeof a.choice === 'string';
  return false;
}

function tokenCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Ask Jev every question in one call. Throws when Jev is not configured, on transport/API errors,
 * or when the response is missing an answer for any question (so the caller can record the error
 * instead of silently combining partial evidence).
 */
export async function jevAsk(state: EntryType, questions: Questions, opts: JevAskOptions = {}): Promise<JevCallResult> {
  if (!jevConfig.available) throw new Error('Jev is not configured (TYPESAFE_API_KEY is not set)');
  const ids = Object.keys(questions);
  if (!ids.length) throw new Error('jevAsk: no questions');
  const reqOpts: RequestOptions = {
    timeout: opts.timeoutMs ?? jevConfig.timeoutMs,
    retry: { maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES },
  };
  if (opts.signal) reqOpts.signal = opts.signal;

  const started = Date.now();
  const raw = await client().systemOne({ state, questions, model: jevConfig.model }, reqOpts);
  const latencyMs = Date.now() - started;

  if (!raw || typeof raw !== 'object') throw new Error('Jev response was not an object');
  const res = raw as { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
  if (!res.answers || typeof res.answers !== 'object') throw new Error('Jev response did not contain answers');
  const src = res.answers as Record<string, unknown>;
  const answers: Record<string, JevAnswer> = {};
  const missing: string[] = [];
  for (const id of ids) {
    const a = src[id];
    if (isAnswer(a)) answers[id] = a;
    else missing.push(id);
  }
  if (missing.length) throw new Error(`Jev response missing/invalid answers: ${missing.slice(0, 10).join(', ')}`);
  return {
    model: typeof res.model === 'string' && res.model ? res.model : jevConfig.model,
    answers,
    usage: { inputTokens: tokenCount(res.usage?.input_tokens), outputTokens: tokenCount(res.usage?.output_tokens) },
    latencyMs,
  };
}
