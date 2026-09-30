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
 * Kafka is an ASYNCHRONOUS side-effect channel (Day 7), not a system of record.
 * Like Redis, it therefore has working local defaults and is never part of the
 * "required variables" check: the API must boot and take payments even when the
 * broker is down - the events wait in the MySQL outbox instead.
 * See docs/KAFKA.md §7 "What happens when Kafka is down".
 */
const DEFAULT_KAFKA_BROKERS = '127.0.0.1:9092';

function readKafkaBrokers(): string[] {
  const raw = process.env.KAFKA_BROKERS?.trim();
  const value = raw === undefined || raw === '' ? DEFAULT_KAFKA_BROKERS : raw;
  const brokers = value
    .split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);

  if (brokers.length === 0) {
    throw new Error(`KAFKA_BROKERS must list at least one host:port. Got: "${value}"`);
  }
  for (const broker of brokers) {
    if (!/^[^\s:]+:\d{1,5}$/.test(broker)) {
      throw new Error(
        `KAFKA_BROKERS entries must look like host:port. Got: "${broker}" in "${value}"`
      );
    }
  }
  return brokers;
}

function optionalBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`Environment variable ${name} must be true/false. Got: "${value}"`);
}

/** The environments this project actually supports. */
const NODE_ENVS = ['development', 'test', 'production'] as const;
type NodeEnv = (typeof NODE_ENVS)[number];

