/**
 * Product catalog caching integration tests (Day 6).
 *
 * Run against the real Express app + real MySQL + real Redis (see helpers.ts).
 * Redis is REQUIRED here: these tests verify actual cache behaviour (keys, TTLs,
 * hit/miss counters, invalidation, degradation), not a mocked substitute.
 *
 * Scenario map (numbering from the Day-6 brief):
 *   1/2/3  miss -> hit, cached payload equality, staleness proof
 *   4      deterministic cache keys (query order/filters/page)
 *   5      detail caching
 *   6      update invalidation
 *   7      delete invalidation
 *   8      create does not leave a stale list
 *   9      TTL expiry
 *   10     Redis outage -> MySQL fallback
 *   11     Redis SET failure -> response still succeeds
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import { prisma } from '../../src/config/prisma';
import { redis, redisCommands } from '../../src/infrastructure/redis';
import {
  PRODUCT_CACHE_TTL_SECONDS,
  getListCacheVersion,
  productDetailCacheKey,
  productListCacheKey,
} from '../../src/modules/products/product.cache';
import {
  api,
  clearRedisTestState,
  cleanupTestData,
  createProduct,
  disconnectRedisForTest,
  getCacheStats,
  getRedisEntry,
  isRedisAvailable,
  reconnectRedisForTest,
  registerAdmin,
  requireRedis,
  scanRedisKeys,
  startTestServer,
  stopTestServer,
  TestProduct,
} from './helpers';

interface ProductPayload {
  id: number;
  name: string;
  price: string;
  sku: string;
  category: string;
}

interface ListBody {
  data: ProductPayload[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

interface DetailBody {
  product: ProductPayload;
}

/** Unique per run so parallel/previous runs can never share a cache key. */
const RUN = Date.now().toString(36);
let categoryCounter = 0;

function freshCategory(): string {
  categoryCounter += 1;
  return `day6-cache-${RUN}-${categoryCounter}`;
}

