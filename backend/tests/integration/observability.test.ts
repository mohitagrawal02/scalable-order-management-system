/**
 * Day 8: observability and graceful shutdown.
 *
 * These tests run against the real app (same harness as Day 4-7) plus a couple
 * of tiny in-process servers for the shutdown cases. What they deliberately do
 * NOT do is assert on the shape of things that cannot break: every assertion
 * here is either (a) the correlation a human needs to debug an incident, (b) a
 * cardinality property that would silently degrade the metrics, or (c) a failure
 * mode - a hung close, a wedged step, a dead dependency - that Day 7 handled by
 * exiting 0 and hoping.
 */
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Response } from 'express';
import { config } from '../../src/config';
import {
  consumerBackoffMs,
  getConsumerStats,
  getOutboxStats,
  outboxBackoffMs,
} from '../../src/infrastructure/kafka';
import {
  closeHttpServer,
  installShutdownHandlers,
  runShutdownSteps,
} from '../../src/infrastructure/lifecycle';
import {
  getLogger,
  resetLogger,
  runWithLogContext,
  setLogLevel,
  setLogSink,
  type LogEntry,
  type LogLevel,
} from '../../src/infrastructure/logging';
import { getHttpMetrics, resetHttpMetrics } from '../../src/infrastructure/metrics';
import { getRateLimitStats, resetRateLimitStats } from '../../src/infrastructure/redis';
import { resolveRequestId } from '../../src/middleware/requestContext';
import { requireMetricsToken } from '../../src/modules/metrics/metrics.controller';
import {
  api,
  createProduct,
  disconnectRedisForTest,
  reconnectRedisForTest,
  registerAdmin,
  requireRedis,
  startTestServer,
  stopTestServer,
} from './helpers';

/** Captures log lines instead of printing them; `restoreLogs()` puts them back. */
function captureLogs(level: LogLevel = 'debug'): LogEntry[] {
  const entries: LogEntry[] = [];
  setLogLevel(level);
  setLogSink((entry) => entries.push(entry));
  return entries;
}

function restoreLogs(): void {
  resetLogger();
}

/** Minimal stand-in for the two things `requireMetricsToken` touches. */
function stubResponse(): { res: Response; seen: { status?: number; body?: unknown } } {
  const seen: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      seen.status = code;
      return res;
    },
    json(body: unknown) {
      seen.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, seen };
}

