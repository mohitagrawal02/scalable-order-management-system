import { Consumer, KafkaMessage } from 'kafkajs';
import { config } from '../../config';
import { kafka, brokerSummary } from './client';
import { parseEnvelope, type EventEnvelope } from './envelope';
import { kafkaPublisher, type Publisher } from './producer';
import { TOPICS } from './topics';

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
  retryDelayMs?: number;
  /** Overridable so tests can assert DLQ publishing without a real broker. */
  publisher?: Publisher;
}

export interface RunningConsumer {
  name: string;
  groupId: string;
  topics: string[];
  stop(): Promise<void>;
}

/** Structured single-line log, one per message outcome. */
function log(message: string): void {
  console.log(`[kafka-consumer] ${message}`);
}

function logError(message: string): void {
  console.error(`[kafka-consumer] ${message}`);
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
        logError(
          `malformed message group=${groupId} topic=${topic} partition=${partition} offset=${offset}`
        );
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

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await handler({
            topic,
            partition,
            offset,
            key,
            headers,
            envelope,
            attempt,
          });
          if (attempt > 1) {
            log(`recovered eventType=${envelope.eventType} eventId=${envelope.eventId} attempt=${attempt}`);
          }
          // Heartbeat before committing: if the group rebalanced mid-handler
          // the commit would throw, and we would rather know.
          await heartbeat();
          await commit();
          return;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          if (err instanceof PermanentEventError) {
            permanent = true;
            break;
          }
          if (attempt < maxAttempts) {
            // Backoff gives a restarted database/broker a chance to recover
            // before we burn the whole budget in a few milliseconds.
            await sleep(retryDelayMs);
          }
        }
      }

      logError(
        `giving up group=${groupId} topic=${topic} offset=${offset} ` +
          `eventType=${envelope.eventType} eventId=${envelope.eventId} ` +
          `attempts=${permanent ? 1 : maxAttempts} error="${lastError}"`
      );

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


