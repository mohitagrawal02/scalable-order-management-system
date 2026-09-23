import { NextFunction, Request, Response } from 'express';
import { prisma } from '../../config/prisma';

/**
 * GET /api/health
 *
 * Confirms the process is up AND that the database connection is working.
 * Used by local development and (later) by orchestrators/load balancers.
 */
export async function getHealth(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.status(200).json({
      status: 'ok',
      service: 'ecommerce-platform-backend',
      database: 'up',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(new Error('Database health check failed'));
  }
}