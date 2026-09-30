/**
 * Metrics barrel (Day 8).
 *
 * Only HTTP request metrics live here; every other subsystem already owns its
 * own counters (`getCacheStats`, `getRateLimitStats`, `getProducerStats`,
 * `getOutboxStats`, `getConsumerStats`) and the metrics controller composes
 * them. That keeps each module the single source of truth for its own numbers.
 */
export {
  DURATION_BUCKETS_MS,
  getHttpMetrics,
  metricsRequestFinished,
  metricsRequestStarted,
  resetHttpMetrics,
  type HttpMetricsSnapshot,
  type RouteMetrics,
} from './metrics';
