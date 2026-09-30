import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request / per-event log context (Day 8).
 *
 * WHY AsyncLocalStorage INSTEAD OF PASSING requestId THROUGH EVERY FUNCTION
 * -------------------------------------------------------------------------
 * The alternative is threading a `requestId` parameter through the controller →
 * service → Prisma → cache → Kafka layers, or attaching it to `req` and only
 * remembering to log it in HTTP-aware code. Both fail in practice: the moment a
 * log line is written by the cache or the outbox dispatcher, the id is gone, and
 * exactly the interesting logs (that ran inside a request but not in a handler)
 * become uncorrelatable.
 *
 * `AsyncLocalStorage` is built into Node (`node:async_hooks`) with no
 * dependency. It carries a value across the whole async call tree of a
 * callback, so ANY module can call `getLogContext()` and get the id of the
 * request (or the consumed event) that caused the work - without changing a
 * single function signature.
 *
 * Two things it is NOT:
 *   - it is not distributed tracing. There is no span tree and nothing crosses
 *     a process boundary; the correlationId on an event envelope is what links
 *     the API's request to the worker's processing (see docs/KAFKA.md §1).
 *   - it is not a cache. It holds only small, non-secret identifiers.
 */
export interface LogContext {
  /** Id of the HTTP request, also returned to the client as X-Request-ID. */
  requestId?: string;
  /** Authenticated user, when the request reached the auth middleware. */
  userId?: number;
  /**
   * Request path WITHOUT the query string, e.g. `/api/products/42`.
   *
   * It is called `path` and not `route` on purpose: a route is a DECLARED
   * pattern (`/api/products/:id`) and is only known once Express has matched,
   * which is after most handler logs are written. The metrics/access-log line
   * carries both, and conflating them would put raw ids into a field people
   * group by.
   */
  path?: string;
  /** Kafka event being handled (worker side). */
  eventId?: string;
  /** Ties every event caused by one user action together. */
  correlationId?: string;
  /** Consumer group processing the event (worker side). */
  consumerGroup?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Runs `fn` with `context` available to every log call inside it.
 *
 * The context is created empty if needed and shallow-copied on every read, so a
 * mutation in one branch of the call tree can never be observed by a sibling
 * running concurrently on the same event-loop turn.
 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

/** Current context, or an empty object outside any request/event. */
export function getLogContext(): LogContext {
  return storage.getStore() ?? {};
}

/**
 * Merges fields into the CURRENT context (e.g. `userId` once the token is
 * verified). A no-op outside a context, which keeps this safe to call from
 * anywhere - including a startup path or a test.
 */
export function updateLogContext(patch: Partial<LogContext>): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current, patch);
}
