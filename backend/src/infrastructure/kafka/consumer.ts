import { Consumer, KafkaMessage } from 'kafkajs';
import { config } from '../../config';
import { getLogger, runWithLogContext } from '../logging';
import { kafka, brokerSummary } from './client';
import { parseEnvelope, type EventEnvelope } from './envelope';
import { kafkaPublisher, type Publisher } from './producer';
import { TOPICS } from './topics';

/** Structured logger for this module (Day 8). */
const consumerLogger = getLogger({ module: 'kafka-consumer' });

/**
 * Consumer counters, composed into `/api/metrics` (Day 8).
 *
 * `retried` and `deadLettered` are the two that earn their place: a rising
 * retry rate is a dependency getting flaky long before anything fails loudly,
 * and `deadLettered > 0` always means a human has to look at a message.
 */
export interface ConsumerStats {
  consumed: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
  malformed: number;
  lastEventAt: string | null;
  lastError: string | null;
}

const consumerStats: ConsumerStats = {
  consumed: 0,
  succeeded: 0,
  retried: 0,
  deadLettered: 0,
  malformed: 0,
  lastEventAt: null,
  lastError: null,
};

export function getConsumerStats(): ConsumerStats {
  return { ...consumerStats };
}

export function resetConsumerStats(): void {
  consumerStats.consumed = 0;
  consumerStats.succeeded = 0;
  consumerStats.retried = 0;
  consumerStats.deadLettered = 0;
  consumerStats.malformed = 0;
  consumerStats.lastEventAt = null;
  consumerStats.lastError = null;
}

/**
 * Backoff between consumer retries: exponential, capped, with jitter.
 *
 * Day 7 retried on a FIXED 250ms delay. That is fine for one message and wrong
 * for a thousand: when a dependency (MySQL, the broker) goes down, every
 * partition on every instance retries in lockstep, hitting the thing that is
 * already struggling. Exponential growth spaces the attempts out; the jitter
 * (±25%) stops independent workers from re-synchronising.
 *
 * The budget stays bounded (`maxAttempts`, default 3), so this only ever
 * delays a retry - it cannot turn into an unbounded retry loop.
 */
export function consumerBackoffMs(
  attempt: number,
  baseMs = config.kafka.consumerRetryDelayMs,
  maxMs = config.kafka.consumerRetryMaxDelayMs
): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(exponential * jitter);
}


/**
 * Generic idempotency-aware Kafka consumer (Day 7).
 *
 * DELIVERY CONTRACT: AT-LEAST-ONCE
 * --------------------------------
 * Offsets are committed MANUALLY, and only AFTER the handler resolves
 * (`autoCommit: false`). Concretely: process → commit. If the process dies
 * between those two steps the message is redelivered, so the handler may run
 * twice for one event. That is the deal you make with Kafka, and the correct
 * response is not "prevent redelivery" (impossible across a process boundary)
 * but "make the handler idempotent" - which is why every event carries an
 * `eventId` and the notification handler records it in `processed_events`
 * (docs/KAFKA.md §5).
 *
 * Auto-commit would be the opposite trade: fast, and it can silently DROP an
 * event whose handler then failed. Losing a customer's payment notification is
 * not an acceptable failure mode, so we take the duplicate instead.
 *
 * WHY THE HANDLER CAN NEVER THROW OUT OF `eachMessage`
 * ---------------------------------------------------
 * If it did, KafkaJS would stop processing that partition - one poison message
 * would silently freeze all notifications behind it. Every message therefore
 * ends in exactly one of three places:
 *   1. handled                        → offset committed
 *   2. retried, then dead-lettered    → offset committed (the DLQ now owns it)
 *   3. unparseable / permanently bad  → dead-lettered immediately
 *
 * That third case exists so a corrupt message does not spend the retry budget
 * of every good message behind it. `PermanentEventError` is how a handler says
 * "retrying this will never help".
 */

/** Thrown by a handler when retrying the message cannot possibly succeed. */
export class PermanentEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentEventError';
  }
}

/** Everything a handler needs about the message it is processing. */
export interface ConsumedEvent {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  headers: Record<string, string>;
  envelope: EventEnvelope;
  /** 1 for the first attempt, 2 for the first retry, ... */
  attempt: number;
}

export type EventHandler = (event: ConsumedEvent) => Promise<void>;

