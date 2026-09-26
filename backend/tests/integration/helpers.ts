/**
 * Shared helpers for the API integration tests (Day 4+).
 *
 * These tests exercise the REAL Express app against the REAL local MySQL:
 *  - the app is started in-process via `createApp()` on an ephemeral port, so
 *    no manually started server is required;
 *  - data is created through the public HTTP API (never by writing tables
 *    directly), except for two things the API deliberately does not expose
 *    yet: inventory levels and a user's role. Those go through Prisma.
 *
 * Every row created here is namespaced with TEST_PREFIX and swept by
 * `cleanupTestData()` so the database is left exactly as it was found.
 */
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/prisma';
import {
  closeRedis,
  getCacheStats,
  redis,
  resetCacheStats,
  type CacheStats,
} from '../../src/infrastructure/redis';

/**
 * All test-created email addresses start with this.
 *
 * Day 6 note: the login rate limiter keys on (client IP + targeted account),
 * so every test that registers its own user gets its OWN counter. The
 * regression suites therefore keep working unchanged while the dedicated
 * rate-limit suite can exhaust a single account's window on purpose.
 */
export const TEST_PREFIX = 'day4test.';
const SKU_PREFIX = 'DAY4TEST-';

export const TEST_PASSWORD = 'IntegrationPass123!';

let server: Server | undefined;
let baseUrl = '';

/** Boots the app on a random free port. */
export async function startTestServer(): Promise<void> {
  if (server) return;
  const app = createApp();
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

export async function stopTestServer(): Promise<void> {
  if (server) {
    const running = server;
    server = undefined;
    await new Promise<void>((resolve) => running.close(() => resolve()));
  }
  await prisma.$disconnect();
  // Close the shared Redis socket too, otherwise the open handle keeps the
  // test process alive after the last assertion.
  await closeRedis();
}

export interface ApiResult<T> {
  status: number;
  body: T;
  /** Response headers (e.g. Retry-After / X-RateLimit-* on 429s). */
  headers: Headers;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Redis test utilities (Day 6)
 * ─────────────────────────────────────────────────────────────────────────────
 * The tests assert on REAL Redis state (keys, TTLs, counters), so these
 * helpers talk to the same client the application uses. Redis is optional
 * infrastructure for the app, but REQUIRED for the Day-6 suites - they assert
 * it is reachable up front instead of silently passing while degraded.
 */

/** Namespaces the app writes, used for test isolation sweeps. */
export const REDIS_TEST_PATTERNS = ['product:*', 'catalog:*', 'rate-limit:*'] as const;

/** True when Redis accepts commands right now. */
export function isRedisAvailable(): boolean {
  return redis.status === 'ready';
}

/** Polls until the shared client is `ready` (or the timeout elapses). */
export async function waitForRedis(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isRedisAvailable()) return true;
    await delay(100);
  }
  return isRedisAvailable();
}

/**
 * Throws a helpful message when Redis is not running. Called by the Day-6
 * suites' `before()` hooks - a Redis outage must FAIL those tests loudly, not
 * skip them (the whole point of the suite is to verify real cache behaviour).
 * Waits for the connection handshake first, so a slow connect is not mistaken
 * for an outage.
 */
export async function requireRedis(timeoutMs = 10_000): Promise<void> {
  if (await waitForRedis(timeoutMs)) return;
  throw new Error(
    'Redis is required for this test suite but is not reachable at ' +
      `${redis.options.host}:${redis.options.port} (status="${redis.status}"). Start it with ` +
      '`docker compose -f docker-compose.redis.yml up -d` or a local redis-server.'
  );
}

/** Collects keys matching a pattern with SCAN (never the blocking KEYS). */
export async function scanRedisKeys(pattern: string): Promise<string[]> {
  if (!isRedisAvailable()) return [];
  const keys: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = redis.scanStream({ match: pattern, count: 200 });
    stream.on('data', (batch: string[]) => keys.push(...batch));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return keys;
}

/** Deletes every key matching `pattern`; returns how many were removed. */
export async function deleteRedisKeysMatching(pattern: string): Promise<number> {
  const keys = await scanRedisKeys(pattern);
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 100) {
    deleted += await redis.del(...keys.slice(i, i + 100));
  }
  return deleted;
}

/**
 * Removes all Redis state the app could have produced (cache + counters), so
 * each suite starts from a cold cache. Also resets the in-process cache
 * counters, which several assertions measure as deltas.
 */
export async function clearRedisTestState(): Promise<void> {
  for (const pattern of REDIS_TEST_PATTERNS) {
    await deleteRedisKeysMatching(pattern);
  }
  resetCacheStats();
}

/** Current value + TTL of one key (`null` when the key does not exist). */
export async function getRedisEntry(
  key: string
): Promise<{ value: string; ttlSeconds: number } | null> {
  if (!isRedisAvailable()) return null;
  const value = await redis.get(key);
  if (value === null) return null;
  return { value, ttlSeconds: await redis.ttl(key) };
}

/** Parsed JSON payload of one cache key, or null when absent. */
export async function getCachedJson<T>(key: string): Promise<T | null> {
  const entry = await getRedisEntry(key);
  return entry === null ? null : (JSON.parse(entry.value) as T);
}

/**
 * Simulates a Redis outage in-process (used by the degradation tests).
 *
 * ioredis closes the socket asynchronously, so this waits until the client has
 * actually left the `ready` state - otherwise the next command would still be
 * sent on the dying socket and the test would prove nothing.
 */
export async function disconnectRedisForTest(timeoutMs = 3_000): Promise<void> {
  redis.disconnect();
  const deadline = Date.now() + timeoutMs;
  while (isRedisAvailable() && Date.now() < deadline) {
    await delay(10);
  }
}

