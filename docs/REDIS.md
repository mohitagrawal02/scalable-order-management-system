# Redis Architecture & Integration (Day 6)

This document describes the Redis integration introduced in Day 6: product catalog caching and authentication rate limiting, including cache invalidation strategies, atomic rate-limiting mechanics, graceful degradation (fail-open policies), and health monitoring.

---

## 1. Overview & Motivation

As read and write traffic grow, two distinct operational risks emerge:
1. **Catalog read contention**: The product catalog is read-heavy (frequently browsed, infrequently modified). Uncached list/detail queries hit MySQL repeatedly with full table scans, sorting, and pagination.
2. **Authentication abuse**: Brute-force credential guessing against `/api/auth/login` consumes expensive bcrypt hashing CPU cycles and presents an account takeover risk.

Redis serves as an in-memory acceleration and protection layer:
- **Product Catalog Cache**: Cache-aside caching for product detail and list endpoints with an O(1) version-bump invalidation strategy.
- **Login Rate Limiter**: Atomic fixed-window rate limiter (5 requests / 60 seconds) keyed by hashed `(ip, account)`.
- **Zero-Downtime Fallback (Fail-Open)**: If Redis is unavailable or times out, the backend gracefully falls back to MySQL for product data and allows login attempts to proceed. A Redis outage never brings down the primary API.

---

## 2. Infrastructure Layer (`src/infrastructure/redis/`)

The Redis integration is isolated inside `src/infrastructure/redis/`:

```
src/infrastructure/redis/
├── client.ts       # ioredis singleton, connection lifecycle, fast-fail settings
├── cache.ts        # Generic JSON cache-aside helpers, stats tracking, logging
├── rateLimiter.ts  # Atomic Lua script for fixed-window rate limiting
└── index.ts        # Public barrel exporting client, cache, and rate limiter
```

### Client Configuration & Fast-Fail Policies

```ts
new Redis(config.redis.url, {
  enableOfflineQueue: false,      // Fail immediately when down; do NOT buffer commands
  maxRetriesPerRequest: 1,        // Fail fast instead of retrying stalled commands
  commandTimeout: 500,            // 500ms hard deadline per command
  connectTimeout: 2_000,          // 2s connect deadline
  retryStrategy: (attempt) => Math.min(attempt * 200, 2_000), // Exponential backoff capped at 2s
  lazyConnect: false,
})
```

- **`enableOfflineQueue: false`**: Crucial for HTTP resiliency. If Redis drops, commands reject in microseconds rather than queuing indefinitely in memory and exhausting Node.js heap or hanging HTTP requests.
- **`commandTimeout: 500ms`**: Ensures slow Redis calls never stall client requests past acceptable latencies.
- **Auto-reconnection**: Exponential backoff reconnects automatically as soon as Redis comes back up, without requiring an application restart.


---

## 3. Product Catalog Caching (`product.cache.ts`)

### Cache-Aside Flow

```
HTTP GET /api/products/:id
       │
       ▼
 ┌───────────────┐   HIT
 │  Redis Cache  │──────────► Return cached JSON
 └───────┬───────┘
         │ MISS / ERROR
         ▼
 ┌───────────────┐
 │ MySQL (Prisma)│──────────► Warm Redis Cache (async) ──► Return DB JSON
 └───────────────┘
```

### Key Formats & Namespaces

| Purpose | Key Pattern | TTL | Invalidation Trigger |
|---------|-------------|-----|----------------------|
| Single Product Detail | `product:<id>` | 60s | Direct `DEL` on `updateProduct` / `deleteProduct` |
| Catalog List Version | `catalog:list:version` | None (counter) | `INCR` on `createProduct` / `updateProduct` / `deleteProduct` |
| Product List Query | `product:list:v<version>:<sha256_hash>` | 60s | Natural abandonment when `version` increments |

### Invalidation Strategy: Version-Bump vs. Key Scanning

Instead of issuing dangerous `KEYS product:list:*` or expensive `SCAN` operations across Redis when a product changes, we use **Namespace Versioning**:
1. Every list query key includes a version prefix: `product:list:v<version>:<hash>`.
2. `<hash>` is a deterministic 16-character SHA-256 digest of sorted query parameters (`category`, `sort`, `order`, `page`, `limit`).
3. When any product is created, updated, or deleted, `catalog:list:version` is atomically incremented via Redis `INCR`.
4. Subsequent list requests read the new version number and construct new keys (e.g., `v2` instead of `v1`).
5. Old list entries (`v1`) become unreachable immediately and naturally expire via their 60-second TTL.

