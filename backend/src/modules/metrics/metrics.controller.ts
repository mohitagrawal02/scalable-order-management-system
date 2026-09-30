import { timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { config } from '../../config';
import {
  getConsumerStats,
  getOutboxStats,
  getProducerStats,
} from '../../infrastructure/kafka';
import { getHttpMetrics } from '../../infrastructure/metrics';
import { getCacheStats, getRateLimitStats } from '../../infrastructure/redis';

/**
 * GET /api/metrics (Day 8)
 *
 * WHAT THIS IS FOR
 * ----------------
 * One JSON document answering "is this process behaving?" without attaching a
 * debugger: request counts and latency buckets per route, cache hit rate, rate
 * limiter decisions, producer/outbox/consumer counters, and how many requests
 * are still in flight (the number that matters during a deploy).
 *
 * WHY JSON AND NOT PROMETHEUS TEXT
 * --------------------------------
 * The rest of the API speaks JSON, there is no scraper here, and the payload is
 * meant to be read by a human or asserted on by a test. The shape is stable and
 * grouped by subsystem, so converting it to a scrape format later is a
 * translation, not a redesign. See `src/infrastructure/metrics` for why the
 * registry is in-process.
 *
 * THE ONE NUMBER TO WATCH
 * -----------------------
 * `security.rateLimit.degraded`. Every increment is a request that was NOT
 * rate limited because Redis was unreachable - the limiter failing open. It is
 * a security signal, not a performance one, and it is zero-cost to track; not
 * having it meant a Redis outage silently disabled brute-force protection.
 *
 * ACCESS
 * ------
 * The payload describes internal counters, backlogs and process ids. When
 * METRICS_TOKEN is set the endpoint requires `Authorization: Bearer <token>`;
 * when it is unset (local development) the endpoint stays open.
 */
export async function getMetrics(_req: Request, res: Response): Promise<void> {
  res.status(200).json({
    service: config.service,
    env: config.env,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),

    http: getHttpMetrics(),

    cache: getCacheStats(),

    security: {
      /**
       * Rate limiter decisions since start. `degraded` = fail-open occurrences.
       */
      rateLimit: getRateLimitStats(),
    },

    events: {
      kafkaEnabled: config.kafka.enabled,
      producer: getProducerStats(),
      outbox: getOutboxStats(),
      consumer: getConsumerStats(),
    },
  });
}

/**
 * Optional bearer-token guard for `/api/metrics`.
 *
 * Comparison is constant-time (`timingSafeEqual`) over equal-length buffers.
 * That matters more here than it looks: `X-Forwarded-For` is client-controlled
 * and the login limiter keys on it, so an attacker CAN deliberately consume
 * login budget to make a timing measurement expensive. A cheap string compare
 * here would leak the token one byte at a time to anyone patient enough.
 */
export function requireMetricsToken(req: Request, res: Response, next: NextFunction): void {
  const expected = config.metrics.token;
  if (expected === '') {
    // No token configured: metrics stay open (the documented local default).
    next();
    return;
  }

  const header = req.headers.authorization;
  const supplied = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : '';

  if (!tokensMatch(supplied, expected)) {
    res.status(401).json({
      error: { status: 401, message: 'Metrics require a valid bearer token' },
    });
    return;
  }

  next();
}

function tokensMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Length is not secret (and comparing unequal lengths would itself leak it
  // via timing), but the bytes are only compared when the lengths agree.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}