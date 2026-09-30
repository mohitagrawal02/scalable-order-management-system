import { createApp } from './app';
import { config } from './config';
import { prisma } from './config/prisma';
import {
  brokerSummary,
  closeKafkaAdmin,
  disconnectProducer,
  startOutboxDispatcher,
  stopOutboxDispatcher,
} from './infrastructure/kafka';
import {
  closeHttpServer,
  installFatalErrorHandlers,
  installShutdownHandlers,
} from './infrastructure/lifecycle';
import { getLogger } from './infrastructure/logging';
import { closeRedis } from './infrastructure/redis';

/**
 * HTTP server entrypoint: binds the Express app to a port and owns this
 * process's lifecycle.
 *
 * Startup never waits for Redis or Kafka: both connections open lazily and
 * every consumer of them degrades gracefully (docs/REDIS.md, docs/KAFKA.md).
 * That keeps them from becoming boot-time dependencies - a laptop with no
 * broker running still starts an API that serves every request.
 *
 * Day 7 added one background responsibility here: the OUTBOX DISPATCHER, which
 * publishes committed business events to Kafka. It runs here (as well as in the
 * worker) so a single `npm run dev` still publishes events promptly. It does NOT
 * run the notification consumer - side effects belong in the worker, which is
 * why the API stays fast when notifications are slow (docs/KAFKA.md §2).
 *
 * Day 8 made the shutdown path a first-class citizen (see lifecycle/shutdown.ts
 * for the defects in the old nested-callback version). The step order below is
 * the one that matters:
 *
 *   1. stop-outbox-dispatcher  stop STARTING new publishes
 *   2. close-http-server       stop accepting traffic; drain in-flight requests
 *   3. disconnect-producer     let the publishes already in flight finish
 *   4. close-kafka-admin       close the admin socket
 *   5. close-redis             cache + limiter stop (MySQL takes over)
 *   6. disconnect-prisma       last: everything above may still have needed it
 *
 * Anything left unpublished after step 3 is NOT lost - it is a PENDING row in
 * MySQL, and the next process to start dispatches it.
 */
async function main(): Promise<void> {
  // Before anything can throw: a crash should be a structured log line with a
  // service name and a pid, not an unlabelled stack on stderr.
  installFatalErrorHandlers('api');

  const app = createApp();
  const server = app.listen(config.port);

  // e.g. EADDRINUSE. Without this listener Node re-throws it as an unhandled
  // 'error' event; with it the failure is reported and the process leaves.
  server.on('error', (err) => {
    getLogger({ module: 'server' }).error('http server error', { port: config.port, error: err });
    process.exit(1);
  });

  await new Promise<void>((resolve) => server.once('listening', () => resolve()));

  const log = getLogger({ module: 'server' });
  log.info('http server listening', {
    role: 'api',
    port: config.port,
    env: config.env,
    // Says which deployable this is, and which probes to point at it.
    liveness: `http://localhost:${config.port}/api/health/live`,
    readiness: `http://localhost:${config.port}/api/health/ready`,
  });

  if (config.kafka.enabled) {
    startOutboxDispatcher();
    log.info('kafka enabled', {
      brokers: brokerSummary(),
      note: 'run `npm run worker` to consume events and create notifications',
    });
  } else {
    log.warn('kafka disabled', {
      note: 'events are still recorded in the outbox, but never published',
    });
  }

  installShutdownHandlers({
    role: 'api',
    steps: [
      { name: 'stop-outbox-dispatcher', run: () => stopOutboxDispatcher() },
      { name: 'close-http-server', run: () => closeHttpServer(server) },
      { name: 'disconnect-producer', run: () => disconnectProducer() },
      { name: 'close-kafka-admin', run: () => closeKafkaAdmin() },
      { name: 'close-redis', run: () => closeRedis() },
      { name: 'disconnect-prisma', run: () => prisma.$disconnect() },
    ],
  });
}

main().catch((err) => {
  getLogger({ module: 'server' }).error('fatal startup error', { error: err });
  process.exit(1);
});