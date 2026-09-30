import { Prisma } from '@prisma/client';
import { config } from '../../config';
import { prisma } from '../../config/prisma';
import { getLogger } from '../logging';
import type { EventEnvelope } from './envelope';
import type { PublishableEvent } from './events';
import { envelopeHeaders } from './envelope';
import { kafkaEnabled, kafkaPublisher, type Publisher } from './producer';

/** Structured logger for this module (Day 8). */
const outboxLogger = getLogger({ module: 'outbox' });

/**
 * Transactional outbox (Day 7).
 *
 * THE PROBLEM IT SOLVES - THE DUAL WRITE
 * --------------------------------------
 * The naive event-driven payment flow is:
 *
 *     await prisma.$transaction(...)   // payment SUCCEEDED, order PAID
 *     await producer.send(...)         // publish OrderPaid
 *
 * Those are two independent systems, and nothing coordinates them. The window
 * between them is small but permanent, and it fails in both directions:
 *
 *   (a) commit succeeds, publish fails (broker down, pod OOM-killed, network) →
 *       money is taken and the user is NEVER told. The event is lost forever;
 *       no retry mechanism exists because nothing recorded the intent.
 *   (b) publish first, then the transaction rolls back → every consumer reacts
 *       to an order that was never actually paid. Worse: the "fix" is to
 *       un-consume an event, which Kafka cannot do.
 *
 * Reordering the two lines only moves the window; it cannot close it. This is
 * inherent to "write to two systems", and it is why "just add a try/catch and
 * retry" is not a solution.
 *
 * THE SOLUTION
 * ------------
 * Put the event in the SAME database transaction as the business change:
 *
 *     await prisma.$transaction(async (tx) => {
 *       ...payment → SUCCEEDED, order → PAID...
 *       await enqueueOutboxEvent(tx, buildOrderPaidEvent(...));
 *     });
 *     // only now, best-effort, does anything talk to Kafka
 *
 * One transaction = one atomic unit, because the outbox row is just another row
 * in the same MySQL transaction. There is now no state where "payment happened
 * but no event exists": either both are committed or neither is. The event is
 * then delivered asynchronously by the dispatcher below, which retries until
 * the broker accepts it. MySQL and Kafka are eventually consistent, and the
 * outbox is the durable log of the gap between them.
 *
 * THE PRICE: AT-LEAST-ONCE, AND EVENTUAL CONSISTENCY
 * -------------------------------------------------
 *   - Consumers see events slightly LATER than the response (typically ms, but
 *     seconds when the broker is down). A user can pay and see the notification
 *     appear a moment after the HTTP response - that is the trade. It is safe
 *     precisely because nothing in the critical path depends on it.
 *   - A crash between "broker accepted it" and "we marked the row published"
 *     republishes it → duplicates. Accepted deliberately: the alternative
 *     (mark first) loses events. Consumer idempotency absorbs them.
 *   - Rows accumulate until published; the table is small, indexed by
 *     (status, id), and swept to PUBLISHED quickly in normal operation.
 *
 * WHY NO CLAIM/LOCK IS TAKEN BEFORE PUBLISHING
 * --------------------------------------------
 * A row is only marked PUBLISHED *after* the broker ack. So two dispatchers
 * (API + worker) can publish the same row concurrently - and that is fine,
 * because it produces exactly the duplicate that idempotent consumers already
 * have to handle. Claiming rows first would need lease expiry and a recovery
 * path for crashed claimants, and would still not remove the duplicate risk.
 * Choosing the simple, obviously-correct version and making consumers
 * idempotent is the standard trade (docs/KAFKA.md §6).
 */

/** How the dispatcher talks to Kafka. Injected so tests can force failures. */
export type OutboxPublisher = Publisher;

/**
 * Writes one event to the outbox INSIDE the caller's transaction.
 *
 * `tx` is mandatory on purpose: an outbox row written on a different connection
 * would not be atomic with the business change, which is the entire point.
 */
export async function enqueueOutboxEvent(
  tx: Prisma.TransactionClient,
  event: PublishableEvent<unknown>
): Promise<void> {
  const { topic, key, envelope } = event;
  await tx.outboxEvent.create({
    data: {
      eventId: envelope.eventId,
      topic,
      eventType: envelope.eventType,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
      partitionKey: key,
      envelope: envelope as unknown as Prisma.InputJsonValue,
      status: 'PENDING',
      occurredAt: new Date(envelope.occurredAt),
    },
  });
}

export interface OutboxDispatchResult {
  /** Rows considered this round. */
  scanned: number;
  published: number;
  failed: number;
  /** Rows that hit maxAttempts during this round and are now parked. */
  deadLettered: number;
  /** True when a dispatch was already running and this call did nothing. */
  skipped: boolean;
}

