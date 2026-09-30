import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { config } from '../../config';
import { getLogger } from '../../infrastructure/logging';
import {
  PermanentEventError,
  TOPICS,
  startEventConsumer,
  type ConsumedEvent,
  type RunningConsumer,
} from '../../infrastructure/kafka';

/**
 * Structured logger for this module (Day 8).
 *
 * The consumer infrastructure runs every handler inside a log context carrying
 * eventId / correlationId / consumerGroup, so a line written from here (or from
 * the notification service it calls) is already attributable to one event.
 */
const notificationLogger = getLogger({ module: 'notification-consumer' });
import {
  createPaymentFailedNotification,
  createPaymentSucceededNotification,
} from './notification.service';

/**
 * Notification consumer (Day 7).
 *
 * WHAT CHANGED FROM DAY 5
 * -----------------------
 * Day 5 created the notification INSIDE the payment transaction, so it was
 * guaranteed to exist the moment the API responded. Day 7 makes it
 * asynchronous: the payment transaction now records an intent (the outbox row),
 * the broker carries it, and THIS consumer writes the notification. The API
 * response no longer waits for it.
 *
 * That is a real trade, not a free win:
 *   - the notification is now EVENTUALLY consistent: a short delay after the
 *     response (`GET /api/notifications` may momentarily not show it);
 *   - in exchange, a slow or broken notification path can no longer slow down
 *     or fail a payment, and additional consumers (email, analytics, webhooks)
 *     can be added without touching the payment code at all.
 *
 * Nothing about payment CORRECTNESS moved: the SUCCEEDED/PAID state is still
 * written by the payment transaction. Only the side effect became asynchronous.
 * See docs/KAFKA.md §1 and docs/NOTIFICATIONS.md §4.
 *
 * IDEMPOTENCY: WHY THIS HANDLER IS SAFE TO RUN TWICE
 * --------------------------------------------------
 * Kafka delivers at least once, so this WILL be called twice for some events
 * (rebalance, retry after a partial failure, duplicate outbox publish). The
 * handler is idempotent because the dedup marker and the notification are
 * written in ONE transaction:
 *
 *     INSERT INTO processed_events (consumer_group, event_id, ...)   ← may fail
 *     INSERT INTO notifications (...)                                ← only if it didn't
 *
 * `processed_events` has UNIQUE (consumer_group, event_id), so the second
 * delivery fails on the INSERT, the transaction touches nothing, and the whole
 * thing is a no-op. Two important details:
 *
 *   - The marker lives in MySQL, NOT in memory, so it survives a worker restart
 *     and works when several workers share the group.
 *   - The marker is inserted INSIDE the same transaction as the notification,
 *     so a crash between them cannot leave "marked as done but no notification"
 *     (the transaction rolls back and the event is redelivered - correct, since
 *     nothing was actually done).
 *
 * The alternative - "check if it exists, then insert" - is a check-then-act race
 * that two concurrent consumers can both win. The unique constraint cannot be
 * raced.
 */

/** The consumer group this module owns. */
export const NOTIFICATION_CONSUMER_GROUP = config.kafka.notificationGroupId;

/** Topics this consumer reads. */
export const NOTIFICATION_CONSUMER_TOPICS: string[] = [
  TOPICS.ORDER_EVENTS,
  TOPICS.PAYMENT_EVENTS,
];

/**
 * Reads a required field out of an event payload.
 *
 * Envelope validation guarantees the SHAPE of the envelope, not of the payload -
 * the two evolve independently. A missing field means the producer and the
 * consumer disagree about the schema, which retrying cannot fix, so this throws
 * a PermanentEventError and the message goes straight to the dead-letter topic
 * instead of burning three attempts first.
 */
function requireField<T>(payload: Record<string, unknown>, field: string, expected: 'number' | 'string'): T {
  const value = payload[field];
  if (expected === 'number' && typeof value !== 'number') {
    throw new PermanentEventError(`Event payload is missing numeric field "${field}"`);
  }
  if (expected === 'string' && typeof value !== 'string') {
    throw new PermanentEventError(`Event payload is missing string field "${field}"`);
  }
  return value as T;
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  notificationLogger.info(message, fields);
}

/** True when the error is the dedup ledger's unique constraint firing. */
function isDuplicateEventError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Handles one domain event. Exported so tests (and a future replay tool) can
 * invoke it directly with the identical code path the consumer uses.
 */
export async function handleDomainEvent(event: ConsumedEvent): Promise<void> {
  const { envelope, attempt } = event;
  const payload = envelope.payload as Record<string, unknown>;

  // Validate the payload BEFORE opening a transaction: a bad payload should not
  // even borrow a connection.
  switch (envelope.eventType) {
    case 'OrderPaid': {
      requireField<number>(payload, 'orderId', 'number');
      requireField<number>(payload, 'userId', 'number');
      requireField<string>(payload, 'orderNumber', 'string');
      break;
    }
    case 'PaymentFailed': {
      requireField<number>(payload, 'orderId', 'number');
      requireField<number>(payload, 'userId', 'number');
      requireField<string>(payload, 'orderNumber', 'string');
      requireField<string>(payload, 'reason', 'string');
      break;
    }
    default:
      throw new PermanentEventError(`No notification rule for event type "${envelope.eventType}"`);
  }

  try {
    await prisma.$transaction(async (tx) => {
      // (1) Claim the event for this group. THIS is the idempotency guard.
      await tx.processedEvent.create({
        data: {
          consumerGroup: NOTIFICATION_CONSUMER_GROUP,
          eventId: envelope.eventId,
          eventType: envelope.eventType,
        },
      });

      // (2) Only reachable on the first delivery of this event.
      if (envelope.eventType === 'OrderPaid') {
        await createPaymentSucceededNotification(tx, {
          userId: requireField<number>(payload, 'userId', 'number'),
          orderId: requireField<number>(payload, 'orderId', 'number'),
          orderNumber: requireField<string>(payload, 'orderNumber', 'string'),
        });
        return;
      }

      await createPaymentFailedNotification(tx, {
        userId: requireField<number>(payload, 'userId', 'number'),
        orderId: requireField<number>(payload, 'orderId', 'number'),
        orderNumber: requireField<string>(payload, 'orderNumber', 'string'),
        reason: requireField<string>(payload, 'reason', 'string'),
      });
    });

    log(
      `notified eventType=${envelope.eventType} eventId=${envelope.eventId} ` +
        `aggregateId=${envelope.aggregateId} attempt=${attempt}`
    );
  } catch (err) {
    if (isDuplicateEventError(err)) {
      // Expected, not exceptional: this is at-least-once delivery working as
      // designed. Logged at info level so it is visible without looking like a
      // failure.
      log(
        `duplicate ignored eventType=${envelope.eventType} eventId=${envelope.eventId} ` +
          `group=${NOTIFICATION_CONSUMER_GROUP}`
      );
      return;
    }
    throw err;
  }
}

/**
 * Starts the notification worker's consumer group: `order.events` +
 * `payment.events` → notifications, with a dead-letter topic for whatever it
 * cannot process. Caller owns the lifecycle (see src/worker.ts).
 */
export async function startNotificationConsumer(
  overrides: { fromBeginning?: boolean } = {}
): Promise<RunningConsumer> {
  return startEventConsumer({
    name: 'notification-service',
    groupId: NOTIFICATION_CONSUMER_GROUP,
    topics: NOTIFICATION_CONSUMER_TOPICS,
    deadLetterTopic: TOPICS.NOTIFICATION_DLQ,
    fromBeginning: overrides.fromBeginning ?? false,
    handler: handleDomainEvent,
  });
}

