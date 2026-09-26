import { NextFunction, Request, Response } from 'express';
import { prisma } from '../../config/prisma';
import { getRedisStatus, pingRedis } from '../../infrastructure/redis';

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
 */
export async function getHealth(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;

    const redisStatus = getRedisStatus();
    const redisReachable = redisStatus === 'ready' ? await pingRedis() : false;

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
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(new Error('Database health check failed'));
  }
}