export interface OutboxStats {
  dispatches: number;
  published: number;
  failed: number;
  deadLettered: number;
  lastDispatchAt: string | null;
}

const stats: OutboxStats = {
  dispatches: 0,
  published: 0,
  failed: 0,
  deadLettered: 0,
  lastDispatchAt: null,
};

export function getOutboxStats(): OutboxStats {
  return { ...stats };
}

export function resetOutboxStats(): void {
  stats.dispatches = 0;
  stats.published = 0;
  stats.failed = 0;
  stats.deadLettered = 0;
  stats.lastDispatchAt = null;
}

/** Rebuilds the publishable shape from a stored row. */
function rowToEvent(row: {
  topic: string;
  partitionKey: string;
  envelope: Prisma.JsonValue;
}): PublishableEvent<unknown> {
  return {
    topic: row.topic as PublishableEvent['topic'],
    key: row.partitionKey,
    envelope: row.envelope as unknown as EventEnvelope,
  };
}

/**
 * Delay before a failed outbox row becomes eligible for its next attempt.
 *
 * THE BUG THIS FIXES (found while inspecting Day 7 for Day 8):
 * every dispatcher tick selected ALL pending rows and counted one attempt per
 * row per tick. With the default 2s interval and a 10-attempt budget, a row was
 * parked as DEAD after ~20 SECONDS of broker unavailability - and a broker
 * restart takes longer than that. So the retry budget that is supposed to ride
 * out an outage was being burned by the POLL INTERVAL, not by real attempts
 * spread over time, and every queued event was dead-lettered by a routine
 * 30-second blip.
 *
 * Now a failed row carries `nextAttemptAt`, so `maxAttempts` is a budget spread
 * over ~1s + 2s + 4s + ... capped at 60s: roughly 6 minutes of real backoff
 * before a human has to intervene. Jitter (±25%) keeps a recovered broker from
 * being hit by the whole backlog in the same tick.
 */
export function outboxBackoffMs(
  attempt: number,
  baseMs = config.kafka.outbox.retryBaseDelayMs,
  maxMs = config.kafka.outbox.retryMaxDelayMs
): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(exponential * jitter);
}

/**
 * One dispatch round: publish the oldest pending events.
 *
 * Never throws, and never runs concurrently with itself inside one process
 * (the `inFlight` guard). Overlapping rounds would be harmless (duplicates are
 * absorbed downstream) but would waste a connection and produce confusing logs.
 */