function readNodeEnv(): NodeEnv {
  const raw = (process.env.NODE_ENV ?? 'development').trim().toLowerCase();
  if (!(NODE_ENVS as readonly string[]).includes(raw)) {
    throw new Error(`NODE_ENV must be one of ${NODE_ENVS.join(' | ')}. Got: "${raw}"`);
  }
  return raw as NodeEnv;
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;

/**
 * Log verbosity. Validated here so a typo (`LOGG_LEVEL=verbose`) fails at boot
 * instead of silently falling back to a default nobody chose.
 */
function readLogLevel(): string {
  const raw = (process.env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(raw)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(' | ')}. Got: "${raw}"`);
  }
  return raw;
}

/**
 * `trust proxy` (Day 8). Express uses this to decide whether `X-Forwarded-For`
 * may be believed when computing `req.ip`.
 *
 * The default is `false`, which is the SAFE default: with no trusted proxy, a
 * client could otherwise send `X-Forwarded-For: <random>` on every login attempt
 * and bypass the (ip + account) rate limiter entirely. Only enable it when a
 * reverse proxy/load balancer you control really is in front, and then set it to
 * the specific hop count or subnet - never blanket `true` in production.
 */
function readTrustProxy(): boolean | number | string {
  const raw = process.env.TRUST_PROXY?.trim();
  if (raw === undefined || raw === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return raw; // e.g. 'loopback' or a CIDR list - passed through to Express
}

/**
 * CORS allowlist (Day 8). The Express `cors()` default (`*`) is fine for a
 * public, credential-free API in development, but it is not a decision a
 * production deployment should inherit by accident - so production refuses to
 * boot without an explicit list.
 */
function readCorsOrigins(env: NodeEnv): 'all' | string[] {
  const raw = process.env.CORS_ORIGINS?.trim();
  if (raw === undefined || raw === '' || raw === '*') {
    if (env === 'production') {
      throw new Error(
        'CORS_ORIGINS must be set explicitly in production (comma-separated origins). ' +
          'Refusing to boot with wildcard CORS, where any website could call this API from a browser.'
      );
    }
    return 'all';
  }

  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (origins.length === 0) {
    throw new Error(`CORS_ORIGINS must list at least one origin. Got: "${raw}"`);
  }
  return origins;
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

const env = readNodeEnv();

/**
 * Production guard rails (Day 8).
 *
 * Everything below has a working development default, and each of those
 * defaults is exactly what you do NOT want in production: an example JWT
 * secret, wide-open CORS, a placeholder database URL. Rather than documenting
 * "remember to change these", the process refuses to start - a boot failure is
 * loud, immediate and unmissable, whereas a leaked default secret is silent
 * until it is exploited.
 */
const KNOWN_PLACEHOLDER_SECRETS = [
  'replace-with-a-random-secret-at-least-32-chars-long',
  'changeme',
  'secret',
];

if (env === 'production') {
  if (KNOWN_PLACEHOLDER_SECRETS.some((placeholder) => jwtSecret.includes(placeholder))) {
    throw new Error('JWT_SECRET is still a placeholder value. Refusing to start in production.');
  }
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('USER:PASSWORD')) {
    throw new Error('DATABASE_URL is still the .env.example placeholder. Refusing to start in production.');
  }
  // CORS_ORIGINS is validated by readCorsOrigins() below.
  if (process.env.TRUST_PROXY === 'true') {
    throw new Error(
      'TRUST_PROXY=true in production trusts X-Forwarded-For from ANY peer, which makes the ' +
        'login rate limiter bypassable. Set it to a hop count or a trusted subnet instead.'
    );
  }
}

export const config = {
  env,
  port: toPositiveInt(process.env.PORT as string, 'PORT'),
  /**
   * Identifies which deployable a log line came from. The API and the worker
   * share one codebase and one log stream shape, so this is how their lines are
   * told apart (along with `role` in the startup logs).
   */
  service: process.env.SERVICE_NAME?.trim() || 'ecommerce-platform-backend',
  log: {
    /** `debug` locally, `info` in a deployed environment. Validated above. */
    level: readLogLevel(),
    service: process.env.SERVICE_NAME?.trim() || 'ecommerce-platform-backend',
  },
  http: {
    /** Passed straight to `app.set('trust proxy', ...)`. Default: false. */
    trustProxy: readTrustProxy(),
    /** `'all'` (dev) or an explicit allowlist (required in production). */
    corsOrigins: readCorsOrigins(env),
    /**
     * Total budget for graceful shutdown. In-flight requests get whatever is
     * left after the other steps; the process never lingers past this.
     */
    shutdownTimeoutMs: optionalPositiveInt(
      process.env.SHUTDOWN_TIMEOUT_MS,
      'SHUTDOWN_TIMEOUT_MS',
      10_000
    ),
    /** How long to wait for in-flight requests before forcing connections shut. */
    drainTimeoutMs: optionalPositiveInt(
      process.env.SHUTDOWN_DRAIN_TIMEOUT_MS,
      'SHUTDOWN_DRAIN_TIMEOUT_MS',
      5_000
    ),
  },
  metrics: {
    /**
     * When set, `GET /api/metrics` requires `Authorization: Bearer <token>`.
     * Unset (the local default) leaves it open; a deployment should set it,
     * because the payload describes internal counters and backlogs.
     */
    token: process.env.METRICS_TOKEN?.trim() || '',
  },
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
  /**
   * Kafka / event-driven side effects (Day 7). Everything here has a
   * development-friendly default; production would override brokers and
   * security settings per environment and never commit credentials.
   */
  kafka: {
    /** Master switch. `false` turns the producer and consumers off entirely. */
    enabled: optionalBoolean(process.env.KAFKA_ENABLED, 'KAFKA_ENABLED', true),
    brokers: readKafkaBrokers(),
    /** Identifies this process in broker logs / quotas. */
    clientId: process.env.KAFKA_CLIENT_ID?.trim() || 'ecommerce-platform-backend',
    /** Consumer group for the notification worker (see docs/KAFKA.md §5). */
    notificationGroupId: process.env.KAFKA_NOTIFICATION_GROUP_ID?.trim() || 'notification-service',
    /**
     * How many times a consumer retries ONE message before dead-lettering it.
     * Transient failures (DB blip) recover inside these attempts; a poison
     * message must not stall the partition forever.
     */
    consumerMaxAttempts: optionalPositiveInt(
      process.env.KAFKA_CONSUMER_MAX_ATTEMPTS,
      'KAFKA_CONSUMER_MAX_ATTEMPTS',
      3
    ),
    consumerRetryDelayMs: optionalPositiveInt(
      process.env.KAFKA_CONSUMER_RETRY_DELAY_MS,
      'KAFKA_CONSUMER_RETRY_DELAY_MS',
      250
    ),
    /**
     * Ceiling for the consumer's exponential retry backoff (Day 8). Delays grow
     * 250 -> 500 -> 1000 ... and stop growing here. The number of attempts is
     * bounded separately by `consumerMaxAttempts`, so this only ever spaces
     * attempts out - it cannot turn into an unbounded retry loop.
     */
    consumerRetryMaxDelayMs: optionalPositiveInt(
      process.env.KAFKA_CONSUMER_RETRY_MAX_DELAY_MS,
      'KAFKA_CONSUMER_RETRY_MAX_DELAY_MS',
      5_000
    ),
    outbox: {
      /**
       * Attempts before a stuck outbox row is parked as DEAD. This is a much
       * larger budget than the consumer's: a broker outage is expected and
       * recoverable, so events simply wait rather than being given up on.
       */
      maxAttempts: optionalPositiveInt(
        process.env.KAFKA_OUTBOX_MAX_ATTEMPTS,
        'KAFKA_OUTBOX_MAX_ATTEMPTS',
        10
      ),
      /** How often the background dispatcher looks for pending events. */
      dispatchIntervalMs: optionalPositiveInt(
        process.env.KAFKA_OUTBOX_DISPATCH_INTERVAL_MS,
        'KAFKA_OUTBOX_DISPATCH_INTERVAL_MS',
        2_000
      ),
      /**
       * First retry delay for a row that failed to publish (Day 8). Grows
       * exponentially from here up to `retryMaxDelayMs`, and is what makes
       * `maxAttempts` a budget spread over MINUTES rather than over the
       * dispatch interval.
       */
      retryBaseDelayMs: optionalPositiveInt(
        process.env.KAFKA_OUTBOX_RETRY_BASE_DELAY_MS,
        'KAFKA_OUTBOX_RETRY_BASE_DELAY_MS',
        1_000
      ),
      /** Ceiling for the exponential outbox retry backoff. */
      retryMaxDelayMs: optionalPositiveInt(
        process.env.KAFKA_OUTBOX_RETRY_MAX_DELAY_MS,
        'KAFKA_OUTBOX_RETRY_MAX_DELAY_MS',
        60_000
      ),
      /** Events published per dispatch round (keeps each tick bounded). */
      batchSize: optionalPositiveInt(
        process.env.KAFKA_OUTBOX_BATCH_SIZE,
        'KAFKA_OUTBOX_BATCH_SIZE',
        50
      ),
    },
    /**
     * Client-side timeouts. A publish must never sit on a dead socket for
     * minutes; the event is retried from the outbox instead.
     */
    connectionTimeoutMs: optionalPositiveInt(
      process.env.KAFKA_CONNECTION_TIMEOUT_MS,
      'KAFKA_CONNECTION_TIMEOUT_MS',
      3_000
    ),
    requestTimeoutMs: optionalPositiveInt(
      process.env.KAFKA_REQUEST_TIMEOUT_MS,
      'KAFKA_REQUEST_TIMEOUT_MS',
      5_000
    ),
  },
} as const;

export type Config = typeof config;