/**
 * In-process HTTP metrics (Day 8).
 *
 * WHY IN-PROCESS AND NOT PROMETHEUS
 * ---------------------------------
 * The requirement is operational visibility into one Node process, locally.
 * Adding a metrics server, a scrape format, a push gateway or a time-series
 * database would be infrastructure this project does not have and cannot run -
 * and the Day-8 rule is explicitly "observability, not infrastructure
 * complexity". A counter map plus a duration histogram answers the questions
 * that actually get asked ("are we erroring?", "did the slow tail move?", "is
 * anything still in flight during shutdown?") and is inspectable in a test.
 *
 * The trade-off, stated plainly: these numbers are PER PROCESS and reset on
 * restart. With several API instances each keeps its own; aggregating them is
 * exactly the job Prometheus/Grafana would do later. See docs/RELIABILITY.md
 * ("Known limitations").
 *
 * CARDINALITY
 * -----------
 * The one way a metrics map becomes dangerous is a unique key per request:
 * `/api/products/1`, `/api/products/2`, ... would allocate memory forever. So
 * the route label is always a PATTERN (`GET /api/products/:id`), never a raw
 * URL, and the number of distinct patterns is capped defensively. User ids and
 * request ids are never labels, for the same reason.
 */

/** Latency buckets in ms. Index `i` counts observations <= BUCKETS[i]. */
export const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500] as const;

/** Distinct route labels allowed before everything collapses into "other". */
const MAX_DISTINCT_ROUTES = 200;

export interface RouteMetrics {
  /** e.g. "GET /api/products/:id" - a pattern, never a raw URL. */
  route: string;
  method: string;
  count: number;
  errors4xx: number;
  errors5xx: number;
  totalMs: number;
  maxMs: number;
  avgMs?: number;
}

export interface HttpMetricsSnapshot {
  /** Requests that have started but not finished (nonzero during a drain). */
  inFlight: number;
  requests: {
    total: number;
    byStatusClass: Record<string, number>;
    byMethod: Record<string, number>;
  };
  durationMs: {
    count: number;
    sum: number;
    avg: number;
    max: number;
    /** Cumulative counts, i.e. `le25` includes everything <= 25ms. */
    buckets: Record<string, number>;
  };
  /** Highest request count first. */
  routes: RouteMetrics[];
  /** True once the route cap was hit and labels started collapsing. */
  routeCapReached: boolean;
}

interface Counter {
  total: number;
  byStatusClass: Map<string, number>;
  byMethod: Map<string, number>;
  durationCount: number;
  durationSum: number;
  durationMax: number;
  buckets: number[];
  routes: Map<string, RouteMetrics>;
  routeCapReached: boolean;
  inFlight: number;
}

function newCounter(): Counter {
  return {
    total: 0,
    byStatusClass: new Map(),
    byMethod: new Map(),
    durationCount: 0,
    durationSum: 0,
    durationMax: 0,
    buckets: new Array(DURATION_BUCKETS_MS.length + 1).fill(0),
    routes: new Map(),
    routeCapReached: false,
    inFlight: 0,
  };
}

let counter = newCounter();

function statusClass(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return '1xx';
}

function bucketIndex(durationMs: number): number {
  for (let i = 0; i < DURATION_BUCKETS_MS.length; i += 1) {
    if (durationMs <= DURATION_BUCKETS_MS[i]) return i;
  }
  return DURATION_BUCKETS_MS.length; // the "+Inf" bucket
}

function bucketLabel(index: number): string {
  return index < DURATION_BUCKETS_MS.length ? `le${DURATION_BUCKETS_MS[index]}` : 'gt2500';
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A request has started (drives the in-flight gauge). */
export function metricsRequestStarted(): void {
  counter.inFlight += 1;
}

/** A request has finished: record status, duration and the route label. */
export function metricsRequestFinished(observation: {
  method: string;
  route: string;
  status: number;
  durationMs: number;
}): void {
  const { method, route, status, durationMs } = observation;

  if (counter.inFlight > 0) counter.inFlight -= 1;

  counter.total += 1;
  counter.byMethod.set(method, (counter.byMethod.get(method) ?? 0) + 1);
  const klass = statusClass(status);
  counter.byStatusClass.set(klass, (counter.byStatusClass.get(klass) ?? 0) + 1);

  counter.durationCount += 1;
  counter.durationSum += durationMs;
  if (durationMs > counter.durationMax) counter.durationMax = durationMs;
  counter.buckets[bucketIndex(durationMs)] += 1;

  const key = `${method} ${route}`;
  let entry = counter.routes.get(key);
  if (!entry) {
    if (counter.routes.size >= MAX_DISTINCT_ROUTES) {
      // Defensive: a label that somehow varies per request would otherwise grow
      // this map without bound. Collapse rather than leak.
      counter.routeCapReached = true;
      entry = counter.routes.get('other');
      if (!entry) {
        entry = { route: 'other', method, count: 0, errors4xx: 0, errors5xx: 0, totalMs: 0, maxMs: 0 };
        counter.routes.set('other', entry);
      }
    } else {
      entry = { route, method, count: 0, errors4xx: 0, errors5xx: 0, totalMs: 0, maxMs: 0 };
      counter.routes.set(key, entry);
    }
  }

  entry.count += 1;
  entry.totalMs += durationMs;
  if (durationMs > entry.maxMs) entry.maxMs = durationMs;
  if (status >= 500) entry.errors5xx += 1;
  else if (status >= 400) entry.errors4xx += 1;
}

function toObject(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Immutable snapshot for `/api/metrics` and for tests. */
export function getHttpMetrics(): HttpMetricsSnapshot {
  const buckets: Record<string, number> = {};
  // Cumulative, matching the usual histogram convention: `le25` means
  // "everything at or below 25ms", not the 10-25ms band alone.
  let cumulative = 0;
  for (let i = 0; i < counter.buckets.length; i += 1) {
    cumulative += counter.buckets[i];
    buckets[bucketLabel(i)] = cumulative;
  }

  return {
    inFlight: counter.inFlight,
    requests: {
      total: counter.total,
      byStatusClass: toObject(counter.byStatusClass),
      byMethod: toObject(counter.byMethod),
    },
    durationMs: {
      count: counter.durationCount,
      sum: round(counter.durationSum),
      avg: counter.durationCount === 0 ? 0 : round(counter.durationSum / counter.durationCount),
      max: round(counter.durationMax),
      buckets,
    },
    routes: [...counter.routes.values()]
      .map((entry) => ({
        ...entry,
        totalMs: round(entry.totalMs),
        maxMs: round(entry.maxMs),
        avgMs: round(entry.count === 0 ? 0 : entry.totalMs / entry.count),
      }))
      .sort((a, b) => b.count - a.count),
    routeCapReached: counter.routeCapReached,
  };
}

/** Test seam: called between test files so counters cannot leak across them. */
export function resetHttpMetrics(): void {
  counter = newCounter();
}

