/**
 * Topic catalogue (Day 7).
 *
 * WHY A SINGLE FILE
 * -----------------
 * Topic names are a PUBLISHED INTERFACE: producers, consumers, dashboards and
 * runbooks all have to agree on them. A string literal typed into a `produce()`
 * call is a typo waiting to become a silently-empty topic, so every name lives
 * here as a constant and everything else imports from this module.
 *
 * WHY SO FEW TOPICS
 * -----------------
 * A topic is not a queue per operation - it is a partitioned, retained,
 * replayable log. The useful axis to split on is *who consumes it and how*,
 * not "one topic per event name". There are exactly two domain topics here
 * (orders, payments) plus one dead-letter topic for the notification consumer
 * group. Anything more would be speculative - see docs/KAFKA.md §3.
 */
export const TOPICS = {
  /** Domain facts about orders. Consumed by the notification worker. */
  ORDER_EVENTS: 'order.events',
  /** Domain facts about payments. Consumed by the notification worker. */
  PAYMENT_EVENTS: 'payment.events',
  /**
   * Messages the notification consumer could not process after its retry
   * budget. Named after the CONSUMER GROUP, not the source topic: a dead
   * letter is "this consumer gave up", and different consumers of the same
   * topic have different failure modes.
   */
  NOTIFICATION_DLQ: 'notification-service.dlq',
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

export interface TopicDefinition {
  name: TopicName;
  /** Parallelism ceiling for consumers, and the unit of ordering. */
  partitions: number;
  /** 1 on a single-broker dev setup; production replicas per durability needs. */
  replicationFactor: number;
  /** How long the log keeps messages, in ms. */
  retentionMs: number;
  /** Why this topic exists - one sentence, no jargon. */
  purpose: string;
  /** Consumer group(s) expected to read it, or null for write-only logs. */
  consumedBy: string | null;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

export const TOPIC_DEFINITIONS: readonly TopicDefinition[] = [
  {
    name: TOPICS.ORDER_EVENTS,
    // 3 partitions is enough to demonstrate that ordering is per KEY, not
    // global: two events for the same order must land on the same partition.
    partitions: 3,
    replicationFactor: 1,
    retentionMs: SEVEN_DAYS_MS,
    purpose: 'Order lifecycle facts (e.g. OrderPaid) that other components react to.',
    consumedBy: 'notification-service',
  },
  {
    name: TOPICS.PAYMENT_EVENTS,
    partitions: 3,
    replicationFactor: 1,
    retentionMs: SEVEN_DAYS_MS,
    purpose: 'Payment lifecycle facts (e.g. PaymentFailed) that other components react to.',
    consumedBy: 'notification-service',
  },
  {
    name: TOPICS.NOTIFICATION_DLQ,
    // One partition: dead letters are low volume and must stay in the order
    // they failed, so they can be replayed by hand in sequence.
    partitions: 1,
    replicationFactor: 1,
    // Retained longer than the source topics: a poison message is a bug
    // report, and bug reports are useless if they expire before anyone looks.
    retentionMs: THIRTY_DAYS_MS,
    purpose: 'Messages the notification consumer gave up on, kept for inspection and replay.',
    consumedBy: null,
  },
] as const;

/** Every topic the application expects to exist. Declared, never accidental. */
export const ALL_TOPICS: readonly TopicName[] = TOPIC_DEFINITIONS.map((t) => t.name);

export function isKnownTopic(name: string): name is TopicName {
  return (ALL_TOPICS as readonly string[]).includes(name);
}
