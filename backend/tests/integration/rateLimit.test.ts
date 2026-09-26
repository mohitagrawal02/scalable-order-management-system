/**
 * Login rate limiting integration tests (Day 6).
 *
 * Run against the real Express app + real MySQL + real Redis.
 *
 * Scenario map (numbering from the Day-6 brief):
 *   12    requests below the limit behave normally
 *   13    requests above the limit are rejected with 429
 *   14    the counter really is TTL-based (the window resets)
 *   15    concurrent requests cannot bypass the limit (atomic INCR)
 *   16    successful logins still work below the limit
 *   17    429 responses use the existing error envelope
 *   +     the limit is per (IP, account), and fails OPEN when Redis is down
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import { config } from '../../src/config';
import { redis } from '../../src/infrastructure/redis';
import { loginRateLimitKey } from '../../src/modules/auth/auth.rateLimit';
import {
  api,
  clearRedisTestState,
  cleanupTestData,
  getRedisEntry,
  isRedisAvailable,
  disconnectRedisForTest,
  reconnectRedisForTest,
  registerUser,
  requireRedis,
  scanRedisKeys,
  startTestServer,
  stopTestServer,
  TEST_PASSWORD,
  TestUser,
} from './helpers';

const LIMIT = config.rateLimit.login.maxAttempts;
const WINDOW_SECONDS = config.rateLimit.login.windowSeconds;

const RUN = Date.now().toString(36);
let emailCounter = 0;

/** A syntactically valid address that is guaranteed NOT to be registered. */
function freshUnknownEmail(): string {
  emailCounter += 1;
  return `day6rate.${RUN}.${emailCounter}@example.com`;
}

interface LoginBody {
  token?: string;
  user?: { id: number; email: string };
  error?: { status: number; message: string };
}

function loginAs(email: string, password: string) {
  return api<LoginBody>('POST', '/api/auth/login', { body: { email, password } });
}

