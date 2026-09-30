import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { getLogger, runWithLogContext } from '../infrastructure/logging';
import { metricsRequestFinished, metricsRequestStarted } from '../infrastructure/metrics';

/**
 * Request id + access logging + HTTP metrics (Day 8).
 *
 * One middleware, three concerns that all need the same two facts (the request
 * id and the completion event), so splitting them would mean parsing the same
 * request three times and keeping three middlewares in the right order.
 *
 * ── The request id ──────────────────────────────────────────────────────────
 *
 * Every request gets an id. If the client supplied `X-Request-ID` AND it looks
 * like a safe token, it is reused - that is what makes correlation work across
 * a proxy, a gateway or a frontend that already generated one. Otherwise a UUID
 * is generated.
 *
 * Why validate the incoming header instead of trusting it?
 *   - it arrives from outside the process. A 10KB value, one containing control
 *     characters, or one that changes per request would poison logs and any
 *     downstream aggregation. Accepting only `[A-Za-z0-9._-]{8,64}` bounds
 *     length and charset, which is the whole defence needed for a correlation
 *     id we only ever echo into logs and a response header.
 *   - it is never used for authorisation or as a key to business data.
 *
 * The id is echoed as `X-Request-ID` so a user can quote it in a bug report and
 * an operator can find every log line for that one request.
 *
 * ── The context ─────────────────────────────────────────────────────────────
 *
 * The rest of the request runs inside `runWithLogContext`, so ANY module -
 * controller, service, cache, outbox - logs with this requestId automatically,
 * without a single extra parameter.
 *
 * ── The access log ──────────────────────────────────────────────────────────
 *
 * Exactly one line per request, on completion, at a level that matches the
 * outcome: `info` for success, `warn` for a client error, `error` for a server
 * error. One line per request is deliberate - request logging is the highest
 * volume log a service produces, so it stays small and greppable.
 *
 * The query string is NOT logged verbatim (only its keys): a client could put a
 * token in a query parameter, and a log store is the wrong place to discover
 * that. The path is logged as-is because it is the single most useful field for
 * debugging, and it contains no secrets.
 */
const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Express Request augmentation (Day 8).
 *
 * Declared HERE rather than in a standalone `src/types/express.d.ts` for one
 * practical reason: ts-node (which runs the test suite) does not load ambient
 * declaration files it was not asked to import, so `req.requestId` type-checked
 * under `tsc` but failed inside the tests - a config trap with no payoff. This
 * module is the code that ASSIGNS the property and it is imported by `app.ts`,
 * so wherever the property exists, its type does too. (`req.auth` is augmented
 * by auth.types.ts; TypeScript merges both declarations.)
 */
declare global {
  namespace Express {
    interface Request {
      /** Correlation id: caller-supplied when safe, otherwise generated. */
      requestId?: string;
    }
  }
}

/** Reuses a safe caller-supplied id, otherwise mints a UUID. */
export function resolveRequestId(headerValue: unknown): string {
  if (typeof headerValue === 'string' && SAFE_REQUEST_ID.test(headerValue)) {
    return headerValue;
  }
  return randomUUID();
}

/** `/api/products?page=2` → `/api/products`. Keeps raw URLs out of the logs. */
function urlPath(originalUrl: string): string {
  const queryStart = originalUrl.indexOf('?');
  return queryStart === -1 ? originalUrl : originalUrl.slice(0, queryStart);
}

/**
 * Collapses value-looking segments into placeholders: `/api/orders/42/items` →
 * `/api/orders/:id/items`.
 *
 * WHY THIS IS HERE RATHER THAN "JUST USE THE DECLARED PATTERN"
 * Express reports `req.baseUrl` as the CONCRETE url prefix, not the declared
 * mount path. The payments router is mounted at
 * `/api/orders/:orderId/payments`, so its requests arrive with
 * `baseUrl = '/api/orders/7/payments'` - and labelling metrics with that would
 * allocate one series per order, exactly the cardinality blow-up a metrics
 * registry must not have. Collapsing digits-and-uuid-looking segments bounds the
 * label set whether the value came from a mount prefix or from anywhere else,
 * and costs one regex per finished request.
 */
function collapseDynamicSegments(pattern: string): string {
  return pattern
    .split('/')
    .map((segment) => {
      if (segment === '' || segment.startsWith(':')) return segment;
      if (/^\d+$/.test(segment)) return ':id';
      // UUIDs and long hex/numeric ids (idempotency keys, payment refs).
      if (/^[0-9a-fA-F][0-9a-fA-F-]{15,}$/.test(segment)) return ':id';
      return segment;
    })
    .join('/');
}

