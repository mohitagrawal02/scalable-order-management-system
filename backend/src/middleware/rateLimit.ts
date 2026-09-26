import { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/AppError';
import { consumeRateLimit } from '../infrastructure/redis/rateLimiter';

/**
 * Reusable Redis-backed rate limiting middleware (Day 6).
 *
 * Deliberately generic: the counting/rejection mechanics live here, while the
 * *policy* (how a client is identified, how many attempts are allowed) is
 * supplied by the caller. `modules/auth/auth.rateLimit.ts` is the first user;
 * any future expensive or abuse-prone endpoint can mount the same factory.
 *
 * Behaviour:
 *  - allowed  → next()
 *  - exceeded → HTTP 429 through the existing AppError envelope
 *               (`{ error: { status, message } }`) plus `Retry-After`.
 *
 * The response never reveals Redis internals - only the limit semantics.
 */
export interface RateLimitOptions {
  /**
   * Builds the FULL Redis key a request is counted against, e.g.
   * `rate-limit:login:<hash>`. MUST be deterministic: the same logical client
   * must map to the same key on every request.
   */
  key: (req: Request) => string;
  /** Attempts allowed per window. */
  limit: number;
  /** Window length in seconds (the Redis TTL). */
  windowSeconds: number;
  /** Message used in the 429 error envelope. */
  message: string;
}

export function rateLimit(options: RateLimitOptions) {
  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const key = options.key(req);

      // Atomic INCR + EXPIRE + TTL inside Redis: see rateLimiter.ts.
      const result = await consumeRateLimit(key, options.limit, options.windowSeconds);

      // Standard, non-secret rate-limit hints. They describe the policy, never
      // the store behind it.
      res.setHeader('X-RateLimit-Limit', String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.limit - result.count)));

      if (result.allowed) {
        next();
        return;
      }

      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      res.setHeader('X-RateLimit-Reset', String(result.retryAfterSeconds));
      next(new AppError(options.message, 429));
    } catch (err) {
      // consumeRateLimit already fails open; this guards against a bug in the
      // middleware itself. A limiter must never be the reason a login cannot
      // be attempted - it is a protection layer, not a gatekeeper of last
      // resort (docs/REDIS.md § "Redis outage and rate limiting").
      console.error('[rate-limit] middleware error, allowing request:', err);
      next();
    }
  };
}
