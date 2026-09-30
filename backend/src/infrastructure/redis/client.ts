import Redis, { RedisOptions } from 'ioredis';
import { config } from '../../config';
import { getLogger } from '../logging';

/** Structured logger for this module (Day 8). */
const redisLogger = getLogger({ module: 'redis' });

/**
 * Redis connection + lifecycle (Day 6).
 *
 * Design rules, in order of importance:
 *
 * 1. **Redis is an optimisation, never the system of record.** MySQL remains
 *    the source of truth (see docs/REDIS.md). Every consumer of this client
 *    (cache, rate limiter) must degrade gracefully when it is unreachable.
 * 2. **Fail fast, don't queue.** With `enableOfflineQueue: false` a command
 *    issued while the socket is down rejects IMMEDIATELY instead of sitting in
 *    a queue. Combined with `maxRetriesPerRequest: 1` and `commandTimeout`,
 *    a broken Redis becomes a cache MISS in microseconds, not a stalled HTTP
 *    request.
 * 3. **Self-healing connection.** `retryStrategy` keeps attempting to
 *    reconnect with a capped backoff, so a restarted Redis is picked up
 *    automatically - no API restart, no manual intervention.
 *
 * A single client is shared by the whole process (one connection pool entry
 * per process). ioredis buffers/orders commands on one socket, which is all a
 * monolith of this size needs.
 */
const REDIS_OPTIONS: RedisOptions = {
  // Never hold a request hostage: fail the command instead of queueing it.
  enableOfflineQueue: false,
  // 1 = retry once when a reply is lost mid-flight, then surface the error.
  maxRetriesPerRequest: 1,
  connectTimeout: 3_000,
  commandTimeout: config.redis.commandTimeoutMs,
  // Unbounded-but-capped retries: 200ms, 400ms, ... max 2s between attempts.
  retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  connectionName: 'ecommerce-platform-backend',
};

export const redis = new Redis(config.redis.url, REDIS_OPTIONS);

/**
 * Connection-state logging.
 *
 * Without an `error` listener ioredis would re-throw connection errors as
 * unhandled events and kill the process - exactly the "Redis is a single
 * point of failure" outcome we are designing against. Errors are therefore
 * logged (throttled) and otherwise ignored: the app keeps serving.
 */
let lastLoggedErrorMessage = '';
let lastLoggedAt = 0;
let hasLoggedFailure = false;
const ERROR_LOG_THROTTLE_MS = 10_000;

redis.on('error', (err: Error) => {
  const now = Date.now();
  const message = err.message;
  const isNewError = message !== lastLoggedErrorMessage;
  if (!isNewError && now - lastLoggedAt < ERROR_LOG_THROTTLE_MS) return;

  lastLoggedErrorMessage = message;
  lastLoggedAt = now;
  hasLoggedFailure = true;
  redisLogger.error('redis connection error', { url: redactUrl(config.redis.url), error: message });
});

redis.on('ready', () => {
  if (hasLoggedFailure) {
    redisLogger.info('redis reconnected', { url: redactUrl(config.redis.url) });
    hasLoggedFailure = false;
  }
});

/** Removes any credentials from a Redis URL before it reaches the logs. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<invalid-url>';
  }
}

export type RedisStatus = 'wait' | 'reconnecting' | 'connecting' | 'connect' | 'ready' | 'close' | 'end';

/**
 * Current connection state, for health checks and logs.
 *
 * `ready` is the only state in which commands are accepted immediately;
 * every other state means "degraded, go to MySQL" for our consumers.
 */
export function getRedisStatus(): RedisStatus {
  return redis.status as RedisStatus;
}

/**
 * Health probe: true only when a live PING round-trip succeeded.
 *
 * Never throws - health reporting must not fail because Redis did.
 */
export async function pingRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}

/** True when commands can be issued without hitting the fail-fast path. */
export function isRedisReady(): boolean {
  return redis.status === 'ready';
}

/**
 * Graceful shutdown: flush pending replies, close the socket. Called from the
 * HTTP server's SIGINT/SIGTERM handler.
 */
export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    // Socket already gone (or Redis unreachable): force it closed.
    redis.disconnect();
  }
}
