import { NextFunction, Request, Response } from 'express';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { AppError } from '../errors/AppError';

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
 */
export function errorHandler(
  err: unknown,
  _req: Request,
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
    console.error('[unhandled-error]', err);
  } else if (statusCode >= 500) {
    console.error('[app-error]', err);
  }

  res.status(statusCode).json(body);
}