describe('Request correlation (Day 8)', () => {
  before(async () => {
    await startTestServer();
  });

  after(async () => {
    restoreLogs();
    await stopTestServer();
  });

  it('answers every request with an X-Request-ID', async () => {
    const res = await api('GET', '/api/health/live');
    assert.equal(res.status, 200);
    const supplied = res.headers.get('x-request-id');
    assert.ok(supplied, 'present even on an endpoint with no handler logic at all');
    assert.match(supplied, /^[0-9a-f]{8}-[0-9a-f]{4}-4/, 'generated ids are UUIDv4');
  });

  it('reuses a caller-supplied id so a proxy can correlate, and rejects an unsafe one', async () => {
    const reused = await api('GET', '/api/health/live', {
      headers: { 'X-Request-ID': 'trace-abc-12345678' },
    });
    assert.equal(
      reused.headers.get('x-request-id'),
      'trace-abc-12345678',
      'an id the caller already generated is kept, not replaced'
    );

    const unsafe = await api('GET', '/api/health/live', {
      headers: { 'X-Request-ID': 'short' },
    });
    const replacement = unsafe.headers.get('x-request-id');
    assert.ok(replacement && replacement !== 'short', 'too short → replaced with a fresh id');
    assert.match(replacement!, /^[A-Za-z0-9._-]{8,64}$/);

    // The unit rule behind both cases: bounded length, bounded charset, and
    // never a value that could break out of a log line or a header.
    assert.equal(resolveRequestId('trace-abc-12345678'), 'trace-abc-12345678');
    assert.ok(resolveRequestId('a'.repeat(200)).length <= 64);
    assert.equal(resolveRequestId('has spaces\nand newlines').includes('\n'), false);
    assert.ok(resolveRequestId(undefined).length > 0);
  });

  it('writes exactly one access-log line per request, carrying id, route pattern and duration', async () => {
    const logs = captureLogs('info');
    try {
      const requestId = `access-${Date.now()}`;
      const res = await api('GET', '/api/health/ready?verbose=true&token=sup3r-secret-value', {
        headers: { 'X-Request-ID': requestId },
      });
      assert.equal(res.status, 200);

      const line = logs.find((entry) => entry.message === 'request completed');
      assert.ok(line, 'the request produced an access log line');
      assert.equal(logs.filter((entry) => entry.message === 'request completed').length, 1);
      assert.equal(line!.requestId, requestId, 'correlates with what the client was handed');
      assert.equal(line!.method, 'GET');
      assert.equal(line!.route, '/api/health/ready', 'route is the matched pattern');
      assert.equal(line!.path, '/api/health/ready', 'path carries no query string');
      assert.equal(line!.status, 200);
      assert.equal(typeof line!.durationMs, 'number');
      assert.ok((line!.durationMs as number) >= 0);
      assert.equal(line!.service, config.service, 'says which deployable wrote it');
      assert.equal(typeof line!.pid, 'number');

      // Query KEYS are logged (useful for debugging); VALUES are not: a token
      // that a client put in a query string must not be copied into a log store.
      assert.ok(Array.isArray(line!.queryKeys) && line!.queryKeys.includes('verbose'));
      const serialized = JSON.stringify(line);
      assert.equal(serialized.includes('sup3r-secret-value'), false);
      assert.equal(serialized.includes('verbose'), true);
    } finally {
      restoreLogs();
    }
  });

  it('logs a client error at warn and nothing else, and labels an unknown path "unmatched"', async () => {
    const logs = captureLogs('debug');
    try {
      await api('GET', '/api/cart/items'); // no token → 401, client fault
      const warned = logs.filter((entry) => entry.message === 'request rejected');
      assert.equal(warned.length, 1, 'one warn line, not an error line as well');
      assert.equal(warned[0].level, 'warn');
      assert.equal(warned[0].status, 401);
      assert.equal(
        warned[0].route,
        '/api/cart/items',
        'the route label survives Express resetting req.baseUrl while unwinding'
      );
      assert.equal(
        logs.some((entry) => entry.module === 'http-error'),
        false,
        'a 4xx is never logged as a server error'
      );

      await api('GET', '/api/definitely-not-a-route');
      const rejected = logs.filter((entry) => entry.message === 'request rejected');
      assert.equal(rejected.length, 2);
      assert.equal(
        rejected[1].route,
        'unmatched',
        'an unmatched path shares ONE label instead of one per guessed URL'
      );
    } finally {
      restoreLogs();
    }
  });

  it('labels metrics by route pattern, so two product ids are still one series', async () => {
    resetHttpMetrics();
    const admin = await registerAdmin();
    const first = await createProduct(admin.token, { price: 10.0, stock: 5 });
    const second = await createProduct(admin.token, { price: 11.0, stock: 5 });

    for (const id of [first.id, second.id, first.id]) {
      await api('GET', `/api/products/${id}`);
    }

    const metrics = getHttpMetrics();
    const productRoute = metrics.routes.find((entry) => entry.route === '/api/products/:id');
    assert.ok(productRoute, 'the three calls collapsed onto the declared pattern');
    assert.equal(productRoute!.count, 3);
    assert.equal(productRoute!.method, 'GET');

    // The point of the whole exercise: no label may contain a concrete id,
    // because one label per id is how a metrics registry runs out of memory.
    const leaking = metrics.routes.filter((entry) => /\/\d/.test(entry.route));
    assert.deepEqual(leaking, [], `no raw ids in labels: ${JSON.stringify(leaking)}`);
    assert.equal(metrics.routeCapReached, false);
    assert.equal(metrics.inFlight, 0, 'nothing is left in flight after they all finished');
  });

  it('reports every subsystem in one metrics document', async () => {
    resetHttpMetrics();
    resetRateLimitStats();

    await api('GET', '/api/products');
    await api('GET', '/api/health/live');
    await api('GET', '/api/health/ready');
    const res = await api<Record<string, any>>('GET', '/api/metrics');
    assert.equal(res.status, 200);

    assert.equal(res.body.service, config.service);
    assert.equal(typeof res.body.pid, 'number');

    // The metrics request itself is still IN FLIGHT while it answers, so the
    // three warm-up calls are the floor here - not four.
    assert.ok(res.body.http.requests.total >= 3, `total=${res.body.http.requests.total}`);
    assert.ok(res.body.http.inFlight >= 1, 'the in-flight gauge counts the request reading it');
    assert.ok(res.body.http.requests.byStatusClass['2xx'] >= 3);
    assert.equal(typeof res.body.http.durationMs.avg, 'number');
    assert.equal(
      res.body.http.durationMs.buckets.le2500,
      res.body.http.requests.total,
      'the top bucket is cumulative, so it must equal the total'
    );
    assert.ok(res.body.http.durationMs.buckets.le25 <= res.body.http.durationMs.buckets.le2500);
    assert.ok(
      res.body.http.routes.some((entry: any) => entry.route === '/api/health/ready'),
      'routes are labelled by pattern'
    );

    assert.equal(typeof res.body.cache.hits, 'number');
    assert.equal(typeof res.body.security.rateLimit.degraded, 'number');
    assert.equal(typeof res.body.events.kafkaEnabled, 'boolean');
    assert.equal(typeof res.body.events.outbox.published, 'number');
    assert.equal(typeof res.body.events.producer.publishFailures, 'number');
    assert.equal(typeof getConsumerStats().consumed, 'number');
    assert.equal(typeof getOutboxStats().dispatches, 'number');
  });
});

