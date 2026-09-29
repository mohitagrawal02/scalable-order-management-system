import { createApp } from './app';
import { config } from './config';
import { prisma } from './config/prisma';
import { closeRedis } from './infrastructure/redis';
import {
  closeKafkaAdmin,
  disconnectProducer,
  startOutboxDispatcher,
  stopOutboxDispatcher,
} from './infrastructure/kafka';

/**
 * HTTP server entrypoint. Binds the Express app to a port and owns the
 * process lifecycle (graceful shutdown on SIGINT / SIGTERM).
 *
 * Startup never waits for Redis: the connection is opened in the background
 * and every Redis consumer degrades gracefully if it is unavailable
 * (docs/REDIS.md). That keeps Redis from becoming a boot-time dependency.
 *
 * Day 7 adds one background responsibility to this process: the OUTBOX
 * DISPATCHER, which publishes committed business events to Kafka. It runs here
 * (as well as in the worker) so that a single `npm run dev` still publishes
 * events promptly. It deliberately does NOT run the notification consumer -
 * side effects belong in the worker, which is why the API stays fast when
 * notifications are slow (docs/KAFKA.md §2).
 *
 * Kafka is not a boot-time dependency either: if the broker is down, events
 * accumulate in the MySQL outbox and are published when it returns.
 */
async function main(): Promise<void> {
  const app = createApp();

  const server = app.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port} (${config.env})`);
  });

  if (config.kafka.enabled) {
    startOutboxDispatcher();
    console.log(
      `[server] kafka brokers=${config.kafka.brokers.join(',')} ` +
        '(run `npm run worker` to consume events and create notifications)'
    );
  } else {
    console.log('[server] KAFKA_ENABLED=false - events are recorded but never published');
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[server] received ${signal}, shutting down gracefully...`);
    server.close(async () => {
      await prisma.$disconnect();
      await closeRedis();
      // Stop producing first, then close the socket: an in-flight publish is
      // allowed to finish, and anything left uncommitted stays PENDING in the
      // outbox for the next start.
      stopOutboxDispatcher();
      await disconnectProducer();
      await closeKafkaAdmin();
      process.exit(0);
    });
    // Safety net: force-exit if shutdown hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});