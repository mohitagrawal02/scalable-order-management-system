/**
 * Kafka infrastructure barrel (Day 7).
 *
 * Consumers import from here so the file layout inside
 * `src/infrastructure/kafka/` stays an implementation detail:
 *
 *   - `topics`    → the published topic catalogue (names, partitions, retention)
 *   - `envelope`  → the generic event envelope: shape, parsing, Kafka headers
 *   - `events`    → the concrete domain events (OrderPaid, PaymentFailed)
 *   - `client`    → broker connection, topic provisioning, health probe
 *   - `producer`  → publishing (never throws; failures stay in the outbox)
 *   - `consumer`  → at-least-once consumption: manual commits, retries, DLQ
 *   - `outbox`    → DB-to-Kafka delivery: enqueue in a transaction + dispatcher
 */
export { TOPICS, TOPIC_DEFINITIONS, ALL_TOPICS, isKnownTopic, type TopicName } from './topics';
export {
  AGGREGATE_TYPES,
  EVENT_ENVELOPE_VERSION,
  EVENT_TYPES,
  createEnvelope,
  envelopeHeaders,
  isEventEnvelope,
  parseEnvelope,
  type AggregateType,
  type EnvelopeInput,
  type EventEnvelope,
  type EventType,
} from './envelope';
export {
  EVENT_AGGREGATE_TYPES,
  PAYMENT_PRODUCER,
  buildOrderPaidEvent,
  buildPaymentFailedEvent,
  isPublishedEventType,
  type BuildOrderPaidInput,
  type BuildPaymentFailedInput,
  type OrderPaidPayload,
  type PaymentFailedPayload,
  type PublishableEvent,
} from './events';
export {
  brokerSummary,
  closeKafkaAdmin,
  describeTopicPartitions,
  ensureTopics,
  kafka,
  pingKafka,
  type TopicProvisionResult,
} from './client';
export {
  connectProducer,
  disconnectProducer,
  getProducerStats,
  kafkaEnabled,
  kafkaPublisher,
  publishEvent,
  publishWith,
  resetProducerStats,
  serializeEnvelope,
  type ProducerStats,
  type PublishInput,
  type PublishResult,
  type Publisher,
} from './producer';
export {
  DEFAULT_NOTIFICATION_DLQ,
  PermanentEventError,
  startEventConsumer,
  type ConsumedEvent,
  type EventHandler,
  type RunningConsumer,
  type StartConsumerOptions,
} from './consumer';
export {
  countDeadOutboxEvents,
  countPendingOutboxEvents,
  dispatchOutbox,
  enqueueOutboxEvent,
  getOutboxStats,
  resetOutboxStats,
  scheduleOutboxDispatch,
  startOutboxDispatcher,
  stopOutboxDispatcher,
  type OutboxDispatchResult,
  type OutboxPublisher,
  type OutboxStats,
} from './outbox';