describe('Metrics access control (Day 8)', () => {
  it('is open when no token is configured, and gated when one is', () => {
    // The shipped default: no token, metrics readable locally.
    let passedThrough = false;
    requireMetricsToken(
      { headers: {} } as never,
      stubResponse().res,
      () => (passedThrough = true)
    );
    assert.equal(passedThrough, true, 'no token configured → no gate');

    const previous = (config.metrics as { token: string }).token;
    (config.metrics as { token: string }).token = 'a-test-metrics-token';
    try {
      const guard = (authorization?: string): { status?: number; next: boolean } => {
        const { res, seen } = stubResponse();
        let next = false;
        requireMetricsToken(
          { headers: authorization ? { authorization } : {} } as never,
          res,
          () => (next = true)
        );
        return { status: seen.status, next };
      };

      assert.deepEqual(guard(), { status: 401, next: false }, 'missing header → 401');
      assert.deepEqual(guard('Token a-test-metrics-token'), { status: 401, next: false });
      assert.deepEqual(guard('Bearer wrong-token'), { status: 401, next: false });
      assert.deepEqual(guard('Bearer  a-test-metrics-token'), {
        status: undefined,
        next: true,
      }, 'surrounding whitespace is tolerated, the scheme is not');
      assert.deepEqual(guard('Bearer a-test-metrics-token'), {
        status: undefined,
        next: true,
      });
    } finally {
      (config.metrics as { token: string }).token = previous;
    }
  });
});

