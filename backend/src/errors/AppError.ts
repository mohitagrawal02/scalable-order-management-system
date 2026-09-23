/**
 * Operational error with an HTTP status code.
 *
 * "Operational" errors are expected failures that happen at runtime
 * (bad input, not-found, conflicts, ...). They are handled by the global
 * error middleware, which maps the status code into the HTTP response.
 * Unexpected programmer errors (bugs) are intentionally NOT wrapped in this
 * class so they propagate as 500s and surface loudly in logs.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, AppError);
  }
}