/**
 * The prefix the matched route sits under.
 *
 * `req.baseUrl` is right while the request is being handled, but Express 5
 * restores it to `''` as the stack unwinds after an error - and the access log
 * and the metric are written AFTER that, on `res.finish`. Rather than lose the
 * prefix on precisely the requests worth labelling, derive it: the route's own
 * pattern explains the tail of the URL, so the segments in front of it are the
 * prefix. Verified against both paths in tests/integration/observability.test.ts.
 */
function routePrefix(req: Request, routePath: string): string {
  if (typeof req.baseUrl === 'string' && req.baseUrl !== '') return req.baseUrl;

  const patternSegments = routePath.split('/').filter((segment) => segment !== '');
  const urlSegments = urlPath(req.originalUrl).split('/').filter((segment) => segment !== '');
  if (urlSegments.length < patternSegments.length) return '';
  return `/${urlSegments.slice(0, urlSegments.length - patternSegments.length).join('/')}`;
}

/** The declared pattern of the matched Route, or undefined if nothing matched. */
function matchedRoutePattern(req: Request): string | undefined {
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof routePath !== 'string') return undefined;

  const full = `${routePrefix(req, routePath)}${routePath}`;
  if (full === '' || full === '/') return '/';
  // Normalise a trailing slash so `/api/health/` and `/api/health` agree.
  return full.length > 1 && full.endsWith('/') ? full.slice(0, -1) : full;
}

/**
 * The metric / access-log label for a request: always a PATTERN, never a raw URL.
 *
 * `/api/products/42` and `/api/products/43` must land on the same label or the
 * metrics map grows with traffic. Three cases, in order of preference:
 *
 *  1. A Route matched → its declared pattern (`/api/products/:id`), with any
 *     concrete id inside the mount prefix collapsed (see above).
 *  2. 404 → one shared `unmatched` label. Guessing URLs must not mint a series
 *     per guess.
 *  3. No Route matched but the request was not a 404 → the failure came from
 *     middleware mounted ABOVE a route (`cartRouter.use(requireAuth)` is the
 *     real case: a 401 there happens before any Route runs, so `req.route` is
 *     still undefined). The URL is real and worth labelling, so the collapsed
 *     path is used. Unknown paths under such a router could therefore mint
 *     labels - bounded by the registry's route cap, which is the reason that cap
 *     exists.
 *
 * `status` is a parameter rather than read from `req`, because `req` does not
 * know the outcome: only the response does.
 */
export function routeLabel(req: Request, status: number): string {
  const pattern = matchedRoutePattern(req);
  if (pattern) return collapseDynamicSegments(pattern);
  if (status === 404) return 'unmatched';
  return collapseDynamicSegments(urlPath(req.originalUrl)) || '/';
}

export interface RequestContextOptions {
  /** Trust the caller-supplied `X-Request-ID` (default true). */
  trustRequestId?: boolean;
}

export function requestContext(options: RequestContextOptions = {}) {
  const trustRequestId = options.trustRequestId ?? true;

  return function requestContextMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const supplied = trustRequestId ? req.headers[REQUEST_ID_HEADER] : undefined;
    const requestId = resolveRequestId(supplied);
    const startedAt = process.hrtime.bigint();

    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);

    const log = getLogger({ module: 'http' });
    metricsRequestStarted();

    // Registered before `next()` so a handler that throws still produces a log
    // line and a metric - an error response is the one you least want missing
    // from your counters.
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const status = res.statusCode;
      const route = routeLabel(req, status);

      metricsRequestFinished({
        method: req.method,
        route,
        status,
        durationMs: Math.round(durationMs * 100) / 100,
      });

      const fields = {
        method: req.method,
        route,
        // The concrete path (no query string). `req.path` cannot be used here:
        // inside a mounted router it is the path RELATIVE to the mount, so a
        // request to /api/orders would be logged as "/".
        path: urlPath(req.originalUrl),
        queryKeys: Object.keys(req.query ?? {}).slice(0, 10),
        status,
        durationMs: Math.round(durationMs * 100) / 100,
        // Set by requireAuth once a token is verified.
        userId: req.auth?.user.id,
      };

      if (status >= 500) log.error('request failed', fields);
      else if (status >= 400) log.warn('request rejected', fields);
      else log.info('request completed', fields);
    });

    runWithLogContext({ requestId, path: urlPath(req.originalUrl) }, () => {
      next();
    });
  };
}