describe('Liveness vs readiness (Day 8)', () => {
  before(async () => {
    await requireRedis();
    await startTestServer();
  });

  after(async () => {
    await reconnectRedisForTest().catch(() => undefined);
    await stopTestServer();
  });

  it('liveness reports the process only - it cannot be gated by a dependency', async () => {
    const res = await api<Record<string, unknown>>('GET', '/api/health/live');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'alive');
    assert.equal(res.body.database, undefined);
    assert.equal(res.body.redis, undefined);
    assert.equal(res.body.kafka, undefined);
    assert.deepEqual(
      Object.keys(res.body).sort(),
      ['service', 'status', 'timestamp', 'uptimeSeconds'],
      'no dependency is reachable from this handler, so none can make it fail'
    );
  });

  it('readiness still serves traffic with Redis down, and says what that costs', async () => {
    resetRateLimitStats();
    const beforeDegraded = getRateLimitStats().degraded;

    await disconnectRedisForTest();
    try {
      const live = await api<Record<string, unknown>>('GET', '/api/health/live');
      assert.equal(live.status, 200, 'a cache outage must never restart a pod');

      const ready = await api<Record<string, any>>('GET', '/api/health/ready');
      assert.equal(ready.status, 200, 'Redis is optional, so the instance stays in rotation');
      assert.equal(ready.body.status, 'ready');
      assert.equal(ready.body.checks.database.status, 'up');
      assert.equal(ready.body.checks.redis.status, 'down');
      assert.equal(ready.body.checks.redis.required, false);
      assert.notEqual(ready.body.checks.redis.impact, 'none');

      // The claim in one assertion: a real request still succeeds while Redis is
      // down, and the limiter says out loud that it failed OPEN.
      const login = await api<Record<string, any>>('POST', '/api/auth/login', {
        body: { email: 'nobody@observability.invalid', password: 'whatever123' },
      });
      assert.equal(login.status, 401, 'the login failed as a login, not as an outage');
      const after = getRateLimitStats();
      assert.ok(
        after.degraded > beforeDegraded,
        `the fail-open is counted (before=${beforeDegraded} after=${after.degraded})`
      );
      assert.ok(after.lastDegradedAt, 'and the moment it happened is recorded');
    } finally {
      await reconnectRedisForTest().catch(() => undefined);
    }

    const recovered = await api<Record<string, any>>('GET', '/api/health/ready');
    assert.equal(recovered.body.checks.redis.status, 'up', 'and the probe recovers on its own');
    assert.equal(recovered.body.checks.redis.impact, 'none');
  });

  it('readiness keeps its full report while MySQL is the only thing that can gate it', async () => {
    const res = await api<Record<string, any>>('GET', '/api/health/ready');
    assert.equal(res.status, 200);
    assert.equal(res.body.checks.database.required, true);
    assert.equal(res.body.checks.kafka.required, false, 'Kafka never gates an API instance');
    assert.equal(typeof res.body.checks.kafka.pendingEvents, 'number');
    assert.equal(res.body.impact, 'none');
  });
});