export interface StartConsumerOptions {
  /** Also used as the log prefix and the error-message prefix. */
  name: string;
  groupId: string;
  topics: string[];
  handler: EventHandler;
  /** Where messages go after the retry budget is exhausted. */
  deadLetterTopic: string;
  /** Replay the whole log on first join (default false: only new events). */
  fromBeginning?: boolean;
  maxAttempts?: number;
  /** Base delay for the first retry (grows exponentially from here). */
  retryDelayMs?: number;
  /** Ceiling for the exponential retry backoff. */
  retryMaxDelayMs?: number;
  /** Overridable so tests can assert DLQ publishing without a real broker. */
  publisher?: Publisher;
}

export interface RunningConsumer {
  name: string;
  groupId: string;
  topics: string[];
  stop(): Promise<void>;
}

/**
 * One structured log line per message outcome (Day 8).
 *
 * These were `console.log` with the fields interpolated into the string. They
 * now go through the shared logger, so each outcome is a JSON object that a log
 * store can filter on (`eventId`, `group`, `attempt`, `error`) instead of a line
 * that has to be regex-parsed. The caller's AsyncLocalStorage context adds the
 * eventId automatically where one applies.
 */
function log(message: string, fields: Record<string, unknown> = {}): void {
  consumerLogger.info(message, fields);
}