describe('Product cache (Day 6)', () => {
  let adminToken: string;

  const listUrl = (category: string, extra = ''): string =>
    `/api/products?category=${encodeURIComponent(category)}${extra}`;

  const createInCategory = (category: string, price: number): Promise<TestProduct> =>
    createProduct(adminToken, { price, stock: 10, category });

  before(async () => {
    await startTestServer();
    await requireRedis();
    await cleanupTestData();

    const admin = await registerAdmin();
    adminToken = admin.token;
  });

  after(async () => {
    try {
      await clearRedisTestState();
      await cleanupTestData();
    } finally {
      // Always tear the server + sockets down, even if a test left Redis in a
      // degraded state (a lingering handle would hang the test process).
      await stopTestServer();
    }
  });

  // Every test starts from a cold cache so hit/miss deltas are unambiguous.
  beforeEach(async () => {
    await clearRedisTestState();
  });

  it('1+2: first listing is a cache MISS, second is a HIT with a byte-identical payload', async () => {
    const category = freshCategory();
    const product = await createInCategory(category, 25.5);

    const missesBefore = getCacheStats().misses;
    const first = await api<ListBody>('GET', listUrl(category));
    assert.equal(first.status, 200);
    assert.equal(first.body.data.length, 1);
    assert.ok(
      getCacheStats().misses > missesBefore,
      'the first request must go to MySQL (cache miss)'
    );

    // The payload is now in Redis, under a deterministic versioned key, with a
    // finite TTL.
    const version = await getListCacheVersion();
    const key = productListCacheKey(version, { page: 1, limit: 20, category });
    const entry = await getRedisEntry(key);
    assert.ok(entry, `expected ${key} to be cached`);
    assert.ok(
      entry.ttlSeconds > 0 && entry.ttlSeconds <= PRODUCT_CACHE_TTL_SECONDS,
      `TTL must be within (0, ${PRODUCT_CACHE_TTL_SECONDS}], got ${entry.ttlSeconds}`
    );
    assert.equal(entry.value.includes(product.sku), true);

    const hitsBefore = getCacheStats().hits;
    const missesBeforeSecond = getCacheStats().misses;
    const second = await api<ListBody>('GET', listUrl(category));

    assert.equal(second.status, 200);
    assert.equal(
      getCacheStats().misses,
      missesBeforeSecond,
      'the second request must not touch MySQL (cache hit)'
    );
    assert.ok(getCacheStats().hits > hitsBefore, 'a cache hit must be recorded');
    assert.deepEqual(second.body, first.body, 'cached response equals the MySQL response');
  });

  it('3: serves the cached copy until an API write invalidates it (staleness is real)', async () => {
    const category = freshCategory();
    const product = await createInCategory(category, 10.0);

    const warm = await api<ListBody>('GET', listUrl(category));
    assert.equal(warm.body.data[0]!.name, product.name);

    // Change the row BEHIND the cache's back (direct SQL, no invalidation).
    await prisma.product.update({
      where: { id: product.id },
      data: { name: 'Renamed Behind The Cache' },
    });

    const stillStale = await api<ListBody>('GET', listUrl(category));
    assert.equal(
      stillStale.body.data[0]!.name,
      product.name,
      'the stale cached copy answered - proof the response came from Redis'
    );

    // A real write through the API must invalidate immediately.
    const patched = await api('PATCH', `/api/products/${product.id}`, {
      token: adminToken,
      body: { name: 'Renamed Through The Api' },
    });
    assert.equal(patched.status, 200);

    const fresh = await api<ListBody>('GET', listUrl(category));
    assert.equal(fresh.body.data[0]!.name, 'Renamed Through The Api');
  });


  it('4: builds one deterministic key per query meaning (order/filters/page)', async () => {
    const category = freshCategory();
    await createInCategory(category, 8.0);
    await createInCategory(category, 9.0);

    const page1 = await api<ListBody>('GET', listUrl(category, '&page=1&limit=1'));
    assert.equal(page1.body.data.length, 1);
    const page2 = await api<ListBody>('GET', listUrl(category, '&page=2&limit=1'));
    assert.equal(page2.body.data.length, 1);
    assert.notEqual(page1.body.data[0]!.id, page2.body.data[0]!.id, 'different pages differ');

    // Two page keys so far: same filters, different `page`.
    let keys = await scanRedisKeys('product:list:*');
    assert.equal(keys.length, 2, `expected 2 list keys, got: ${keys.join(', ')}`);

    // Same meaning, different query-string order -> SAME key (a hit).
    const missesBefore = getCacheStats().misses;
    const reordered = await api<ListBody>(
      'GET',
      `/api/products?limit=1&page=1&category=${encodeURIComponent(category)}`
    );
    assert.deepEqual(reordered.body, page1.body);
    assert.equal(getCacheStats().misses, missesBefore, 'an equivalent query must be a cache hit');
    keys = await scanRedisKeys('product:list:*');
    assert.equal(keys.length, 2, 'no third key was created for an equivalent query');

    // A value the validator defaults (`limit=20`) collapses with the implicit
    // default: `?category=X` and `?category=X&page=1&limit=20` share one key.
    const implicit = await api<ListBody>('GET', listUrl(category));
    const explicit = await api<ListBody>('GET', listUrl(category, '&page=1&limit=20'));
    assert.deepEqual(explicit.body, implicit.body);
    keys = await scanRedisKeys('product:list:*');
    assert.equal(keys.length, 3, 'expected page1/limit1, page2/limit1 and page1/limit20');

    // The list namespace never collides with the detail namespace.
    assert.ok(keys.every((key) => key.startsWith('product:list:v')));
  });

  it('5: caches the product detail under product:<id>', async () => {
    const product = await createInCategory(freshCategory(), 12.0);

    const missesBefore = getCacheStats().misses;
    const first = await api<DetailBody>('GET', `/api/products/${product.id}`);
    assert.equal(first.status, 200);
    assert.equal(first.body.product.id, product.id);
    assert.ok(getCacheStats().misses > missesBefore, 'first detail request is a miss');

    const key = productDetailCacheKey(product.id);
    const entry = await getRedisEntry(key);
    assert.ok(entry, `expected ${key} to be cached`);
    assert.ok(entry.ttlSeconds > 0 && entry.ttlSeconds <= PRODUCT_CACHE_TTL_SECONDS);

    const hitsBefore = getCacheStats().hits;
    const missesBeforeHit = getCacheStats().misses;
    const second = await api<DetailBody>('GET', `/api/products/${product.id}`);
    assert.deepEqual(second.body, first.body);
    assert.equal(getCacheStats().misses, missesBeforeHit, 'second detail request is a hit');
    assert.ok(getCacheStats().hits > hitsBefore);
  });


  it('6: updating a product deletes its detail entry and retires list entries', async () => {
    const category = freshCategory();
    const product = await createInCategory(category, 30.0);

    await api<DetailBody>('GET', `/api/products/${product.id}`);
    await api<ListBody>('GET', listUrl(category));

    const versionBefore = await getListCacheVersion();
    const listKeysBefore = await scanRedisKeys('product:list:*');
    assert.equal(listKeysBefore.length, 1);
    assert.ok(await getRedisEntry(productDetailCacheKey(product.id)), 'detail warmed');

    const patched = await api('PATCH', `/api/products/${product.id}`, {
      token: adminToken,
      body: { price: 42.25 },
    });
    assert.equal(patched.status, 200);

    assert.equal(
      await getRedisEntry(productDetailCacheKey(product.id)),
      null,
      'the affected detail entry must be deleted'
    );
    assert.equal(await getListCacheVersion(), versionBefore + 1, 'the list namespace was bumped');
    assert.deepEqual(
      await scanRedisKeys('product:list:*'),
      listKeysBefore,
      'old list keys are not deleted (no KEYS/SCAN wildcard); they became unreachable and expire by TTL'
    );

    const fresh = await api<ListBody>('GET', listUrl(category));
    assert.equal(fresh.body.data[0]!.price, '42.25');
    assert.equal(fresh.body.pagination.total, 1);
  });

  it('7: deleting a product invalidates its caches', async () => {
    const category = freshCategory();
    const product = await createInCategory(category, 11.0);

    const before = await api<ListBody>('GET', listUrl(category));
    assert.equal(before.body.pagination.total, 1);
    await api<DetailBody>('GET', `/api/products/${product.id}`);
    const versionBefore = await getListCacheVersion();

    const deleted = await api('DELETE', `/api/products/${product.id}`, { token: adminToken });
    assert.equal(deleted.status, 204);

    assert.equal(
      await getRedisEntry(productDetailCacheKey(product.id)),
      null,
      'the deleted product must not stay cached'
    );
    assert.equal(await getListCacheVersion(), versionBefore + 1);

    const after = await api<ListBody>('GET', listUrl(category));
    assert.equal(after.body.data.length, 0);
    assert.equal(after.body.pagination.total, 0, 'the deleted product is gone from the list');
    assert.equal((await api('GET', `/api/products/${product.id}`)).status, 404);
  });

  it('8: creating a product never leaves a stale list cache', async () => {
    const category = freshCategory();
    await createInCategory(category, 5.0);

    const first = await api<ListBody>('GET', listUrl(category));
    assert.equal(first.body.pagination.total, 1);

    const added = await createInCategory(category, 6.0);
    const second = await api<ListBody>('GET', listUrl(category));

    assert.equal(second.body.pagination.total, 2);
    assert.equal(second.body.data.length, 2);
    assert.ok(second.body.data.some((row) => row.id === added.id));
  });


  it('9: an expired TTL causes a MISS (freshness is bounded by the TTL)', async () => {
    const product = await createInCategory(freshCategory(), 3.0);
    const key = productDetailCacheKey(product.id);

    await api<DetailBody>('GET', `/api/products/${product.id}`);
    assert.ok(await getRedisEntry(key), 'cached');

    // Expire the entry immediately instead of waiting 60 real seconds: same
    // effect, deterministic test runtime.
    await redis.expire(key, 1);
    await delay(1_200);
    assert.equal(await getRedisEntry(key), null, 'the entry expired');

    const missesBefore = getCacheStats().misses;
    const after = await api<DetailBody>('GET', `/api/products/${product.id}`);
    assert.equal(after.status, 200);
    assert.ok(getCacheStats().misses > missesBefore, 'expiry forced a fresh MySQL read');
    assert.ok(await getRedisEntry(key), 'and the fresh value was cached again');
  });

  it('10: falls back to MySQL when Redis is unavailable (never a 500)', async () => {
    const category = freshCategory();
    const product = await createInCategory(category, 17.0);

    await api<DetailBody>('GET', `/api/products/${product.id}`);
    await api<ListBody>('GET', listUrl(category));

    // Change the truth behind the cache so we can prove which layer answered.
    await prisma.product.update({ where: { id: product.id }, data: { price: '77.77' } });
    const errorsBefore = getCacheStats().errors;

    await disconnectRedisForTest();
    assert.equal(isRedisAvailable(), false, 'the simulated outage took effect');
    try {
      const detail = await api<DetailBody>('GET', `/api/products/${product.id}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.product.price, '77.77', 'MySQL answered, not the stale cache');

      const list = await api<ListBody>('GET', listUrl(category));
      assert.equal(list.status, 200);
      assert.equal(list.body.data[0]!.price, '77.77');

      assert.ok(
        getCacheStats().errors > errorsBefore,
        'the degradation must be visible as a cache error'
      );
    } finally {
      await reconnectRedisForTest();
    }

    assert.equal(isRedisAvailable(), true, 'Redis recovered without an app restart');

    // The entry written BEFORE the outage is still in Redis: a client outage is
    // not a cache flush. The API therefore resumes serving the (stale) cached
    // copy until TTL expiry or invalidation - the bound we accept by design.
    const hitsBefore = getCacheStats().hits;
    const healed = await api<DetailBody>('GET', `/api/products/${product.id}`);
    assert.equal(healed.status, 200);
    assert.equal(healed.body.product.price, '17.00');
    assert.ok(getCacheStats().hits > hitsBefore, 'the cache is being used again');
  });

  it('11: a Redis SET failure does not break a successful product response', async () => {
    const product = await createInCategory(freshCategory(), 21.0);
    const key = productDetailCacheKey(product.id);
    const setFailuresBefore = getCacheStats().setFailures;

    // Simulate an intermittent write-only failure at the command layer:
    // redisCommands.set is temporarily replaced by an implementation that rejects
    // (e.g. command timeout / OOM / broken pipe), proving that the cache layer
    // intercepts the error, logs it, increments stats.setFailures, and the caller
    // (product.service -> controller -> HTTP response) survives with HTTP 200.
    const realSet = redisCommands.set;
    redisCommands.set = async () => {
      throw new Error('Command timed out');
    };

    try {
      const startedAt = Date.now();
      const response = await api<DetailBody>('GET', `/api/products/${product.id}`);
      const elapsed = Date.now() - startedAt;

      assert.equal(response.status, 200, 'the API response still succeeds');
      assert.equal(response.body.product.id, product.id);
      assert.equal(await getRedisEntry(key), null, 'the write did not land in Redis');
      assert.ok(
        getCacheStats().setFailures > setFailuresBefore,
        'the write failure is recorded as setFailures'
      );
      assert.ok(
        elapsed < 1_000,
        `the request must not hang on a broken cache write (took ${elapsed}ms)`
      );
    } finally {
      redisCommands.set = realSet;
    }

    // Once the write path is restored, the next read warms the cache normally.
    await api<DetailBody>('GET', `/api/products/${product.id}`);
    assert.ok(await getRedisEntry(key), 'cache writes work again once restored');
  });
});