/**
 * Restores the connection after `disconnectRedisForTest()` and waits for a real
 * command round-trip, so later assertions cannot hit a half-open socket.
 */
export async function reconnectRedisForTest(timeoutMs = 5_000): Promise<void> {
  try {
    await redis.connect();
  } catch {
    // "Already connecting/connected" is fine - the ping loop below decides.
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await redis.ping()) === 'PONG') return;
    } catch {
      // Not usable yet; keep waiting.
    }
    await delay(50);
  }
  throw new Error('Redis did not become usable again after a simulated outage');
}

export type { CacheStats };
export { getCacheStats, resetCacheStats };

interface ApiOptions {
  token?: string;
  body?: unknown;
}

/** Minimal typed JSON client against the test server. */
export async function api<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: ApiOptions = {}
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: (text.length > 0 ? JSON.parse(text) : null) as T,
    headers: response.headers,
  };
}

export interface TestUser {
  id: number;
  email: string;
  token: string;
}

let userCounter = 0;
const runId = Date.now().toString(36);

/** Registers a fresh CUSTOMER via the public API and returns a live token. */
export async function registerUser(name = 'Test User'): Promise<TestUser> {
  const email = `${TEST_PREFIX}${runId}.${++userCounter}@example.com`;
  const registration = await api('POST', '/api/auth/register', {
    body: { name, email, password: TEST_PASSWORD },
  });
  if (registration.status !== 201) {
    throw new Error(
      `register failed: ${registration.status} ${JSON.stringify(registration.body)}`
    );
  }

  const login = await api<{ token: string; user: { id: number } }>(
    'POST',
    '/api/auth/login',
    { body: { email, password: TEST_PASSWORD } }
  );
  if (login.status !== 200) {
    throw new Error(`login failed: ${login.status}`);
  }

  return { id: login.body.user.id, email, token: login.body.token };
}

/**
 * Registers a user, promotes them to ADMIN directly in the database (there is
 * no role-management API yet), then logs in again so the JWT carries the role.
 */
export async function registerAdmin(): Promise<TestUser> {
  const user = await registerUser('Test Admin');
  await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });

  const login = await api<{ token: string }>('POST', '/api/auth/login', {
    body: { email: user.email, password: TEST_PASSWORD },
  });
  if (login.status !== 200) {
    throw new Error(`admin login failed: ${login.status}`);
  }
  return { ...user, token: login.body.token };
}

let productCounter = 0;

export interface TestProduct {
  id: number;
  name: string;
  sku: string;
  price: string;
}

/**
 * Creates a product through the admin API, then sets its stock through Prisma
 * (inventory is not exposed over HTTP yet - it arrives with a later milestone).
 */
export async function createProduct(
  adminToken: string,
  options: { price: number; stock: number; category?: string; isActive?: boolean }
): Promise<TestProduct> {
  const n = ++productCounter;
  const name = `Test Product ${runId}-${n}`;
  const sku = `${SKU_PREFIX}${runId}-${n}`;

  const created = await api<{ product: { id: number; price: string } }>(
    'POST',
    '/api/products',
    {
      token: adminToken,
      body: {
        name,
        description: `Integration test product ${n}`,
        price: options.price,
        sku,
        category: options.category ?? 'test-category',
      },
    }
  );
  if (created.status !== 201) {
    throw new Error(
      `product create failed: ${created.status} ${JSON.stringify(created.body)}`
    );
  }

  const productId = created.body.product.id;
  await prisma.inventory.upsert({
    where: { productId },
    update: { quantity: options.stock },
    create: { productId, quantity: options.stock },
  });

  if (options.isActive === false) {
    await prisma.product.update({
      where: { id: productId },
      data: { isActive: false },
    });
  }

  return { id: productId, name, sku, price: created.body.product.price };
}

/** Reads a product's current stock directly from the database. */
export async function getStock(productId: number): Promise<number | null> {
  const row = await prisma.inventory.findUnique({ where: { productId } });
  return row ? row.quantity : null;
}

/** Current number of cart lines for a user. */
export async function getCartItemCount(userId: number): Promise<number> {
  return prisma.cartItem.count({ where: { cart: { userId } } });
}

/** Number of orders belonging to a user. */
export async function getOrderCount(userId: number): Promise<number> {
  return prisma.order.count({ where: { userId } });
}

/**
 * Removes every row this suite could have created (matched by prefix), in
 * FK-safe order. Idempotent: safe to call before and after a run.
 *
 * Day 6: also sweeps the Redis cache/counter keys. Deleting rows directly
 * through Prisma bypasses the API's cache invalidation, so a leftover cached
 * product list could otherwise leak into the next test file.
 */
export async function cleanupTestData(): Promise<void> {
  await clearRedisTestState();

  const userIds = (
    await prisma.user.findMany({
      where: { email: { startsWith: TEST_PREFIX } },
      select: { id: true },
    })
  ).map((u) => u.id);

  const productIds = (
    await prisma.product.findMany({
      where: { sku: { startsWith: SKU_PREFIX } },
      select: { id: true },
    })
  ).map((p) => p.id);

  if (userIds.length > 0) {
    const orderIds = (
      await prisma.order.findMany({
        where: { userId: { in: userIds } },
        select: { id: true },
      })
    ).map((o) => o.id);

    if (orderIds.length > 0) {
      // Ordering matters: notifications/payments reference orders, order_items
      // reference products with ON DELETE RESTRICT, so orders are removed first.
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    await prisma.cartItem.deleteMany({ where: { cart: { userId: { in: userIds } } } });
    await prisma.cart.deleteMany({ where: { userId: { in: userIds } } });
  }

  if (productIds.length > 0) {
    await prisma.inventory.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.cartItem.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  }

  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}