describe('Graceful shutdown sequence (Day 8)', () => {
  it('runs the steps in order and reports a clean result', async () => {
    const order: string[] = [];
    const result = await runShutdownSteps({
      role: 'test',
      steps: [
        {
          name: 'first',
          run: async () => {
            await delay(5);
            order.push('first');
          },
        },
        { name: 'second', run: () => void order.push('second') },
      ],
    });

    assert.deepEqual(order, ['first', 'second'], 'sequential: a close may depend on the one before');
    assert.deepEqual(result.completed, ['first', 'second']);
    assert.deepEqual(result.failed, []);
    assert.equal(result.exitCode, 0);
    assert.ok(result.durationMs >= 5);
  });

  it('records a failing step, continues past it, and returns exit code 1', async () => {
    const ran: string[] = [];
    const result = await runShutdownSteps({
      role: 'test',
      steps: [
        {
          name: 'close-redis',
          run: async () => {
            ran.push('close-redis');
            throw new Error('socket refuses to close');
          },
        },
        {
          name: 'disconnect-prisma',
          run: async () => {
            ran.push('disconnect-prisma');
          },
        },
      ],
    });

    assert.deepEqual(
      ran,
      ['close-redis', 'disconnect-prisma'],
      'a dependency that will not close must not skip the close behind it - that is when it matters'
    );
    assert.deepEqual(result.completed, ['disconnect-prisma']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].name, 'close-redis');
    assert.match(result.failed[0].error, /refuses to close/);
    assert.equal(result.exitCode, 1, 'an unclean shutdown must not report success');
  });

  it('ignores a second SIGTERM while a shutdown is already running', async () => {
    let runs = 0;
    const exits: number[] = [];
    const handle = installShutdownHandlers({
      role: 'test',
      steps: [
        {
          name: 'slow',
          run: async () => {
            runs += 1;
            await delay(30);
          },
        },
      ],
      exit: (code) => void exits.push(code),
    });

    try {
      process.emit('SIGTERM' as NodeJS.Signals);
      process.emit('SIGTERM' as NodeJS.Signals);
      await delay(80);
      assert.equal(runs, 1, 'the second signal did not close the same sockets twice');
      assert.deepEqual(exits, [0]);
    } finally {
      handle.removeListeners();
    }
  });

  it('trips the watchdog and names the step that hung', async () => {
    // A ref'd timer: the watchdog is unref'd (so a clean shutdown exits at once),
    // which means something must keep the loop alive here or the test would end
    // before the budget is spent - exactly as in production.
    const keepAlive = setTimeout(() => undefined, 300);
    const timeouts: { pendingStep: string }[] = [];
    try {
      void runShutdownSteps({
        role: 'test',
        timeoutMs: 20,
        steps: [{ name: 'stuck-on-a-broker-socket', run: () => new Promise<void>(() => undefined) }],
        onTimeout: (info) => void timeouts.push({ pendingStep: info.pendingStep }),
      });

      await delay(150);
      assert.equal(timeouts.length, 1, 'the budget was spent and said so');
      assert.equal(
        timeouts[0].pendingStep,
        'stuck-on-a-broker-socket',
        'naming the hung step is the whole difference from a silent exit(1)'
      );
    } finally {
      clearTimeout(keepAlive);
    }
  });
});

describe('HTTP drain (Day 8)', () => {
  async function listen(
    handler: http.RequestListener
  ): Promise<{ server: http.Server; base: string }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { server, base: `http://127.0.0.1:${port}` };
  }

  it('lets an in-flight request finish, then refuses new ones', async () => {
    const { server, base } = await listen((_req, res) => {
      const timer = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }, 80);
      timer.unref?.();
    });

    const inFlight = fetch(`${base}/slow`);
    await delay(20);

    const startedAt = Date.now();
    await closeHttpServer(server, 1_000);

    const response = await inFlight;
    assert.equal(response.status, 200, 'a request already running is answered, not cut off');
    assert.deepEqual(await response.json(), { ok: true });
    assert.ok(Date.now() - startedAt < 900, 'close returned as soon as it had drained');

    await assert.rejects(fetch(`${base}/fresh`), 'the port is closed to new work');
  });

  it('does not hang on an idle keep-alive connection', async () => {
    const { server, base } = await listen((_req, res) => void res.end('{}'));
    // The client holds this socket open between requests - the situation that
    // makes a bare `server.close()` wait forever.
    await (await fetch(`${base}/quick`)).text();

    const startedAt = Date.now();
    await closeHttpServer(server, 2_000);
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed < 1_000,
      `returned in ${elapsed}ms instead of waiting for the idle socket to expire`
    );
  });

  it('forces the remaining connections closed once the drain window expires', async () => {
    const { server, base } = await listen((_req, res) => {
      const timer = setTimeout(() => void res.end('{}'), 2_000);
      timer.unref?.();
    });

    const outcome = fetch(`${base}/hang`).then(
      () => 'resolved',
      () => 'rejected'
    );
    await delay(20);

    const startedAt = Date.now();
    await closeHttpServer(server, 60);
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 800, `forced the close in ${elapsed}ms instead of lingering`);
    assert.equal(await outcome, 'rejected', 'the request that overran the window was cut loose');
  });
});