function logError(message: string, fields: Record<string, unknown> = {}): void {
  consumerLogger.error(message, fields);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headerToString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function headersToRecord(message: KafkaMessage): Record<string, string> {
  const raw = message.headers ?? {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    // KafkaJS can hand back arrays when a header appears more than once.
    out[key] = Array.isArray(value) ? value.map(headerToString).join(',') : headerToString(value);
  }
  return out;
}

/**
 * The dead-letter record: the original bytes, plus everything an operator needs
 * to understand WHY it is here. Without the diagnostics a DLQ is just a
 * graveyard; with them it is a work queue you can replay after a fix.
 */
interface DeadLetterRecord {
  /** Which consumer group abandoned it. */
  consumerGroup: string;
  originalTopic: string;
  originalPartition: number;
  originalOffset: string;
  originalKey: string | null;
  attempts: number;
  error: string;
  failedAt: string;
  /** The untouched envelope, so the message can be replayed verbatim. */
  event: EventEnvelope | null;
  /** Raw payload when the envelope itself could not be parsed. */
  rawValue: string | null;
}

async function deadLetter(
  publisher: Publisher,
  options: { consumerGroup: string; deadLetterTopic: string },
  record: DeadLetterRecord
): Promise<boolean> {
  try {
    await publisher.publish({
      topic: options.deadLetterTopic,
      // Same key as the original: dead letters about one order stay together
      // and in order, which matters when replaying them by hand.
      key: record.originalKey ?? `unkeyed-${record.originalOffset}`,
      value: JSON.stringify(record),
      headers: {
        deadLetter: 'true',
        consumerGroup: record.consumerGroup,
        originalTopic: record.originalTopic,
        attempts: String(record.attempts),
        error: record.error.slice(0, 200),
      },
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Publishing the failure failed. The offset is still committed (retrying
    // the handler forever is worse), so this is loud on purpose.
    logError(
      `DLQ publish FAILED group=${options.consumerGroup} topic=${options.deadLetterTopic} ` +
        `error="${message}" original=${record.originalTopic}/${record.originalOffset}`
    );
    return false;
  }
}

/**
 * Starts a consumer group for `options.topics` and runs `options.handler` for
 * every message. Resolves once the consumer is running (so the caller knows the
 * group has joined), and returns a handle that stops it gracefully.
 */
export async function startEventConsumer(
  options: StartConsumerOptions
): Promise<RunningConsumer> {
  const {
    name,
    groupId,
    topics,
    handler,
    deadLetterTopic,
    fromBeginning = false,
    maxAttempts = config.kafka.consumerMaxAttempts,
    retryDelayMs = config.kafka.consumerRetryDelayMs,
    retryMaxDelayMs = config.kafka.consumerRetryMaxDelayMs,
    publisher = kafkaPublisher,
  } = options;

  const consumer: Consumer = kafka.consumer({
    groupId,
    // A worker handles a handful of small events per second; short sessions
    // mean a crashed worker's partitions are picked up quickly by another.
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
  });

  await consumer.connect();
  await consumer.subscribe({ topics, fromBeginning });

  await consumer.run({
    // Manual commits: the offset advances only after the handler succeeded.
    autoCommit: false,
    eachMessage: async ({ topic, partition, message, heartbeat }) => {
      const offset = message.offset;
      const key = message.key === null ? null : message.key.toString();
      const headers = headersToRecord(message);
      const rawValue = message.value === null ? null : message.value.toString('utf8');
      const envelope = parseEnvelope(message.value);

      const commit = async (): Promise<void> => {
        // Kafka stores "the NEXT offset to read", hence +1.
        await consumer.commitOffsets([
          { topic, partition, offset: (Number(offset) + 1).toString() },
        ]);
      };

      // --- Case 3: not a valid envelope at all -> DLQ immediately ----------
      if (envelope === null) {
        // Counted separately from handler failures: an unparseable message is a
        // producer/serialization bug, not a flaky dependency, and the two need
        // different responses.
        consumerStats.malformed += 1;
        logError('malformed message dead-lettered', {
          group: groupId,
          topic,
          partition,
          offset,
          bytes: rawValue?.length ?? 0,
        });
        await deadLetter(
          publisher,
          { consumerGroup: groupId, deadLetterTopic },
          {
            consumerGroup: groupId,
            originalTopic: topic,
            originalPartition: partition,
            originalOffset: offset,
            originalKey: key,
            attempts: 0,
            error: 'Message is not a valid event envelope',
            failedAt: new Date().toISOString(),
            event: null,
            rawValue,
          }
        );
        await heartbeat();
        await commit();
        return;
      }

      // --- Cases 1 & 2: handle, retrying transient failures ---------------
      let lastError = 'Unknown error';
      let permanent = false;

      // Every log written by the handler - and by anything it calls - carries
      // this event's id without a single extra parameter. That is what makes a
      // background worker debuggable: see infrastructure/logging/context.ts.
      const eventContext = {
        eventId: envelope.eventId,
        correlationId: envelope.correlationId,
        consumerGroup: groupId,
      };

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await runWithLogContext(eventContext, () =>
            handler({ topic, partition, offset, key, headers, envelope, attempt })
          );

          consumerStats.succeeded += 1;
          consumerStats.lastEventAt = new Date().toISOString();

          if (attempt > 1) {
            log('recovered after retry', {
              eventType: envelope.eventType,
              topic,
              partition,
              offset,
              attempt,
            });
          }
          // Heartbeat before committing: if the group rebalanced mid-handler
          // the commit would throw, and we would rather know.
          await heartbeat();
          await commit();
          return;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          consumerStats.lastError = lastError;

          if (err instanceof PermanentEventError) {
            // A permanent failure must not spend the retry budget: retrying
            // cannot help, and the delays would hold up the partition behind a
            // message that will never succeed.
            permanent = true;
            break;
          }

          if (attempt < maxAttempts) {
            consumerStats.retried += 1;
            // Exponential backoff with jitter (Day 8): fixed-delay retries
            // re-synchronise every worker the moment a dependency degrades.
            const backoffMs = consumerBackoffMs(attempt, retryDelayMs, retryMaxDelayMs);
            log('handler failed, retrying', {
              eventType: envelope.eventType,
              topic,
              partition,
              offset,
              attempt,
              maxAttempts,
              backoffMs,
              error: lastError,
            });
            await sleep(backoffMs);
          }
        }
      }

      consumerStats.deadLettered += 1;
      logError('giving up, dead-lettering message', {
        group: groupId,
        topic,
        partition,
        offset,
        eventType: envelope.eventType,
        attempts: permanent ? 1 : maxAttempts,
        permanent,
        error: lastError,
      });

      await deadLetter(
        publisher,
        { consumerGroup: groupId, deadLetterTopic },
        {
          consumerGroup: groupId,
          originalTopic: topic,
          originalPartition: partition,
          originalOffset: offset,
          originalKey: key,
          attempts: permanent ? 1 : maxAttempts,
          error: permanent ? `${lastError} (permanent)` : lastError,
          failedAt: new Date().toISOString(),
          event: envelope,
          rawValue: null,
        }
      );

      // Committed either way: the DLQ owns the message now. Leaving the offset
      // uncommitted would replay the poison message forever and block the
      // partition behind it.
      await heartbeat();
      await commit();
    },
  });

  log(`started name=${name} group=${groupId} topics=[${topics.join(',')}] dlq=${deadLetterTopic}`);

  return {
    name,
    groupId,
    topics,
    async stop(): Promise<void> {
      try {
        await consumer.disconnect();
        log(`stopped name=${name} group=${groupId}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`stop failed name=${name} error="${message}"`);
      }
    },
  };
}

/** The DLQ a consumer group writes to (kept in one place for the worker/tests). */
export const DEFAULT_NOTIFICATION_DLQ = TOPICS.NOTIFICATION_DLQ;

/** Broker summary is re-exported so the worker can log where it connected. */
export { brokerSummary };


