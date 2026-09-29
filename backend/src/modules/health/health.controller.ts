import { NextFunction, Request, Response } from 'express';
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
export async function getHealth(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;

    const redisStatus = getRedisStatus();
    const redisReachable = redisStatus === 'ready' ? await pingRedis() : false;

    const kafkaReachable = await pingKafka();
    const pendingEvents = await countPendingOutboxEvents();
    const deadEvents = await countDeadOutboxEvents();

    res.status(200).json({
      status: 'ok',
      service: 'ecommerce-platform-backend',
      database: 'up',
      redis: {
        status: redisReachable ? 'up' : 'down',
        connection: redisStatus,
        // Explicit, so nobody has to guess what "degraded" means here.
        impact: redisReachable ? 'none' : 'cache misses fall back to MySQL; rate limiting fails open',
      },
      kafka: {
        status: kafkaReachable ? 'up' : 'down',
        // Backlog = committed events not yet accepted by the broker.
        pendingEvents,
        // Events the outbox gave up on after its retry budget. Should be 0.
        deadEvents,
        published: getOutboxStats().published,
        impact: kafkaReachable
          ? 'none'
          : 'events are committed to the outbox and published when the broker returns; notifications are delayed, requests are unaffected',
      },
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(new Error('Database health check failed'));
  }
}