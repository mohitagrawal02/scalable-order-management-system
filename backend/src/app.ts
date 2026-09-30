import cors from 'cors';
import express, { Express } from 'express';
import helmet from 'helmet';
import { config } from './config';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { apiRouter } from './routes';

/**
 * Express application factory.
 *
 * Kept separate from the HTTP server (src/server.ts) so the app can be
 * imported and tested without binding to a port.
 *
 * MIDDLEWARE ORDER (Day 8) — the order is the design, so it is documented once:
 *
 *   1. requestContext   FIRST, unconditionally. It mints the request id, opens
 *                       the log context and starts the latency timer, so every
 *                       log line and every metric below — including a 429 from
 *                       the rate limiter or a 404 from `notFoundHandler` — is
 *                       attributable and counted. Put it anywhere later and the
 *                       requests you most want to see (the ones that failed
 *                       before reaching a handler) are exactly the ones missing.
 *   2. helmet           security headers.
 *   3. cors             only allowlisted origins outside development.
 *   4. express.json     body parsing, after CORS so a rejected preflight never
 *                       pays for parsing a body.
 *   5. routes
 *   6. notFound → errorHandler, last, so anything thrown upstream is converted
 *      into the one error envelope clients parse.
 */
export function createApp(): Express {
  const app = express();

  /**
   * `trust proxy` decides what `req.ip` means, and the login rate limiter keys
   * on it. Default false: the first address the socket saw. Enabling it without
   * naming the real proxy hop count lets any client forge `X-Forwarded-For` and
   * pick its own rate-limit bucket (config refuses `TRUST_PROXY=true` in
   * production for exactly that reason — see docs/RELIABILITY.md).
   */
  app.set('trust proxy', config.http.trustProxy);
  app.disable('x-powered-by');

  app.use(requestContext());

  app.use(helmet());
  app.use(cors({ origin: config.http.corsOrigins }));
  app.use(express.json());

  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}