describe('Retry backoff bounds (Day 8)', () => {
  /** Min/max over `runs` samples: jitter makes a single call meaningless. */
  function spread(fn: (attempt: number) => number, attempt: number, runs = 200): [number, number] {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < runs; i += 1) {
      const value = fn(attempt);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    return [min, max];
  }

  it('grows exponentially, respects the ceiling, and is jittered', () => {
    const base = config.kafka.outbox.retryBaseDelayMs;
    const max = config.kafka.outbox.retryMaxDelayMs;

    const first = spread(outboxBackoffMs, 1);
    assert.ok(first[0] >= base * 0.75 && first[1] <= base * 1.25, `attempt 1 = ${first}`);

    const fifth = spread(outboxBackoffMs, 5);
    assert.ok(fifth[0] > first[1], 'attempt 5 is strictly later than attempt 1');

    // The ceiling is what keeps a long outage from producing hour-long delays.
    const last = spread(outboxBackoffMs, 40);
    assert.ok(last[0] >= max * 0.75 && last[1] <= max * 1.25, `capped attempt = ${last}`);

    // Jitter must actually vary, or a fleet would retry in lockstep.
    assert.ok(new Set(Array.from({ length: 40 }, () => outboxBackoffMs(3))).size > 1);
  });

  it('keeps the consumer retry budget bounded no matter the attempt number', () => {
    const ceiling = config.kafka.consumerRetryMaxDelayMs * 1.25;
    for (const attempt of [1, 2, 10, 1_000, 100_000]) {
      const [min, max] = spread(consumerBackoffMs, attempt);
      assert.ok(min > 0, `attempt ${attempt} must still wait, not spin`);
      assert.ok(max <= ceiling, `attempt ${attempt} exceeded the ceiling: ${max} > ${ceiling}`);
    }
  });
});

describe('Structured logger (Day 8)', () => {
  it('redacts at any depth, filters by level, and carries the async context', () => {
    const logs = captureLogs('debug');
    try {
      const log = getLogger({ module: 'unit' });

      runWithLogContext({ requestId: 'ctx-123', userId: 42 }, () => {
        log.debug('debug line');
        log.info('info line', {
          password: 'hunter2',
          nested: { authorization: 'Bearer leaked', orderId: 7 },
          note: 'kept',
        });
        log.error('boom', { error: new Error('kaboom') });
      });

      // Same logger, called OUTSIDE the context: the fields must disappear
      // again. A leaked context would attribute background work to a request
      // that never happened, which is worse than having no correlation at all.
      log.warn('outside any context');

      const debug = logs.find((entry) => entry.message === 'debug line');
      assert.ok(debug, 'debug is visible at level debug');
      assert.equal(debug!.requestId, 'ctx-123', 'context reaches every call inside it');

      const detached = logs.find((entry) => entry.message === 'outside any context')!;
      assert.equal(detached.requestId, undefined, 'the context does not outlive the run');
      assert.equal(detached.userId, undefined);

      const info = logs.find((entry) => entry.message === 'info line')!;
      assert.equal(info.requestId, 'ctx-123', 'AsyncLocalStorage carried the id with no parameter');
      assert.equal(info.userId, 42);
      assert.equal(info.module, 'unit');
      assert.equal(info.password, '[redacted]');
      assert.equal((info.nested as Record<string, unknown>).authorization, '[redacted]');
      assert.equal((info.nested as Record<string, unknown>).orderId, 7, 'non-secret fields survive');
      assert.equal(info.note, 'kept');
      assert.ok(String(info.time).endsWith('Z'), 'timestamps are sortable and UTC');

      const error = logs.find((entry) => entry.message === 'boom')!;
      const serialized = error.error as Record<string, unknown>;
      assert.equal(serialized.name, 'Error');
      assert.equal(serialized.message, 'kaboom');
      if (config.env !== 'production') {
        assert.equal(typeof serialized.stack, 'string', 'stacks are for non-production only');
      }

      setLogLevel('warn');
      const before = logs.length;
      log.info('dropped below the level');
      assert.equal(logs.length, before, 'a disabled line is not even serialized');
      log.warn('kept at warn');
      assert.equal(logs.length, before + 1);
    } finally {
      restoreLogs();
    }
  });
});