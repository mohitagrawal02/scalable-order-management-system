import { NextFunction, Request, Response } from 'express';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { AppError } from '../errors/AppError';
import { getLogger } from '../infrastructure/logging';
import { routeLabel } from './requestContext';

/**
 * Structured error logger (Day 8).
 *
 * Every line written here already carries `requestId` (and `userId` once the
 * token was verified) from the AsyncLocalStorage context the request middleware
 * installed, so an error can be found from the id the client was handed in
 * `X-Request-ID` - which is the whole point of Day 8.
 */
const errorLogger = getLogger({ module: 'http-error' });

/** 404 handler: called when no route matched the request path. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
}

/**
 * Global error handler: converts any thrown error into a JSON response.
 *
 * Signature/expiry failures from the JWT library are "client fault" — a bad
 * or expired token — so they map to 401 instead of 500. They are also never
 * logged as server errors.
 *
 * LOGGING POLICY (Day 8)
 * ----------------------
 * Three tiers, because a log line that cannot be triaged is noise:
 *
 *   unexpected error  → level `error` + the Error object (name/message/code,
 *                       and the stack outside production). This is the tier an
 *                       alert should fire on.
 *   AppError >= 500   → level `error`. A deliberate 5xx (a dependency failed)
 *                       is still our fault and still needs a look.
 *   AppError <  500   → NOT logged here at all. A 400/401/404/429 is the client
 *                       retrying a form or guessing an id; it is already one
 *                       `warn` access-log line, and repeating it as an error
 *                       would bury the real failures.
 *
 * The response body is deliberately UNCHANGED (`error.status` + `error.message`
 * only): the request id belongs in the `X-Request-ID` response header, not in a
 * payload clients parse.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const isAppError = err instanceof AppError;
  const isJwtClientError =
    err instanceof JsonWebTokenError || err instanceof TokenExpiredError;

  let statusCode: number;
  let message: string;

  if (isAppError) {
    statusCode = err.statusCode;
    message = err.message;
  } else if (isJwtClientError) {
    statusCode = 401;
    message = 'Invalid or expired token';
  } else {
    statusCode = 500;
    message = 'Internal server error';
  }

  // Never leak internal details in production.
  const body: Record<string, unknown> = {
    error: {
      status: statusCode,
      message,
    },
  };

  if (!isAppError && !isJwtClientError) {
    // Truly unexpected: the one tier worth alerting on.
    errorLogger.error('unhandled error', errorFields(req, statusCode, err));
  } else if (isAppError && statusCode >= 500) {
    // A deliberate 5xx: a dependency failed and we said so.
    errorLogger.error('request failed', errorFields(req, statusCode, err));
  }
  // Everything else (400/401/404/429, including JWT failures) is client fault:
  // the access log already recorded it once, at `warn`.

  res.status(statusCode).json(body);
}

/** Fields shared by both error-log tiers. `error` is serialized by the logger. */
function errorFields(req: Request, status: number, err: unknown): Record<string, unknown> {
  return {
    method: req.method,
    route: routeLabel(req, status),
    path: req.originalUrl.split('?')[0],
    status,
    // requestId is already on the line via the log context; it is repeated here
    // so an error record stays greppable by id even when the context is not
    // attached (e.g. an error surfaced from a background job).
    requestId: req.requestId,
    // Passed as an object: the logger serializes it to
    // { name, message, code, stack? } and redacts as it goes.
    error: err,
  };
}