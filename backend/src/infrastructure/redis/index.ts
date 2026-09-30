/**
 * Redis infrastructure barrel (Day 6).
 *
 * Consumers import from here so the file layout inside
 * `src/infrastructure/redis/` stays an implementation detail:
 *
 *   - `client`      → connection lifecycle, status, graceful shutdown
 *   - `cache`       → generic JSON cache-aside primitives (+ stats)
 *   - `rateLimiter` → atomic fixed-window counter
 */
export {
  redis,
  getRedisStatus,
  isRedisReady,
  pingRedis,
  closeRedis,
  type RedisStatus,
} from './client';
export {
  cache,
  createCache,
  getCacheStats,
  redisCommands,
  resetCacheStats,
  type Cache,
  type CacheCommandSet,
  type CacheLookup,
  type CacheStats,
} from './cache';
export {
  consumeRateLimit,
  getRateLimitStats,
  resetRateLimitStats,
  type RateLimitResult,
  type RateLimitStats,
} from './rateLimiter';
