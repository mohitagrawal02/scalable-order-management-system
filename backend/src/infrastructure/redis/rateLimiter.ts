import { redis } from './client';

/**
 * Redis-backed rate limiter primitive (Day 6).
 *
 * ── Why a Lua script and not `INCR` + `EXPIRE` from JavaScript? ─────────────
 *
 * The naive approach is:
 *
 *      const count = await redis.incr(key);      // round trip 1
 *      if (count === 1) await redis.expire(key); // round trip 2
 *
 * Two problems:
 *
 * 1. **Non-atomic window.** If the process dies (or the connection drops)
 *    between the two calls, the counter exists WITHOUT a TTL and never
 *    expires - a permanent lockout.
 * 2. **Racy multi-instance behaviour.** "read the counter, decide, then write"
 *    in application code lets concurrent requests observe the same value and
 *    both be allowed (lost update).
 *
 * Redis executes a Lua script atomically on a single thread: no other command
 * interleaves between INCR, EXPIRE and TTL, and all API instances share the
 * same counter because the counter lives in Redis, not in process memory.
 * That is what makes the limit correct when 20 requests arrive at once
 * (verified in tests/integration/rateLimit.test.ts).
 *
 * The script also self-heals a key that somehow exists with `TTL == -1`
 * (no expiry attached), so a previously-broken key cannot lock a client out.
 */
const CONSUME_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`;

export interface RateLimitResult {
  /** false → the caller must be rejected with HTTP 429. */
  allowed: boolean;
  /** Requests counted in the current window (including this one). */
  count: number;
  limit: number;
  /** Seconds until the window resets (for the Retry-After header). */
  retryAfterSeconds: number;
  /** true when Redis was unusable and the decision fell back to "allow". */
  degraded: boolean;
}

/**
 * Counts one attempt against `key` and decides.
 *
 * Failure policy: **fail open**. If Redis cannot answer, the request is
 * allowed (with `degraded: true` and an error log). Rationale and trade-off
 * are documented in docs/REDIS.md (§ "Redis outage and rate limiting"):
 * refusing every login while Redis is down would turn a cache outage into a
 * full authentication outage, which is a worse and more certain failure than
 * a temporarily unlimited brute-force window.
 */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  try {
    const reply: unknown = await redis.eval(CONSUME_SCRIPT, 1, key, String(windowSeconds));

    if (!Array.isArray(reply) || reply.length < 2) {
      throw new Error('unexpected reply from rate limit script');
    }

    const count = Number(reply[0]);
    const ttl = Number(reply[1]);
    if (!Number.isFinite(count) || !Number.isFinite(ttl)) {
      throw new Error('unexpected numeric reply from rate limit script');
    }

    const retryAfterSeconds = ttl > 0 ? ttl : windowSeconds;
    return {
      allowed: count <= limit,
      count,
      limit,
      retryAfterSeconds,
      degraded: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[rate-limit] error key="${key}" error="${message}" policy=fail-open (request allowed)`
    );
    return {
      allowed: true,
      count: 0,
      limit,
      retryAfterSeconds: windowSeconds,
      degraded: true,
    };
  }
}