**Benefits**:
- **O(1) complexity**: Invalidation is a single `INCR` command regardless of how many filter/page permutations exist.
- **Zero blocking**: No locks or scans on the Redis thread.

---

## 4. Login Rate Limiting (`auth.rateLimit.ts`)

### Policy

- **Limit**: 5 attempts per 60-second fixed window.
- **Scope**: Hashed `(ip, account)` tuple (`SHA-256(ip + ":" + normalized_email)`).
- **Responses**:
  - Allowed: Passes through to controller; headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` attached.
  - Exceeded: HTTP `429 Too Many Requests` with `Retry-After: <seconds>` header and standardized error envelope.

### Atomic Lua Script

A naïve `INCR` followed by `EXPIRE` creates a race condition where the process can crash or disconnect between the two commands, leaving a key with infinite TTL (a permanent account lock).

We use an atomic Lua script executed server-side in Redis:

```lua
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return { current, ttl }
```

- Guarantees `EXPIRE` is set synchronously when the key is initialized.
- Returns current count and exact remaining TTL in a single round-trip.

### Privacy & Scope Isolation

---

## 5. Graceful Degradation & Fail-Open Resilience

Both Redis subsystems adhere to a strict **fail-open** policy:

| Subsystem | Failure Scenario | Behavior | User Impact |
|-----------|------------------|----------|-------------|
| Product Detail Cache | Redis down / timeout | Log error, query MySQL directly | No user impact; slightly increased DB load |
| Product List Cache | Redis down / timeout | Log error, query MySQL directly | No user impact; slightly increased DB load |
| Cache Write (`SET`) | Redis error / timeout | Log warning, return DB result | No user impact; next read will retry cache warm |
| Login Rate Limiter | Redis down / timeout | Log warning, allow login request | Logins succeed; fallback protects user access |

### Monitoring & Cache Stats

`src/infrastructure/redis/cache.ts` maintains in-process operational metrics accessible via `getCacheStats()`:
- `hits`: Cache hits served from memory.
- `misses`: Cache misses served from MySQL.
- `sets`: Successful cache warm writes.
- `setFailures`: Cache write failures gracefully handled.
- `errors`: Read/invalidation connection errors handled.
- `invalidations`: Explicit invalidation operations triggered.
- `keysDeleted`: Total keys explicitly removed.

---

## 6. Health Check Integration

The `/api/health` endpoint reports the real-time operational status of Redis alongside MySQL:

```json
{
  "status": "ok",
  "service": "ecommerce-platform-backend",
  "database": "up",
  "redis": {
    "status": "up",
    "connection": "ready",
    "impact": "none"
  },
  "uptimeSeconds": 142,
  "timestamp": "2026-09-26T02:00:00.000Z"
}
```

If Redis goes down, `redis.status` reports `"degraded"` with impact `"caching-disabled, rate-limiting-fail-open"`, while overall service health remains 200 OK because the primary relational database and core application logic remain fully functional.

---

## 7. Testing & Verification

Comprehensive integration test suites in `tests/integration/`:

- **`cache.test.ts`** (10 scenarios):
  1. Miss followed by hit with byte-identical payload.
  2. Read staleness bounded by API writes.
  3. Deterministic query key hashing across permutation of filters/pagination.
  4. Detail key caching (`product:<id>`).
  5. Detail and list invalidation on product update.
  6. Invalidation on product deletion.
  7. Invalidation on product creation.
  8. TTL expiration causing miss.
  9. Outage degradation: graceful fallback to MySQL without 500s.
  10. Write failure resilience: Redis `SET` failure does not fail the HTTP request.

- **`rateLimit.test.ts`** (9 scenarios):
  1. Allows attempts below budget and computes remaining attempts.
  2. Rejects past limit with HTTP 429 and `Retry-After`.
  3. Successful logins below limit return valid JWT tokens.
  4. Isolation: limit scoped to `(ip, account)` — locked account does not affect another.
  5. Window resets after TTL expiration.
  6. Key privacy: hashed identifier in Redis.
  7. Concurrency: atomic Lua script prevents race condition leaks under burst traffic.
  8. Error format: 429 matches standard application error envelope.
  9. Fail-open degradation: authentication functions during simulated Redis outage.


- Keys store `rate-limit:login:<sha256(ip + ":" + email)>`.
- No raw user email addresses or IP addresses are persisted into Redis keys.
- Scoping by `(ip, email)` prevents a malicious actor from locking out an honest user across the entire internet by spamming an email, and prevents one user on a shared NAT/corporate IP from locking out coworkers.
