import { redis } from './client';

/**
 * Generic JSON cache on top of Redis (Day 6).
 *
 * This module knows nothing about products, users or HTTP - it is the reusable
 * "read-through store" primitive that feature modules build on. It owns four
 * concerns:
 *
 * 1. **Serialization** - values are stored as JSON so callers get typed objects
 *    back instead of hand-parsing strings.
 * 2. **Failure isolation** - EVERY method is total: a Redis outage, a timeout,
 *    or a corrupt value can never throw into the request path. Callers get
 *    `{ outcome: 'error' }` / `false` and continue against MySQL.
 * 3. **Observability** - each operation emits one structured log line and
 *    updates in-process counters (hit / miss / error / set / invalidate), which
 *    is all the metric surface this stage needs (no Prometheus yet).
 * 4. **Key hygiene** - TTLs are mandatory for cached values, so a missed
 *    invalidation can only ever be `ttlSeconds` stale.
 *
 * Layering note: the low-level command set is injected (`CacheCommandSet`) so
 * failure modes can be exercised in tests without touching the process-wide
 * client, and so the same logic could later run against another backend.
 */

/** The Redis operations this cache needs. Implemented by `redisCommands`. */
export interface CacheCommandSet {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
  del(keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
}

/** Result of a cache read. `error` means "Redis was unusable" (≠ miss). */
export type CacheLookup<T> =
  | { outcome: 'hit'; value: T }
  | { outcome: 'miss' }
  | { outcome: 'error' };

export interface CacheStats {
  hits: number;
  misses: number;
  errors: number;
  sets: number;
  setFailures: number;
  invalidations: number;
  keysDeleted: number;
}

export interface Cache {
  getJson<T>(key: string): Promise<CacheLookup<T>>;
  setJson(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
  deleteKeys(keys: string[]): Promise<number>;
  increment(key: string): Promise<number | null>;
}

const stats: CacheStats = {
  hits: 0,
  misses: 0,
  errors: 0,
  sets: 0,
  setFailures: 0,
  invalidations: 0,
  keysDeleted: 0,
};

/**
 * In-process counter snapshot.
 *
 * Deliberately per-process: with several API instances these numbers describe
 * one instance, which is enough to verify hit/miss behaviour locally and in
 * tests. Aggregating them across instances is a future (metrics) concern.
 */
export function getCacheStats(): CacheStats {
  return { ...stats };
}

export function resetCacheStats(): void {
  stats.hits = 0;
  stats.misses = 0;
  stats.errors = 0;
  stats.sets = 0;
  stats.setFailures = 0;
  stats.invalidations = 0;
  stats.keysDeleted = 0;
}

/** One log line per operation - the whole "metrics" story for Day 6. */
function logCache(event: string, key: string, extra = ''): void {
  console.log(`[cache] ${event} key="${key}"${extra}`);
}

function logCacheError(event: string, key: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[cache] ${event} key="${key}" error="${message}"`);
}

/** Real Redis-backed command set (single shared client, see client.ts). */
export const redisCommands: CacheCommandSet = {
  get: (key) => redis.get(key),
  set: (key, value, ttlSeconds) => redis.set(key, value, 'EX', ttlSeconds),
  del: (keys) => (keys.length === 0 ? Promise.resolve(0) : redis.del(...keys)),
  incr: (key) => redis.incr(key),
};

export function createCache(commands: CacheCommandSet): Cache {
  /** Invalidation: delete specific keys. Best-effort by design. */
  async function deleteKeys(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    try {
      const deleted = await commands.del(keys);
      stats.invalidations += 1;
      stats.keysDeleted += deleted;
      logCache('invalidate', keys.join(','), ` deleted=${deleted}`);
      return deleted;
    } catch (err) {
      stats.errors += 1;
      logCacheError('invalidate-error', keys.join(','), err);
      return 0;
    }
  }

  /**
   * Cache-aside read. `hit` → return the cached value; `miss`/`error` → the
   * caller must fall back to the source of truth.
   */
  async function getJson<T>(key: string): Promise<CacheLookup<T>> {
    const startedAt = Date.now();
    let raw: string | null;
    try {
      raw = await commands.get(key);
    } catch (err) {
      stats.errors += 1;
      logCacheError('error op=get', key, err);
      return { outcome: 'error' };
    }

    if (raw === null) {
      stats.misses += 1;
      logCache('miss', key, ` durationMs=${Date.now() - startedAt}`);
      return { outcome: 'miss' };
    }

    try {
      const value = JSON.parse(raw) as T;
      stats.hits += 1;
      logCache('hit', key, ` durationMs=${Date.now() - startedAt}`);
      return { outcome: 'hit', value };
    } catch (err) {
      // An unparseable value (old format, truncated write, manual edit) is
      // treated as absent: the caller re-reads MySQL and overwrites it.
      stats.misses += 1;
      logCacheError('miss op=deserialize', key, err);
      void deleteKeys([key]);
      return { outcome: 'miss' };
    }
  }

  /** Cache-aside write. Returns false (never throws) when Redis refused it. */
  async function setJson(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch (err) {
      stats.setFailures += 1;
      logCacheError('set-error op=serialize', key, err);
      return false;
    }

    try {
      await commands.set(key, serialized, ttlSeconds);
      stats.sets += 1;
      logCache('set', key, ` ttlSeconds=${ttlSeconds}`);
      return true;
    } catch (err) {
      stats.setFailures += 1;
      logCacheError('set-error', key, err);
      return false;
    }
  }

  /**
   * Atomic counter bump, used for cache-namespace versions.
   * Returns null when Redis could not do it.
   */
  async function increment(key: string): Promise<number | null> {
    try {
      const value = await commands.incr(key);
      logCache('increment', key, ` value=${value}`);
      return value;
    } catch (err) {
      stats.errors += 1;
      logCacheError('increment-error', key, err);
      return null;
    }
  }

  return { getJson, setJson, deleteKeys, increment };
}

/** Process-wide cache instance wired to the shared Redis client. */
export const cache: Cache = createCache(redisCommands);