describe('Login rate limiting (Day 6)', () => {
  let user: TestUser;

  before(async () => {
    await startTestServer();
    await requireRedis();
    await cleanupTestData();
    user = await registerUser('Rate Limit User');
  });

  after(async () => {
    try {
      await clearRedisTestState();
      await cleanupTestData();
    } finally {
      await stopTestServer();
    }
  });

  beforeEach(async () => {
    await clearRedisTestState();
  });

  it(`${12}: allows attempts below the limit and reports the remaining budget`, async () => {
    const email = freshUnknownEmail();
    const remaining: string[] = [];

    for (let attempt = 1; attempt <= LIMIT - 1; attempt += 1) {
      const res = await loginAs(email, 'definitely-the-wrong-password');
      assert.equal(res.status, 401, `attempt ${attempt} must be a normal auth failure`);
      assert.equal(res.headers.get('x-ratelimit-limit'), String(LIMIT));
      remaining.push(res.headers.get('x-ratelimit-remaining') ?? '');
    }

    assert.deepEqual(
      remaining,
      Array.from({ length: LIMIT - 1 }, (_, index) => String(LIMIT - 1 - index)),
      'the remaining budget must count down'
    );

    // The counter exists and carries a TTL within the configured window.
    const keys = await scanRedisKeys('rate-limit:login:*');
    assert.equal(keys.length, 1, 'exactly one counter for one (IP, account) pair');
    const entry = await getRedisEntry(keys[0]!);
    assert.ok(entry);
    assert.equal(entry.value, String(LIMIT - 1));
    assert.ok(entry.ttlSeconds > 0 && entry.ttlSeconds <= WINDOW_SECONDS);
  });

  it(`${13}: rejects the request past the limit with HTTP 429`, async () => {
    const email = freshUnknownEmail();

    for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
      const allowed = await loginAs(email, 'definitely-the-wrong-password');
      assert.equal(allowed.status, 401, `attempt ${attempt} is still within the limit`);
    }

    const blocked = await loginAs(email, 'definitely-the-wrong-password');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error?.status, 429);
    assert.equal(blocked.headers.get('x-ratelimit-limit'), String(LIMIT));
    assert.equal(blocked.headers.get('x-ratelimit-remaining'), '0');

    const retryAfter = Number(blocked.headers.get('retry-after'));
    assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, 'Retry-After must be present');
    assert.ok(retryAfter <= WINDOW_SECONDS, `Retry-After (${retryAfter}) within the window`);

    // Rejected attempts keep counting, so hammering cannot reset the window.
    const keys = await scanRedisKeys('rate-limit:login:*');
    assert.equal(keys.length, 1);
    const entry = await getRedisEntry(keys[0]!);
    assert.ok(entry);
    assert.ok(
      Number(entry.value) >= LIMIT,
      `rejected attempts are still counted (value=${entry.value})`
    );
  });

  it(`${16}: a successful login below the limit still returns a usable token`, async () => {
    const res = await loginAs(user.email, TEST_PASSWORD);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.token, 'string');
    assert.equal(res.body.user?.email, user.email);

    const me = await api<{ user: { id: number; email: string } }>('GET', '/api/auth/me', {
      token: res.body.token,
    });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, user.id);
  });

  it('the limit is scoped per (IP, account): one locked account does not lock another', async () => {
    // Exhaust the window of a dedicated account with bad passwords.
    for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
      const res = await loginAs(user.email, 'wrong-password');
      assert.equal(res.status, 401);
    }

    // Same account, CORRECT password: still refused - the limiter runs before
    // the credential check, which is exactly the point of a rate limit.
    const blockedEvenWithCorrectPassword = await loginAs(user.email, TEST_PASSWORD);
    assert.equal(blockedEvenWithCorrectPassword.status, 429);

    // A different account from the same IP is untouched.
    const other = await registerUser('Other Rate Limit User');
    const otherLogin = await loginAs(other.email, TEST_PASSWORD);
    assert.equal(otherLogin.status, 200, 'a different account has its own counter');
    assert.ok(otherLogin.body.token);
  });

  it(`${14}: the counter is TTL-based - the window really resets`, async () => {
    const email = freshUnknownEmail();

    const first = await loginAs(email, 'wrong-password');
    assert.equal(first.status, 401);

    const keys = await scanRedisKeys('rate-limit:login:*');
    assert.equal(keys.length, 1);
    const key = keys[0]!;
    const entry = await getRedisEntry(key);
    assert.ok(entry);
    assert.equal(entry.value, '1');
    assert.ok(
      entry.ttlSeconds > 0 && entry.ttlSeconds <= WINDOW_SECONDS,
      `the counter must expire within the window (got TTL ${entry.ttlSeconds})`
    );

    // Shorten the remaining TTL instead of waiting the full window.
    await redis.expire(key, 1);
    await delay(1_200);
    assert.equal(await getRedisEntry(key), null, 'the counter expired');

    // A brand new window: the same account is allowed again.
    const afterExpiry = await loginAs(email, 'wrong-password');
    assert.equal(afterExpiry.status, 401, 'expiry must re-open the window (401, not 429)');
  });


  it('the Redis key is a hashed (IP, account) identifier - no raw emails or IPs stored', async () => {
    const email = freshUnknownEmail();
    await loginAs(email, 'wrong-password');

    const keys = await scanRedisKeys('rate-limit:login:*');
    assert.equal(keys.length, 1);
    const key = keys[0]!;
    assert.match(key, /^rate-limit:login:[0-9a-f]{32}$/);
    assert.equal(key.includes(email), false, 'the raw email must not appear in Redis keys');
    assert.equal(key.includes('@'), false);

    // The identifier is deterministic and case-insensitive on the email, and
    // it separates different IPs.
    assert.equal(loginRateLimitKey('127.0.0.1', 'User@Example.com'), loginRateLimitKey('127.0.0.1', 'user@example.com'));
    assert.notEqual(loginRateLimitKey('127.0.0.1', 'user@example.com'), loginRateLimitKey('10.0.0.9', 'user@example.com'));
  });

  it(`${15}: concurrent requests cannot bypass the limit (atomic INCR, no race)`, async () => {
    const email = freshUnknownEmail();
    const concurrentAttempts = LIMIT * 4;

    // Fire all attempts at once. A read-modify-write implementation ("GET the
    // counter, decide, then SET it") would let far more than LIMIT through,
    // because every request would read the same starting value.
    const responses = await Promise.all(
      Array.from({ length: concurrentAttempts }, () => loginAs(email, 'wrong-password'))
    );

    const allowed = responses.filter((res) => res.status === 401).length;
    const rejected = responses.filter((res) => res.status === 429).length;

    assert.equal(
      allowed,
      LIMIT,
      `exactly ${LIMIT} of ${concurrentAttempts} concurrent attempts may pass`
    );
    assert.equal(rejected, concurrentAttempts - LIMIT);
    assert.equal(responses.some((res) => res.status >= 500), false, 'no 5xx under contention');

    // The counter reflects every attempt: nothing was lost to a race.
    const keys = await scanRedisKeys('rate-limit:login:*');
    assert.equal(keys.length, 1);
    const entry = await getRedisEntry(keys[0]!);
    assert.ok(entry);
    assert.equal(Number(entry.value), concurrentAttempts);
  });

  it(`${17}: 429 responses use the existing error envelope and leak no Redis internals`, async () => {
    const email = freshUnknownEmail();
    for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
      await loginAs(email, 'wrong-password');
    }

    const blocked = await loginAs(email, 'wrong-password');
    assert.equal(blocked.status, 429);
    assert.deepEqual(Object.keys(blocked.body), ['error'], 'same envelope as every other error');
    assert.deepEqual(Object.keys(blocked.body.error!), ['status', 'message']);
    assert.equal(blocked.body.error!.status, 429);
    assert.equal(typeof blocked.body.error!.message, 'string');

    const message = blocked.body.error!.message.toLowerCase();
    for (const leaked of ['redis', 'rate-limit:', 'incr', 'lua', 'eval', 'ttl']) {
      assert.equal(
        message.includes(leaked),
        false,
        `the client must not learn about "${leaked}" (got: ${message})`
      );
    }
  });

  it('fails OPEN when Redis is unavailable: logins keep working while degraded', async () => {
    const email = freshUnknownEmail();
    await disconnectRedisForTest();
    assert.equal(isRedisAvailable(), false);
    try {
      // Wrong password: still a normal 401 (the limiter cannot count, so it
      // allows the request through instead of locking every client out).
      const wrong = await loginAs(email, 'wrong-password');
      assert.equal(wrong.status, 401, 'no 429/500 during a Redis outage');

      // And a legitimate login still works end to end.
      const good = await loginAs(user.email, TEST_PASSWORD);
      assert.equal(good.status, 200, 'authentication must not depend on Redis');
      assert.ok(good.body.token);
    } finally {
      await reconnectRedisForTest();
    }

    assert.equal(isRedisAvailable(), true);
    // Enforcement resumes once Redis is back.
    const counted = await loginAs(freshUnknownEmail(), 'wrong-password');
    assert.equal(counted.status, 401);
    assert.ok((await scanRedisKeys('rate-limit:login:*')).length > 0, 'counters are written again');
  });
});

