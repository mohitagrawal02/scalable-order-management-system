import { Producer } from 'kafkajs';
import { config } from '../../config';
import { kafka, brokerSummary } from './client';
import { envelopeHeaders, type EventEnvelope } from './envelope';
import type { PublishableEvent } from './events';

/**
 * Kafka producer (Day 7).
 *
 * THE ONE RULE: publishing NEVER throws into the caller.
 * -----------------------------------------------------
 * This is not defensive coding for its own sake - it is the whole contract that
 * lets the API stay responsive when the broker is unavailable. Callers get
 * `{ published: false, error }`, the event stays PENDING in the MySQL outbox,
 * and the background dispatcher retries it. See docs/KAFKA.md §6-7.
 *
 * DELIVERY SEMANTICS CHOSEN HERE
 * ------------------------------
 *   acks = -1 (all)     the broker must have accepted the record before we call
 *                       it published, so a "published" outbox row is not a lie.
 *   idempotent = true   the producer sequence number lets the broker discard a
 *                       retry that already succeeded, so a network blip does
 *                       not duplicate a message at the source.
 *
 * Even with both, delivery is still AT-LEAST-ONCE end to end: a crash between
 * "broker stored it" and "we marked the outbox row published" republishes on
 * the next dispatch. That duplicate is expected and is absorbed by consumer
 * idempotency (docs/KAFKA.md §5) - the producer cannot fix it, and pretending
 * otherwise is how "exactly-once" fairy tales start.
 */

/** The transport shape the outbox dispatcher depends on (injectable for tests). */
export interface PublishInput {
  topic: string;
  key: string;
  /** Already-serialized JSON envelope. */
  value: string;
  headers: Record<string, string>;
}

export interface Publisher {
  publish(input: PublishInput): Promise<void>;
}

export interface ProducerStats {
  published: number;
  publishFailures: number;
  /** Send calls that had to open a connection first (lazy connect). */
  connects: number;
  lastError: string | null;
  lastPublishedAt: string | null;
}

const stats: ProducerStats = {
  published: 0,
  publishFailures: 0,
  connects: 0,
  lastError: null,
  lastPublishedAt: null,
};

export function getProducerStats(): ProducerStats {
  return { ...stats };
}

export function resetProducerStats(): void {
  stats.published = 0;
  stats.publishFailures = 0;
  stats.connects = 0;
  stats.lastError = null;
  stats.lastPublishedAt = null;
}

let producer: Producer | undefined;
let producerConnect: Promise<Producer> | undefined;

/**
 * Lazily connects the shared producer.
 *
 * A failed connect clears the cached promise so the next attempt starts fresh -
 * otherwise a broker that was down at boot would be remembered as "down
 * forever" by this process.
 */
async function getProducer(): Promise<Producer> {
  if (producer) return producer;
  if (!producerConnect) {
    const candidate = kafka.producer({
      // Idempotent producer: requires in-flight requests to be serialized.
      idempotent: true,
      maxInFlightRequests: 1,
      // Fail rather than let a typo'd topic silently come into existence.
      allowAutoTopicCreation: false,
      retry: { retries: 2, initialRetryTime: 200, maxRetryTime: 1_000 },
    });
    producerConnect = candidate
      .connect()
      .then(() => {
        producer = candidate;
        stats.connects += 1;
        console.log(`[kafka] producer connected brokers=${brokerSummary()}`);
        return candidate;
      })
      .catch((err: unknown) => {
        producerConnect = undefined;
        void candidate.disconnect().catch(() => undefined);
        throw err;
      });
  }
  return producerConnect;
}

/** Real broker transport. The only place `producer.send` is called. */
export const kafkaPublisher: Publisher = {
  async publish(input: PublishInput): Promise<void> {
    const client = await getProducer();
    await client.send({
      topic: input.topic,
      acks: -1,
      // One message per call: the outbox batches at its own level, and
      // per-message sends keep a failure attributable to a single event.
      messages: [{ key: input.key, value: input.value, headers: input.headers }],
    });
  },
};

export interface PublishResult {
  published: boolean;
  error?: string;
}

/**
 * Publishes one fully-formed event. Never throws - see the rule at the top.
 *
 * This is NOT called from request handlers: the outbox dispatcher owns it. The
 * consumer's dead-letter path uses it too, so a busy worker keeps publishing
 * without going through the database.
 */
export async function publishEvent(event: PublishableEvent<unknown>): Promise<PublishResult> {
  return publishWith(kafkaPublisher, event);
}

/** Same contract as publishEvent(), against an injected transport. */
export async function publishWith(
  publisher: Publisher,
  event: PublishableEvent<unknown>
): Promise<PublishResult> {
  const { topic, key, envelope } = event;
  try {
    await publisher.publish({
      topic,
      key,
      value: serializeEnvelope(envelope),
      headers: envelopeHeaders(envelope),
    });
    stats.published += 1;
    stats.lastPublishedAt = new Date().toISOString();
    return { published: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stats.publishFailures += 1;
    stats.lastError = message;
    console.error(
      `[kafka] publish failed topic=${topic} eventType=${envelope.eventType} ` +
        `eventId=${envelope.eventId} error="${message}"`
    );
    return { published: false, error: message };
  }
}

/** Serializes an envelope exactly as the producer does (used by the outbox). */
export function serializeEnvelope(envelope: EventEnvelope<unknown>): string {
  return JSON.stringify(envelope);
}

/** Confirms the producer can actually reach the broker (used by the worker). */
export async function connectProducer(): Promise<boolean> {
  try {
    await getProducer();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[kafka] producer connect failed brokers=${brokerSummary()} error="${message}"`);
    return false;
  }
}

/** Flushes in-flight sends and closes the producer socket. */
export async function disconnectProducer(): Promise<void> {
  const client = producer;
  producer = undefined;
  producerConnect = undefined;
  if (!client) return;
  try {
    await client.disconnect();
  } catch {
    // Socket already gone - nothing to release.
  }
}

/** True when the master switch allows Kafka usage at all. */
export function kafkaEnabled(): boolean {
  return config.kafka.enabled;
}

