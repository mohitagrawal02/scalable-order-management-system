import { NextFunction, Request, Response } from 'express';
import { config } from '../../config';
import { prisma } from '../../config/prisma';
import { getRedisStatus, pingRedis } from '../../infrastructure/redis';
import {
  countDeadOutboxEvents,
  countPendingOutboxEvents,
  getOutboxStats,
  pingKafka,
} from '../../infrastructure/kafka';

/**
 * GET /api/health
 *
 * Confirms the process is up AND that the database connection is working.
 * Used by local development and (later) by orchestrators/load balancers.
 *
 * Day 6 adds Redis visibility. Redis is reported but NEVER decides the overall
 * status: it is an optimisation layer, so a Redis outage must not take this
 * instance out of a load balancer (that would turn a cache outage into an
 * application outage - see docs/REDIS.md).
 *
 * Day 7 adds Kafka visibility. Same rule applies, for the same reason: the API
 * only PRODUCES events, and a producer that cannot reach the broker still
 * serves every request (events queue up in the outbox). So Kafka never decides
 * `status` either.
 *
 * The interesting number here is `pendingEvents` - the outbox backlog. It is
 * the one honest measure of "is the asynchronous side of the system keeping
 * up?": flat near zero is healthy, growing means the broker or a consumer is
 * struggling, and `deadEvents > 0` means something needed human attention.
 */
/** The result of one round of dependency probes. */
export interface DependencyReport {
  database: 'up' | 'down';
  redis: { status: 'up' | 'down'; connection: string; impact: string };
  kafka: {
    status: 'up' | 'down';
    pendingEvents: number;
    deadEvents: number;
    published: number;
    impact: string;
  };
}

/**
 * Probes every dependency exactly once, for every endpoint that reports them.
 *
 * Deliberately NEVER throws: a health endpoint that can throw is one that
 * reports "up" for the wrong reason (the 500 came from the probe, not from the
 * dependency it was describing). Each probe is independent, so one dead
 * dependency cannot hide the state of the others - which is exactly what an
 * operator needs when three systems are down and only one of them is the cause.
 */
async function probeDependencies(): Promise<DependencyReport> {
  let database: 'up' | 'down' = 'down';
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = 'up';
  } catch {
    database = 'down';
  }

  const redisStatus = getRedisStatus();
  const redisReachable = redisStatus === 'ready' ? await pingRedis() : false;
  const kafkaReachable = await pingKafka();

  return {
    database,
    redis: {
      status: redisReachable ? 'up' : 'down',
      connection: redisStatus,
      // Explicit, so nobody has to guess what "degraded" means here.
      impact: redisReachable
        ? 'none'
        : 'cache misses fall back to MySQL; rate limiting fails open',
    },
    kafka: {
      status: kafkaReachable ? 'up' : 'down',
      // Backlog = committed events not yet accepted by the broker.
      pendingEvents: await countPendingOutboxEvents(),
      // Events the outbox gave up on after its retry budget. Should be 0.
      deadEvents: await countDeadOutboxEvents(),
      published: getOutboxStats().published,
      impact: kafkaReachable
        ? 'none'
        : 'events are committed to the outbox and published when the broker returns; notifications are delayed, requests are unaffected',
    },
  };
}

export async function getHealth(_req: Request, res: Response, next: NextFunction): Promise<void> {
  const report = await probeDependencies();

  // Preserved contract from Day 1-7: when MySQL is unreachable this endpoint
  // answers 500 through the error handler, because "the database is down" is a
  // server-side fault and a 200 would be a lie.
  if (report.database === 'down') {
    next(new Error('Database health check failed'));
    return;
  }

  res.status(200).json({
    status: 'ok',
    service: config.service,
    database: 'up',
    redis: report.redis,
    kafka: report.kafka,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

/**
 * GET /api/health/live  (liveness probe)
 *
 * THE QUESTION: "would RESTARTING this process fix anything?"
 *
 * So it checks nothing except the fact that we are executing. That absence of
 * dependency checks IS the design, and it is the opposite of the intuitive
 * choice:
 *
 *   - If liveness checked MySQL, a 30-second database failover would make every
 *     instance fail its probe, the orchestrator would restart the whole fleet at
 *     once, and nothing would be able to boot until the database came back: a
 *     self-inflicted outage caused by the health check itself.
 *   - A process merely waiting on a slow database is not wedged. Readiness is
 *     what should stop traffic going to it; restarting it loses the in-flight
 *     work and changes nothing about the database.
 *
 * What liveness DOES catch is the unrecoverable case - a wedged or deadlocked
 * event loop stops answering this request too, and only a restart fixes that.
 * Hence: no I/O, no allocations, no await.
 */
export function getLiveness(_req: Request, res: Response): void {
  res.status(200).json({
    status: 'alive',
    service: config.service,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

/**
 * GET /api/health/ready  (readiness probe)
 *
 * THE QUESTION: "can this instance serve a CORRECT request right now?"
 *
 * Each dependency is judged by the same honest test - "without this, does a
 * request fail?":
 *
 *   MySQL  REQUIRED. The system of truth: every write and most reads need it.
 *          Without it the API answers 500, so traffic must go elsewhere - and
 *          while an instance has no traffic its events keep accumulating safely
 *          in the outbox.
 *   Redis  OPTIONAL by design (Day 6). Cache miss → read MySQL; the rate limiter
 *          fails open. Removing instances from rotation would turn a cache
 *          outage into an application outage.
 *   Kafka  OPTIONAL by design (Day 7). Producing never blocks a request and
 *          unpublished events are durable in MySQL. Removing instances would
 *          cascade a slow broker into an API outage while doing nothing at all
 *          to drain the backlog.
 *
 * The outbox backlog is reported but likewise never decides readiness: a growing
 * backlog calls for CONSUMER capacity, and removing API instances would only
 * remove the processes that are still taking payments.
 */
export async function getReadiness(_req: Request, res: Response): Promise<void> {
  const report = await probeDependencies();
  const ready = report.database === 'up';

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not-ready',
    service: config.service,
    checks: {
      database: { status: report.database, required: true },
      redis: { ...report.redis, required: false },
      kafka: { ...report.kafka, required: false },
    },
    // The one-line answer for whoever is getting paged: what is wrong, and what
    // it costs the user.
    impact: ready
      ? 'none'
      : 'MySQL is unreachable: requests that need the database would fail, so this instance is asking to be taken out of rotation',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}