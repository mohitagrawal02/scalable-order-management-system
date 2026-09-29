import { config } from './config';
import { prisma } from './config/prisma';
import {
  brokerSummary,
  closeKafkaAdmin,
  connectProducer,
  disconnectProducer,
  ensureTopics,
  startOutboxDispatcher,
  stopOutboxDispatcher,
} from './infrastructure/kafka';
import { startNotificationConsumer } from './modules/notifications/notification.consumer';

/**
 * Async worker entrypoint (Day 7).
 *
 * WHY A SEPARATE PROCESS
 * ----------------------
 * The whole point of Day 7 is that side effects stop competing with requests
 * for the API's event loop and connections. Running the consumer inside the API
 * process would work in development and quietly rebuild the coupling we just
 * removed:
 *
 *   - a slow consumer would still occupy the API's event loop;
 *   - a poison message or consumer rebalance would affect request latency;
 *   - one crash would take down both the API and the side-effect processing;
 *   - you could never scale them independently (5 API pods, 1 worker).
 *
 * So the split is: API = synchronous + critical path, worker = asynchronous +
 * retryable. Both are still the SAME codebase and the same modules - one
 * deployable monolith with two process roles, not microservices.
 *
 * WHAT THIS PROCESS RUNS
 * ----------------------
 *   1. the outbox dispatcher  (MySQL → Kafka: publishes committed events)
 *   2. the notification consumer (Kafka → MySQL: OrderPaid/PaymentFailed →
 *      notifications, with retries and a dead-letter topic)
 *
 * The API also runs the dispatcher (so a single-process dev setup still
 * publishes promptly). Running it twice is safe by design - see outbox.ts.
 *
 * Start it with:  npm run worker
 */
async function main(): Promise<void> {
  console.log(
    `[worker] starting brokers=${brokerSummary()} clientId=${config.kafka.clientId} ` +
      `group=${config.kafka.notificationGroupId}`
  );

  // Fail fast and loudly: unlike the API, a worker with no broker has nothing
  // useful it can do, and silently idling would hide a real misconfiguration.
  try {
    await ensureTopics();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[worker] cannot reach Kafka at ${brokerSummary()} (${message}).\n` +
        '        Start it with: npm run kafka:start   (see docs/KAFKA.md §2)'
    );
    process.exit(1);
  }

  if (!(await connectProducer())) {
    console.error('[worker] producer could not connect; exiting so the failure is visible');
    process.exit(1);
  }

  const consumer = await startNotificationConsumer();
  startOutboxDispatcher();

  console.log(
    `[worker] ready - consuming [${consumer.topics.join(',')}] as group "${consumer.groupId}"`
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal}, shutting down gracefully...`);

    // Safety net: if shutdown hangs (a stuck broker socket), do not linger.
    setTimeout(() => process.exit(1), 10_000).unref();

    // Order matters: stop consuming first (commit what we have and leave the
    // group cleanly), then stop publishing, then close sockets. That way no
    // message is in flight in either direction when the process exits.
    await consumer.stop();
    stopOutboxDispatcher();
    await disconnectProducer();
    await closeKafkaAdmin();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[worker] fatal error:', err);
  process.exit(1);
});
