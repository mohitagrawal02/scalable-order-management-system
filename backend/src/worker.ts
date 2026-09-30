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
import {
  installFatalErrorHandlers,
  installShutdownHandlers,
} from './infrastructure/lifecycle';
import { getLogger } from './infrastructure/logging';
import { closeRedis } from './infrastructure/redis';
import { startNotificationConsumer } from './modules/notifications/notification.consumer';

const workerLogger = getLogger({ module: 'worker' });

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
 * SHUTDOWN ORDER (Day 8)
 * ----------------------
 * Consume first, publish second, sockets last:
 *
 *   1. stop-outbox-dispatcher   no new publishes started after this
 *   2. stop-notification-consumer  kafkajs finishes the message it is inside,
 *      commits what it can and leaves the group. Anything it had fetched but not
 *      finished stays UNCOMMITTED and is redelivered to another member - that is
 *      at-least-once doing its job, and the dedup ledger makes the redelivery a
 *      no-op. Offsets are never committed in advance, so a shutdown (or a
 *      SIGKILL) can lose processing but never an event.
 *   3. disconnect-producer      the dispatcher's in-flight publishes finish here
 *   4. close-kafka-admin / close-redis / disconnect-prisma
 *
 * Start it with:  npm run worker
 */
async function main(): Promise<void> {
  installFatalErrorHandlers('worker');

  workerLogger.info('starting', {
    role: 'worker',
    brokers: brokerSummary(),
    clientId: config.kafka.clientId,
    group: config.kafka.notificationGroupId,
  });

  // Fail fast and loudly: unlike the API, a worker with no broker has nothing
  // useful it can do, and silently idling would hide a real misconfiguration.
  try {
    await ensureTopics();
  } catch (err) {
    workerLogger.error('cannot reach Kafka - exiting so the failure is visible', {
      brokers: brokerSummary(),
      hint: 'start it with: npm run kafka:start (see docs/KAFKA.md §2)',
      error: err,
    });
    process.exit(1);
  }

  if (!(await connectProducer())) {
    workerLogger.error('producer could not connect - exiting so the failure is visible');
    process.exit(1);
  }

  const consumer = await startNotificationConsumer();
  startOutboxDispatcher();

  workerLogger.info('ready', {
    role: 'worker',
    topics: consumer.topics,
    group: consumer.groupId,
  });

  installShutdownHandlers({
    role: 'worker',
    steps: [
      { name: 'stop-outbox-dispatcher', run: () => stopOutboxDispatcher() },
      { name: 'stop-notification-consumer', run: () => consumer.stop() },
      { name: 'disconnect-producer', run: () => disconnectProducer() },
      { name: 'close-kafka-admin', run: () => closeKafkaAdmin() },
      { name: 'close-redis', run: () => closeRedis() },
      { name: 'disconnect-prisma', run: () => prisma.$disconnect() },
    ],
  });
}

main().catch((err) => {
  workerLogger.error('fatal error', { error: err });
  process.exit(1);
});
