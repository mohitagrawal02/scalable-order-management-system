import { Router } from 'express';
import { getMetrics, requireMetricsToken } from './metrics.controller';

/**
 * Operational metrics router (Day 8).
 *
 * Deliberately NOT authenticated as a user: a metrics scrape is a machine
 * calling on behalf of the platform, not a person. `METRICS_TOKEN` (optional)
 * is the gate - see metrics.controller for the reasoning.
 */
export const metricsRouter: Router = Router();

metricsRouter.get('/', requireMetricsToken, getMetrics);