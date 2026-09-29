import Redis from 'ioredis';
import { govConfig } from '../config';

export interface LimitWindowResult { allowed: boolean; count: number; remaining: number; resetAt: number }
export interface LoopSignatureRecord { signature: string; at: number }

export function createRedis(url = govConfig.cloud.redisUrl): Redis | null {
  if (!url) return null;
  // Azure Cache for Redis access-key auth is represented by REDIS_URL, e.g.
  // rediss://:key@name.redis.cache.windows.net:6380. Entra token auth requires token refresh
  // hooks and is intentionally left for a later integration.
  return new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    tls: url.startsWith('rediss://') ? {} : undefined,
  });
}

export class RedisLimitsBackend {
  constructor(private readonly redis: Redis = createRedis()!) {
    if (!redis) throw new Error('RedisLimitsBackend requires REDIS_URL');
  }

  async checkSlidingWindow(key: string, limit: number, windowMs: number, now = Date.now()): Promise<LimitWindowResult> {
    const redisKey = `gov:limit:${key}`;
    const min = now - windowMs;
    const member = `${now}:${Math.random().toString(36).slice(2)}`;
    const tx = this.redis.multi();
    tx.zremrangebyscore(redisKey, 0, min);
    tx.zadd(redisKey, now, member);
    tx.zcard(redisKey);
    tx.pexpire(redisKey, windowMs * 2);
    const replies = await tx.exec();
    const count = Number(replies?.[2]?.[1] ?? 0);
    return { allowed: count <= limit, count, remaining: Math.max(0, limit - count), resetAt: now + windowMs };
  }

  async recordLoopSignature(sessionId: string, signature: string, windowMs: number, now = Date.now()): Promise<LoopSignatureRecord[]> {
    const key = `gov:loop:${sessionId}`;
    await this.redis.multi()
      .zremrangebyscore(key, 0, now - windowMs)
      .zadd(key, now, `${now}:${signature}`)
      .pexpire(key, windowMs * 2)
      .exec();
    const rows = await this.redis.zrangebyscore(key, now - windowMs, now);
    return rows.map(row => {
      const idx = row.indexOf(':');
      return { at: Number(row.slice(0, idx)), signature: row.slice(idx + 1) };
    });
  }

  async countMatchingLoopSignatures(sessionId: string, signature: string, windowMs: number, now = Date.now()): Promise<number> {
    const rows = await this.recordLoopSignature(sessionId, signature, windowMs, now);
    return rows.filter(r => r.signature === signature).length;
  }
}

export class RedisDecisionCache<T = unknown> {
  constructor(private readonly redis: Redis = createRedis()!) {
    if (!redis) throw new Error('RedisDecisionCache requires REDIS_URL');
  }
  async get(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(`gov:decision:${key}`);
    return raw ? JSON.parse(raw) as T : undefined;
  }
  async set(key: string, value: T, ttlMs: number): Promise<void> {
    await this.redis.set(`gov:decision:${key}`, JSON.stringify(value), 'PX', ttlMs);
  }
  async delete(key: string): Promise<void> { await this.redis.del(`gov:decision:${key}`); }
}

export class RedisPauseFlags {
  private readonly subscribers = new Set<(scope: 'agent' | 'session', id: string, paused: boolean) => void>();
  private readonly sub?: Redis;
  constructor(private readonly redis: Redis = createRedis()!, subscribe = true) {
    if (!redis) throw new Error('RedisPauseFlags requires REDIS_URL');
    if (subscribe) {
      this.sub = redis.duplicate();
      void this.sub.subscribe('gov:pause').then(() => {
        this.sub!.on('message', (_ch, msg) => {
          const evt = JSON.parse(msg) as { scope: 'agent' | 'session'; id: string; paused: boolean };
          for (const cb of this.subscribers) cb(evt.scope, evt.id, evt.paused);
        });
      });
    }
  }
  async isPaused(scope: 'agent' | 'session', id: string): Promise<boolean> { return (await this.redis.get(`gov:pause:${scope}:${id}`)) === '1'; }
  async setPaused(scope: 'agent' | 'session', id: string, paused: boolean, ttlMs?: number): Promise<void> {
    const key = `gov:pause:${scope}:${id}`;
    if (paused) {
      if (ttlMs) await this.redis.set(key, '1', 'PX', ttlMs);
      else await this.redis.set(key, '1');
    } else await this.redis.del(key);
    await this.redis.publish('gov:pause', JSON.stringify({ scope, id, paused }));
  }
  onInvalidation(cb: (scope: 'agent' | 'session', id: string, paused: boolean) => void): () => void {
    this.subscribers.add(cb);
    return () => { this.subscribers.delete(cb); };
  }
  async close(): Promise<void> { await this.sub?.quit(); }
}

export interface ApprovalResolutionSignal { approvalId: string; state: 'approved' | 'denied' | 'expired' | 'cancelled'; resolvedBy?: string; note?: string }

export class RedisApprovalSignal {
  private readonly channel = 'gov:approval:resolved';
  private readonly sub?: Redis;
  private readonly subscribers = new Set<(signal: ApprovalResolutionSignal) => void>();
  constructor(private readonly redis: Redis = createRedis()!, subscribe = true) {
    if (!redis) throw new Error('RedisApprovalSignal requires REDIS_URL');
    if (subscribe) {
      this.sub = redis.duplicate();
      void this.sub.subscribe(this.channel).then(() => {
        this.sub!.on('message', (_ch, msg) => {
          const signal = JSON.parse(msg) as ApprovalResolutionSignal;
          for (const cb of this.subscribers) cb(signal);
        });
      });
    }
  }
  async publish(signal: ApprovalResolutionSignal): Promise<void> { await this.redis.publish(this.channel, JSON.stringify(signal)); }
  onResolved(cb: (signal: ApprovalResolutionSignal) => void): () => void {
    this.subscribers.add(cb);
    return () => { this.subscribers.delete(cb); };
  }
  async close(): Promise<void> { await this.sub?.quit(); }
}