export async function dispatchOutbox(
  options: { limit?: number; publisher?: OutboxPublisher } = {}
): Promise<OutboxDispatchResult> {
  const limit = options.limit ?? config.kafka.outbox.batchSize;

  // KAFKA_ENABLED=false is the escape hatch: with no transport of its own the
  // dispatcher must not even try to open a socket (otherwise every payment would
  // spend `connectionTimeoutMs` failing to reach a broker nobody asked for).
  // An EXPLICITLY injected publisher opts back in - choosing the transport is a
  // separate decision from "is Kafka on for this application", and it is what
  // lets the test suite drive the full dispatch path without a broker.
  if (!options.publisher && !kafkaEnabled()) {
    return { scanned: 0, published: 0, failed: 0, deadLettered: 0, skipped: true };
  }

  const publisher = options.publisher ?? kafkaPublisher;

  if (inFlight) {
    return { scanned: 0, published: 0, failed: 0, deadLettered: 0, skipped: true };
  }
  inFlight = true;

  const result: OutboxDispatchResult = {
    scanned: 0,
    published: 0,
    failed: 0,
    deadLettered: 0,
    skipped: false,
  };

  try {
    // Only rows whose backoff has expired. A row waiting for `nextAttemptAt`
    // stays PENDING and untouched - it is not lost, it is scheduled.
    const now = new Date();
    const rows = await prisma.outboxEvent.findMany({
      where: {
        status: 'PENDING',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { id: 'asc' },
      take: limit,
    });
    result.scanned = rows.length;

    for (const row of rows) {
      const event = rowToEvent(row);
      const outcome = await publishWithRetryAccounting(publisher, event, row);
      if (outcome === 'published') result.published += 1;
      else if (outcome === 'dead') result.deadLettered += 1;
      else result.failed += 1;
    }

    if (rows.length > 0) {
      stats.dispatches += 1;
      stats.published += result.published;
      stats.failed += result.failed;
      stats.deadLettered += result.deadLettered;
      stats.lastDispatchAt = new Date().toISOString();
    }
    return result;
  } catch (err) {
    // A database problem is not an event problem: log and let the next tick
    // try again. The rows are still safely PENDING.
    const message = err instanceof Error ? err.message : String(err);
    outboxLogger.error('dispatch round failed', { error: message });
    return { ...result, skipped: false };
  } finally {
    inFlight = false;
  }
}

let inFlight = false;

/** Row shape the dispatcher needs to account for an attempt. */
interface OutboxRow {
  id: number;
  attempts: number;
  topic: string;
  eventType: string;
  eventId: string;
}

type AttemptOutcome = 'published' | 'retry' | 'dead';

/**
 * Publishes one row and records the outcome.
 *
 * Ordering matters here: PUBLISH FIRST, MARK SECOND. Marking first would make
 * "published" a claim rather than a fact, and a crash in between would lose the
 * event silently - the exact failure the outbox exists to prevent.
 */
async function publishWithRetryAccounting(
  publisher: Publisher,
  event: PublishableEvent<unknown>,
  row: OutboxRow
): Promise<AttemptOutcome> {
  const attempt = row.attempts + 1;
  const maxAttempts = config.kafka.outbox.maxAttempts;

  try {
    await publisher.publish({
      topic: row.topic,
      key: event.key,
      value: JSON.stringify(event.envelope),
      headers: envelopeHeaders(event.envelope),
    });

    // Conditional update: only "PENDING" rows transition. If another dispatcher
    // already published this row, this updates 0 rows and stays consistent.
    await prisma.outboxEvent.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        attempts: attempt,
        lastError: null,
        // Cleared so a future re-queue of the same aggregate/event never
        // inherits a stale schedule.
        nextAttemptAt: null,
      },
    });

    outboxLogger.info('event published', {
      topic: row.topic,
      eventType: row.eventType,
      eventId: row.eventId,
      attempt,
    });
    return 'published';
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const exhausted = attempt >= maxAttempts;
    const backoffMs = exhausted ? 0 : outboxBackoffMs(attempt);

    await prisma.outboxEvent
      .updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: {
          attempts: attempt,
          lastError: message,
          // Parked, not deleted: a DEAD row is evidence, and the alert that
          // fires on it should point at something with a full history.
          status: exhausted ? 'DEAD' : 'PENDING',
          // The schedule lives in the database, not in memory: it survives a
          // restart, and every process sharing the table sees the same one.
          nextAttemptAt: exhausted ? null : new Date(Date.now() + backoffMs),
        },
      })
      .catch(() => undefined); // never let bookkeeping mask the publish error

    outboxLogger.error(exhausted ? 'publish budget exhausted, row parked' : 'publish failed', {
      topic: row.topic,
      eventType: row.eventType,
      eventId: row.eventId,
      attempt,
      maxAttempts,
      backoffMs,
      error: message,
    });
    return exhausted ? 'dead' : 'retry';
  }
}

/**
 * Fire-and-forget dispatch, called right after a business transaction commits.
 *
 * Deliberately NOT awaited by the request path: the HTTP response must not wait
 * on the broker. If this round is skipped (one already running) or fails, the
 * interval dispatcher below still delivers the event - that timer, not this
 * call, is what makes delivery reliable.
 */
export function scheduleOutboxDispatch(): void {
  void dispatchOutbox().catch(() => undefined);
}

let dispatcherTimer: NodeJS.Timeout | undefined;

/**
 * Starts the background dispatcher (one timer per process).
 *
 * Safe to run in more than one process: duplicates are possible and expected;
 * consumers deduplicate on eventId.
 */
export function startOutboxDispatcher(): void {
  if (dispatcherTimer) return;
  const intervalMs = config.kafka.outbox.dispatchIntervalMs;
  dispatcherTimer = setInterval(() => {
    void dispatchOutbox().catch(() => undefined);
  }, intervalMs);
  // Do not hold the process open just to poll for events; an explicit shutdown
  // (or the HTTP server closing) decides when we stop.
  dispatcherTimer.unref?.();
  outboxLogger.info('dispatcher started', {
    intervalMs,
    batchSize: config.kafka.outbox.batchSize,
    maxAttempts: config.kafka.outbox.maxAttempts,
    retryBaseDelayMs: config.kafka.outbox.retryBaseDelayMs,
    retryMaxDelayMs: config.kafka.outbox.retryMaxDelayMs,
  });
}

export function stopOutboxDispatcher(): void {
  if (!dispatcherTimer) return;
  clearInterval(dispatcherTimer);
  dispatcherTimer = undefined;
  outboxLogger.info('dispatcher stopped');
}

/** Backlog size, surfaced on /api/health. Never throws. */
export async function countPendingOutboxEvents(): Promise<number> {
  try {
    return await prisma.outboxEvent.count({ where: { status: 'PENDING' } });
  } catch {
    return -1; // unknown, e.g. the database is the thing that is broken
  }
}

/** Dead rows (gave up after maxAttempts), surfaced on /api/health. */
export async function countDeadOutboxEvents(): Promise<number> {
  try {
    return await prisma.outboxEvent.count({ where: { status: 'DEAD' } });
  } catch {
    return -1;
  }
}


