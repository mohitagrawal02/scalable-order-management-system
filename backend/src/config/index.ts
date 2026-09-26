import 'dotenv/config';

/**
 * Centralised application configuration.
 *
 * Environment variables are read ONCE at startup and validated here so the
 * server fails fast (with a clear message) instead of crashing in the middle
 * of a request with an obscure TypeError.
 */

const requiredEnvVars = ['DATABASE_URL', 'PORT', 'JWT_SECRET'] as const;

for (const name of requiredEnvVars) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function toPositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer. Got: "${value}"`);
  }
  return parsed;
}

/** Same rules as toPositiveInt, but with a default when the variable is unset. */
function optionalPositiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  return toPositiveInt(value, name);
}

/**
 * Redis is an OPTIMISATION layer, not a requirement (see docs/REDIS.md §Redis
 * failure behavior). It therefore has a working default and is never part of
 * the "required variables" check above - the API must still boot and serve
 * traffic when Redis is absent.
 */
const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';

function readRedisUrl(): string {
  const raw = process.env.REDIS_URL?.trim();
  const url = raw === undefined || raw === '' ? DEFAULT_REDIS_URL : raw;

  // Fail fast on a malformed URL: a typo must not turn every request into a
  // silent "cache is down" degradation.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`REDIS_URL must be a valid URL (e.g. redis://127.0.0.1:6379). Got: "${url}"`);
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`REDIS_URL must use the redis:// or rediss:// scheme. Got: "${url}"`);
  }
  return url;
}

/**
 * JWT secrets below 32 chars are weak. Failing here (instead of at the first
 * login request) forces a proper secret into .env.
 */
const jwtSecret = process.env.JWT_SECRET as string;
if (jwtSecret.length < 32) {
  throw new Error(
    'JWT_SECRET must be at least 32 characters long. Generate one, e.g.:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"'
  );
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: toPositiveInt(process.env.PORT as string, 'PORT'),
  databaseUrl: process.env.DATABASE_URL as string,
  jwt: {
    secret: jwtSecret,
    expiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
    issuer: 'ecommerce-platform',
  },
  /**
   * Redis connection (Day 6). Used for the product catalog cache and for
   * login rate limiting. Both features degrade gracefully when it is down.
   */
  redis: {
    url: readRedisUrl(),
    /**
     * Per-command client-side timeout. A cache read that takes longer than
     * this is treated as a cache ERROR (→ query MySQL). Without it, a hung
     * Redis connection would hang the HTTP request with it.
     */
    commandTimeoutMs: optionalPositiveInt(
      process.env.REDIS_COMMAND_TIMEOUT_MS,
      'REDIS_COMMAND_TIMEOUT_MS',
      500
    ),
  },
  cache: {
    /**
     * TTL for cached product catalog responses. 60s is a deliberate
     * freshness/performance trade-off: long enough to absorb traffic bursts,
     * short enough that even a MISSED invalidation self-corrects quickly.
     */
    productTtlSeconds: optionalPositiveInt(
      process.env.PRODUCT_CACHE_TTL_SECONDS,
      'PRODUCT_CACHE_TTL_SECONDS',
      60
    ),
  },
  rateLimit: {
    login: {
      /** Login attempts allowed per (client IP + target account) per window. */
      maxAttempts: optionalPositiveInt(
        process.env.RATE_LIMIT_LOGIN_MAX,
        'RATE_LIMIT_LOGIN_MAX',
        5
      ),
      windowSeconds: optionalPositiveInt(
        process.env.RATE_LIMIT_LOGIN_WINDOW_SECONDS,
        'RATE_LIMIT_LOGIN_WINDOW_SECONDS',
        60
      ),
    },
  },
} as const;

export type Config = typeof config;