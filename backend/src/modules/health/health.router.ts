import { Router } from 'express';
import { getHealth, getLiveness, getReadiness } from './health.controller';

export const healthRouter: Router = Router();

/**
 * Three endpoints, three different questions (Day 8):
 *
 *   /api/health          the full human-facing report (kept from Day 1-7)
 *   /api/health/live     "should this process be RESTARTED?"
 *   /api/health/ready    "should this process receive TRAFFIC?"
 *
 * Liveness must never depend on a dependency, readiness must depend on the ones
 * that make requests fail. Conflating them is the classic way to turn one
 * database blip into a fleet-wide restart loop - see docs/RELIABILITY.md.
 */
healthRouter.get('/', getHealth);
healthRouter.get('/live', getLiveness);
healthRouter.get('/ready', getReadiness);