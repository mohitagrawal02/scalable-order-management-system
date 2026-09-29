import { TOPICS, type TopicName } from './topics';
import {
  createEnvelope,
  type EventEnvelope,
  type EventType,
  type AggregateType,
} from './envelope';

/**
 * The domain events this system publishes today (Day 7).
 *
 * WHY ONE EXPLICIT PAYLOAD PER EVENT, NOT ONE GENERIC "MESSAGE"
 * ------------------------------------------------------------
 * A generic `{ type: 'SomethingChanged', data: {...} }` event looks flexible
 * and is a trap: the payload becomes untyped, consumers must defensively probe
 * for fields, and nobody can answer "what does an OrderPaid look like?"
 * without reading every producer. Explicit payload interfaces make the event an
 * API - reviewable, versioned, and enforced by the compiler.
 *
 * WHY ONLY TWO EVENTS
 * -------------------
 * These are the two facts that currently have a real asynchronous consumer
 * (notifications). Adding `OrderCreated`, `CartAbandoned`, ... before anything
 * consumes them would be speculative plumbing - see docs/KAFKA.md §3.
 *
 * WHAT IS IN A PAYLOAD (and what is not)
 * --------------------------------------
 * Envelope + payload must let the consumer act WITHOUT calling back into the
 * producing module, so they carry exactly what the notification needs (ids,
 * order number, amount, reason). They deliberately carry NO email, name,
 * address or token: `userId` is an internal numeric key - enough to write the
 * row, useless for identity theft from a log dump.
 */

/** Producer identity recorded on every event this module emits. */
export const PAYMENT_PRODUCER = 'payments';

export interface OrderPaidPayload {
  paymentId: number;
  orderId: number;
  orderNumber: string;
  /** Owner of the order - the consumer needs it to address the notification. */
  userId: number;
  /** Decimal money as a STRING (never a float - see docs/ORDERS.md). */
  totalAmount: string;
  currency: string;
  /** Payment method, useful for support and fraud review. */
  method: string;
  /** When the payment reached SUCCEEDED (ISO-8601). */
  paidAt: string;
}

export interface PaymentFailedPayload {
  paymentId: number;
  orderId: number;
  orderNumber: string;
  userId: number;
  amount: string;
  currency: string;
  method: string;
  /** Why it failed, already truncated to the DB column's limit. */
  reason: string;
  /** Which attempt this was (retries reuse one payment row). */
  attemptCount: number;
  /** Where the order went back to: PENDING means it can be paid again. */
  orderStatus: string;
}

/**
 * A fully-formed message, ready to be stored in the outbox and published.
 *
 * Why bundle topic + key + envelope? Because choosing them is a DECISION, and
 * it should be made once, next to the event definition, rather than at every
 * call site. The infrastructure layer can then treat every event uniformly.
 */
export interface PublishableEvent<TPayload = Record<string, unknown>> {
  topic: TopicName;
  /** Kafka message key. See the ordering note below. */
  key: string;
  envelope: EventEnvelope<TPayload>;
}

/**
 * ORDERING RULE (the reason `key` is not simply the aggregateId)
 * -------------------------------------------------------------
 * Kafka only guarantees order WITHIN a partition, and the partition is derived
 * from the key. So the key must be "the thing whose events must never be
 * reordered relative to each other" - and for notification purposes that thing
 * is the ORDER, not the payment. One order can produce `PaymentFailed` and later
 * `OrderPaid` (after a retry); if those landed on different partitions the user
 * could be told "payment succeeded" before "payment failed".
 *
 * `aggregateType`/`aggregateId` still describe the precise subject of the event
 * (the payment, for PaymentFailed). Key and aggregate are intentionally
 * different concepts - conflating them is a classic Kafka bug.
 */
function orderPartitionKey(orderId: number): string {
  return `order-${orderId}`;
}

export interface BuildOrderPaidInput {
  paymentId: number;
  orderId: number;
  orderNumber: string;
  userId: number;
  totalAmount: string;
  currency: string;
  method: string;
  paidAt: Date;
  /** Reuse to keep every event of one request under one trace id. */
  correlationId?: string;
}

/** Builds the `OrderPaid` event published after an order reaches PAID. */
export function buildOrderPaidEvent(input: BuildOrderPaidInput): PublishableEvent<OrderPaidPayload> {
  return {
    topic: TOPICS.ORDER_EVENTS,
    key: orderPartitionKey(input.orderId),
    envelope: createEnvelope<OrderPaidPayload>({
      eventType: 'OrderPaid',
      aggregateType: 'Order',
      aggregateId: input.orderId,
      partitionKey: orderPartitionKey(input.orderId),
      producer: PAYMENT_PRODUCER,
      correlationId: input.correlationId,
      occurredAt: input.paidAt,
      payload: {
        paymentId: input.paymentId,
        orderId: input.orderId,
        orderNumber: input.orderNumber,
        userId: input.userId,
        totalAmount: input.totalAmount,
        currency: input.currency,
        method: input.method,
        paidAt: input.paidAt.toISOString(),
      },
    }),
  };
}

export interface BuildPaymentFailedInput {
  paymentId: number;
  orderId: number;
  orderNumber: string;
  userId: number;
  amount: string;
  currency: string;
  method: string;
  reason: string;
  attemptCount: number;
  orderStatus: string;
  failedAt: Date;
  correlationId?: string;
}

/** Builds the `PaymentFailed` event published after an order returns to PENDING. */
export function buildPaymentFailedEvent(
  input: BuildPaymentFailedInput
): PublishableEvent<PaymentFailedPayload> {
  return {
    topic: TOPICS.PAYMENT_EVENTS,
    key: orderPartitionKey(input.orderId),
    envelope: createEnvelope<PaymentFailedPayload>({
      eventType: 'PaymentFailed',
      aggregateType: 'Payment',
      aggregateId: input.paymentId,
      partitionKey: orderPartitionKey(input.orderId),
      producer: PAYMENT_PRODUCER,
      correlationId: input.correlationId,
      occurredAt: input.failedAt,
      payload: {
        paymentId: input.paymentId,
        orderId: input.orderId,
        orderNumber: input.orderNumber,
        userId: input.userId,
        amount: input.amount,
        currency: input.currency,
        method: input.method,
        reason: input.reason,
        attemptCount: input.attemptCount,
        orderStatus: input.orderStatus,
      },
    }),
  };
}

/** Runtime guard for the event types this module publishes. */
export function isPublishedEventType(eventType: string): eventType is EventType {
  return eventType === 'OrderPaid' || eventType === 'PaymentFailed';
}

/** Event type → aggregate type, for consumers that want to validate pairing. */
export const EVENT_AGGREGATE_TYPES: Readonly<Record<EventType, AggregateType>> = {
  OrderPaid: 'Order',
  PaymentFailed: 'Payment',
};

