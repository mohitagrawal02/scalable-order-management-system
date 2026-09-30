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
import {
  brokerSummary,
  closeKafkaAdmin,
  disconnectProducer,
  dispatchOutbox,
  envelopeHeaders,
  kafkaEnabled,
  pingKafka,
  type ConsumedEvent,
  type EventEnvelope,
  type OutboxDispatchResult,
  type PublishInput,
  type Publisher,
} from '../../src/infrastructure/kafka';
import { handleDomainEvent } from '../../src/modules/notifications/notification.consumer';

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
  // Day 7: release the Kafka sockets too. An open producer/admin connection
  // would keep the event loop alive after the last assertion, so the runner
  // would sit waiting for a process that has nothing left to do.
  await disconnectProducer();
  await closeKafkaAdmin().catch(() => undefined);
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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Kafka test utilities (Day 7)
 * ─────────────────────────────────────────────────────────────────────────────
 * The Day-7 suites must NOT need a running broker. Two seams already exist in
 * the production code for exactly this and are used here instead of mocking:
 *
 *   - `dispatchOutbox({ publisher })` accepts an injected transport, so the
 *     whole PENDING → PUBLISHED path can be exercised with a fake;
 *   - `handleDomainEvent()` is exported from the notification consumer so the
 *     consumer side can be invoked with the same code path the worker uses.
 *
 * What is NOT simulated is the broker round-trip itself - that is what the live
 * `kafka.test.ts` suite (guarded by `requireKafka`) is for.
 */

/** Transport that records what the dispatcher would have sent. Never fails. */
export class RecordingPublisher implements Publisher {
  readonly published: PublishInput[] = [];

  /** Set to make the next publish(s) throw - used by the failure paths. */
  failWith: string | null = null;

  async publish(input: PublishInput): Promise<void> {
    if (this.failWith) throw new Error(this.failWith);
    this.published.push(input);
  }
}

/**
 * One dispatch round against a recording transport.
 *
 * Returns both so a test can assert the transport AND the database row.
 * The dispatcher refuses to run concurrently with itself (`inFlight`), and a
 * payment's fire-and-forget dispatch can hold that guard for as long as a real
 * broker round-trip takes. So when a round reports `skipped` this waits and
 * tries again - otherwise the caller would assert against a round that never
 * ran.
 */
export async function dispatchWithRecording(
  options: { limit?: number; failWith?: string; retries?: number } = {}
): Promise<{ publisher: RecordingPublisher; result: OutboxDispatchResult }> {
  const publisher = new RecordingPublisher();
  if (options.failWith) publisher.failWith = options.failWith;

  const retries = options.retries ?? 5;
  let result = await dispatchOutbox({ publisher, limit: options.limit });
  for (let attempt = 0; result.skipped && attempt < retries; attempt += 1) {
    await delay(100);
    result = await dispatchOutbox({ publisher, limit: options.limit });
  }
  return { publisher, result };
}

/** Rebuilds the `ConsumedEvent` shape from a stored outbox row. */
function rowToConsumedEvent(row: {
  id: number;
  topic: string;
  partitionKey: string;
  envelope: unknown;
}): ConsumedEvent {
  const envelope = row.envelope as EventEnvelope;
  return {
    topic: row.topic,
    partition: 0,
    // A synthetic offset: the test never reads it, but a handler might, so the
    // field must exist rather than being `undefined`.
    offset: String(row.id),
    key: row.partitionKey,
    headers: envelopeHeaders(envelope),
    envelope,
    attempt: 1,
  };
}

/**
 * Drives the ASYNC half of a payment to completion, in-process.
 *
 * Day 5 asserted "pay → notification exists" because both happened in one
 * transaction. Day 7 splits them: the payment commits an outbox row, the
 * dispatcher publishes it, and the notification consumer writes the
 * notification. This helper plays the worker's two stages so the assertion can
 * stay a single call:
 *
 *   1. `dispatchOutbox` against a recording transport (publishes whatever is
 *      still PENDING - a no-op for rows a real dispatcher already took);
 *   2. feed every outbox row for these orders to `handleDomainEvent`.
 *
 * Step 2 reads the row regardless of its status on purpose: step 1 is only
 * there to exercise the dispatcher, while the CONSUMER must not depend on how
 * the row got published (that independence is the point of the outbox).
 * Deliveries are idempotent, so calling this twice creates one notification.
 *
 * @param orderIds orders whose events should be delivered (matched on the
 *        partition key `order-<id>`, which is what keeps them ordered).
 * @returns how many outbox rows were handed to the consumer.
 */
export async function deliverOutboxEvents(orderIds: number[]): Promise<number> {
  await dispatchWithRecording().catch(() => undefined);

  const rows = await prisma.outboxEvent.findMany({
    where: { partitionKey: { in: orderIds.map((id) => `order-${id}`) } },
    orderBy: { id: 'asc' },
  });

  for (const row of rows) {
    await handleDomainEvent(rowToConsumedEvent(row));
  }
  return rows.length;
}

/** Removes specific outbox rows (and their dedup markers) by event id. */
export async function deleteOutboxRows(eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;
  await prisma.processedEvent.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.outboxEvent.deleteMany({ where: { eventId: { in: eventIds } } });
}

/**
 * Throws when Kafka is not usable. Called by the live suite's `before()` hook -
 * a broker outage must FAIL those tests loudly, not skip them (the suite exists
 * to verify real broker behaviour). Mirrors `requireRedis()`.
 */
export async function requireKafka(timeoutMs = 15_000): Promise<void> {
  if (!kafkaEnabled()) {
    throw new Error(
      'Kafka is disabled (KAFKA_ENABLED=false). Set KAFKA_ENABLED=true to run the live Kafka suite.'
    );
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingKafka()) return;
    await delay(250);
  }
  throw new Error(
    `Kafka is required for this test suite but the broker did not answer within ${timeoutMs}ms ` +
      `(${brokerSummary()}). Start it with \`..\\infra\\kafka\\kafka.ps1 -Action start\`.`
  );
}

interface ApiOptions {
  token?: string;
  body?: unknown;
  /**
   * Extra request headers.
   *
   * Added for Day 8 so a test can send its own `X-Request-ID` and verify the
   * server reuses it. Applied BEFORE the derived ones, so `token` and
   * `Content-Type` still win over anything set here.
   */
  headers?: Record<string, string>;
}

/** Minimal typed JSON client against the test server. */
export async function api<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: ApiOptions = {}
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
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
      // Day 7: outbox rows and their dedup markers are tied to these orders by
      // the partition key (`order-<id>`). They must be swept together - an
      // outbox row left behind for a deleted order would still be dispatched,
      // and a `processed_events` marker left behind is pure dead weight.
      const outboxRows = await prisma.outboxEvent.findMany({
        where: { partitionKey: { in: orderIds.map((id) => `order-${id}`) } },
        select: { eventId: true },
      });
      await deleteOutboxRows(outboxRows.map((row) => row.eventId));

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
