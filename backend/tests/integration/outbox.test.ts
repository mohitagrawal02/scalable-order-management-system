/**
 * Day 7 - transactional outbox, consumer idempotency, and the health surface.
 *
 * These tests are the ones Day 5 could not express, because on Day 5 the
 * notification was written by the payment transaction itself. They cover the
 * four things that now have to be true separately:
 *
 *   ATOMICITY      the outbox row is committed with the business change, or
 *                  not at all;
 *   DELIVERY       the dispatcher publishes the stored envelope and marks it,
 *                  and never loses it when publishing fails;
 *   CONSUMPTION    the consumer is idempotent and dead-letters poison messages
 *                  instead of retrying them forever;
 *   VISIBILITY     /api/health reports the backlog without letting Kafka
 *                  decide whether the API is healthy.
 *
 * Everything except the consumer-flow test runs WITHOUT a broker: the
 * `Publisher` seam in producer.ts is what makes that possible.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { config } from '../../src/config';
import { prisma } from '../../src/config/prisma';
import {
  buildOrderPaidEvent,
  buildPaymentFailedEvent,
  enqueueOutboxEvent,
  parseEnvelope,
  PermanentEventError,
  serializeEnvelope,
  type ConsumedEvent,
  type EventEnvelope,
} from '../../src/infrastructure/kafka';
import { handleDomainEvent } from '../../src/modules/notifications/notification.consumer';
import {
  api,
  cleanupTestData,
  createProduct,
  deleteOutboxRows,
  deliverOutboxEvents,
  dispatchWithRecording,
  registerAdmin,
  registerUser,
  startTestServer,
  stopTestServer,
  TestProduct,
  TestUser,
} from './helpers';

const ADDRESS = '221B Baker Street, London';

interface HealthBody {
  status: string;
  database: string;
  kafka: {
    status: string;
    pendingEvents: number;
    deadEvents: number;
    published: number;
    impact: string;
  };
}

let keySeq = 0;
const key = (label: string) => `kafka-test-${label}-${++keySeq}-${Date.now()}`;

/** Event ids this suite created directly (not tied to a real order). */
const scratchEventIds: string[] = [];

/**
 * A well-formed OrderPaid event. Nothing here needs a real payment: the outbox
 * stores bytes, and the dispatcher only needs the row. The consumer tests build
 * their own events on top of a real order instead.
 */
function orderPaidEvent(overrides: Partial<Parameters<typeof buildOrderPaidEvent>[0]> = {}) {
  return buildOrderPaidEvent({
    paymentId: 9001,
    orderId: 4242,
    orderNumber: 'ORD-SCRATCH',
    userId: 4242,
    totalAmount: '10.00',
    currency: 'GBP',
    method: 'card',
    paidAt: new Date(),
    ...overrides,
  });
}

/** Puts one event in the outbox and remembers it for cleanup. */
async function enqueueScratch(event = orderPaidEvent()): Promise<string> {
  await prisma.$transaction((tx) => enqueueOutboxEvent(tx, event));
  scratchEventIds.push(event.envelope.eventId);
  return event.envelope.eventId;
}

async function readRow(eventId: string) {
  return prisma.outboxEvent.findUnique({ where: { eventId } });
}

/** Wraps an envelope as the shape the consumer receives. */
function consumed(envelope: EventEnvelope, topic = 'order.events'): ConsumedEvent {
  return {
    topic,
    partition: 0,
    offset: '0',
    key: envelope.partitionKey,
    headers: {},
    envelope,
    attempt: 1,
  };
}

/** Adds an item to the cart and checks out (Day-4 flow). */
async function checkout(
  user: TestUser,
  productId: number,
  quantity: number
): Promise<{ id: number }> {
  await api('POST', '/api/cart/items', { token: user.token, body: { productId, quantity } });
  const res = await api<{ order: { id: number } }>('POST', '/api/orders', {
    token: user.token,
    body: { shippingAddress: ADDRESS },
  });
  if (res.status !== 201) {
    throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.order.id };
}
describe('Transactional outbox + consumer idempotency (Day 7)', () => {
  let adminToken: string;
  let customer: TestUser;
  let product: TestProduct;

  before(async () => {
    await startTestServer();
    await cleanupTestData();

    const admin = await registerAdmin();
    adminToken = admin.token;
    customer = await registerUser('Outbox Customer');
    product = await createProduct(adminToken, { price: 4999.0, stock: 50 });

    // Settle any fire-and-forget dispatch left over from a previous suite so
    // the first assertion in this file starts from a known state.
    await dispatchWithRecording();
  });

  after(async () => {
    await deleteOutboxRows(scratchEventIds.splice(0));
    await cleanupTestData();
    await stopTestServer();
  });

  // ------------------------------------------------------- atomicity
  it('discards the outbox event when the business transaction rolls back', async () => {
    const event = orderPaidEvent();
    const eventId = event.envelope.eventId;

    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await enqueueOutboxEvent(tx, event);
        throw new Error('order was cancelled at the last moment');
      }),
      /order was cancelled at the last moment/
    );

    assert.equal(
      await readRow(eventId),
      null,
      'the event rolls back with the transaction - a stored-but-uncommitted event would be published for work that never happened'
    );
  });

  it('stores the event verbatim alongside the business change', async () => {
    const event = orderPaidEvent();
    const eventId = await enqueueScratch(event);

    const row = await readRow(eventId);
    assert.ok(row);
    assert.equal(row.status, 'PENDING', 'not yet handed to the broker');
    assert.equal(row.topic, 'order.events');
    assert.equal(row.eventType, 'OrderPaid');
    assert.equal(row.aggregateType, 'Order');
    assert.equal(row.aggregateId, '4242');
    assert.equal(row.partitionKey, 'order-4242');
    assert.equal(row.attempts, 0);
    assert.equal(row.publishedAt, null);

    // What is stored is exactly what will be published - no re-encoding step.
    const stored = parseEnvelope(JSON.stringify(row.envelope));
    assert.ok(stored);
    assert.equal(stored!.eventId, eventId);
    assert.deepEqual(stored!.payload, event.envelope.payload);
  });

  // --------------------------------------------------------- delivery
  it('publishes the stored envelope and marks the row PUBLISHED', async () => {
    const eventId = await enqueueScratch();

    const { publisher, result } = await dispatchWithRecording();
    const sent = publisher.published.find((message) => message.headers.eventId === eventId);

    assert.ok(sent, 'the dispatcher handed the event to the transport');
    assert.equal(sent.topic, 'order.events');
    assert.equal(sent.key, 'order-4242', 'partition key, not the aggregate id');
    assert.equal(sent.headers.eventType, 'OrderPaid');
    assert.equal(sent.headers.correlationId, eventId);

    const row = await readRow(eventId);
    assert.equal(row!.status, 'PUBLISHED');
    assert.ok(row!.publishedAt, 'publish time recorded');
    assert.equal(row!.lastError, null);
    assert.equal(row!.attempts, 1);
    assert.equal(result.skipped, false);
  });

  it('keeps the row PENDING with the error recorded when publishing fails', async () => {
    const eventId = await enqueueScratch();

    const { result } = await dispatchWithRecording({ failWith: 'simulated broker outage' });

    const row = await readRow(eventId);
    assert.equal(row!.status, 'PENDING', 'still owed to the broker - nothing is lost');
    assert.equal(row!.attempts, 1, 'the attempt is counted so a budget exists');
    assert.match(row!.lastError ?? '', /simulated broker outage/);
    assert.equal(row!.publishedAt, null);
    assert.ok(row!.nextAttemptAt, 'the next attempt is SCHEDULED, not immediate (Day 8)');
    assert.ok(result.failed >= 1);
  });

  it('defers a failed row instead of burning its retry budget on every tick', async () => {
    const eventId = await enqueueScratch();

    await dispatchWithRecording({ failWith: 'simulated broker outage' });
    const deferred = await readRow(eventId);
    assert.equal(deferred!.status, 'PENDING');
    assert.equal(deferred!.attempts, 1);
    assert.ok(
      deferred!.nextAttemptAt!.getTime() > Date.now(),
      'the retry is in the future, so polling cannot consume it'
    );

    // THE REGRESSION THIS TEST EXISTS FOR.
    // Day 7 counted one attempt per DISPATCH TICK for every pending row, so with
    // the default 2s interval and a 10-attempt budget a row was parked as DEAD
    // after ~20 seconds of broker unavailability - shorter than a broker restart.
    // A routine 30s blip therefore dead-lettered every queued event. Repeated
    // polling must now leave a deferred row exactly where it is.
    for (let tick = 0; tick < 3; tick += 1) {
      await dispatchWithRecording({ failWith: 'still down' });
    }

    const afterTicks = await readRow(eventId);
    assert.equal(afterTicks!.attempts, 1, 'a deferred row is not re-attempted by polling');
    assert.equal(afterTicks!.status, 'PENDING', 'and it is nowhere closer to DEAD');

    // When the backoff expires (here: by clearing the schedule) the row is tried
    // again, and only then does the attempt counter move.
    await prisma.outboxEvent.update({
      where: { eventId },
      data: { nextAttemptAt: null },
    });
    await dispatchWithRecording({ failWith: 'still down' });

    const eligible = await readRow(eventId);
    assert.equal(eligible!.attempts, 2, 'eligible again → attempted again');
    assert.ok(
      eligible!.nextAttemptAt!.getTime() > deferred!.nextAttemptAt!.getTime(),
      'and the next attempt is scheduled further out (exponential backoff)'
    );
  });

  it('parks a row as DEAD once its retry budget is exhausted', async () => {
    const eventId = await enqueueScratch();
    const maxAttempts = config.kafka.outbox.maxAttempts;

    // Pretend every earlier attempt has already failed.
    await prisma.outboxEvent.update({
      where: { eventId },
      data: { attempts: maxAttempts - 1 },
    });

    await dispatchWithRecording({ failWith: 'simulated broker outage' });

    const row = await readRow(eventId);
    assert.equal(row!.status, 'DEAD', 'no longer eligible for dispatch');
    assert.equal(row!.attempts, maxAttempts);
    assert.match(row!.lastError ?? '', /simulated broker outage/);

    // DEAD rows are evidence, not garbage: they are still counted for health.
    assert.equal(await prisma.outboxEvent.count({ where: { eventId, status: 'DEAD' } }), 1);

    // And a later round must leave them alone.
    const { publisher } = await dispatchWithRecording();
    assert.equal(
      publisher.published.some((message) => message.headers.eventId === eventId),
      false,
      'a dead row is never retried automatically - that is what makes it visible'
    );
  });


  // ------------------------------------------------------- consumption
  it('delivers a real payment event exactly once, however often it is redelivered', async () => {
    const order = await checkout(customer, product.id, 1);
    const paid = await api<{ payment: { id: number } }>('POST', `/api/orders/${order.id}/payments`, {
      token: customer.token,
      body: { idempotencyKey: key('idempotent') },
    });
    assert.equal(paid.status, 201);

    // Kafka is at-least-once: the same delivery arrives after a rebalance, a
    // crash between "handled" and "committed", or a duplicate publish.
    assert.equal(await deliverOutboxEvents([order.id]), 1);
    assert.equal(await deliverOutboxEvents([order.id]), 1);

    const notifications = await prisma.notification.count({
      where: { userId: customer.id, orderId: order.id, type: 'PAYMENT_SUCCEEDED' },
    });
    assert.equal(notifications, 1, 'the second delivery was a no-op');

    const row = await prisma.outboxEvent.findFirst({
      where: { partitionKey: `order-${order.id}` },
    });
    const markers = await prisma.processedEvent.count({ where: { eventId: row!.eventId } });
    assert.equal(markers, 1, 'one dedup marker per (consumer group, event id)');
  });

  it('refuses a malformed payload with PermanentEventError and claims nothing', async () => {
    const event = orderPaidEvent();
    const envelope = JSON.parse(JSON.stringify(event.envelope)) as EventEnvelope & {
      payload: Record<string, unknown>;
    };
    delete envelope.payload.orderNumber;

    await assert.rejects(
      handleDomainEvent(consumed(envelope)),
      (err: unknown) => err instanceof PermanentEventError,
      'a schema disagreement cannot be fixed by retrying, so it must not consume the retry budget'
    );

    assert.equal(
      await prisma.processedEvent.count({ where: { eventId: envelope.eventId } }),
      0,
      'validation happens before the transaction, so the event is never claimed'
    );
    assert.equal(
      await prisma.notification.count({ where: { orderId: envelope.payload.orderId as number } }),
      0,
      'and no notification was written'
    );
  });

  it('dead-letters an event type no handler knows about', async () => {
    const envelope = {
      ...orderPaidEvent().envelope,
      eventType: 'InventoryAdjusted',
    } as unknown as EventEnvelope;

    await assert.rejects(
      handleDomainEvent(consumed(envelope)),
      (err: unknown) => err instanceof PermanentEventError
    );
  });

  // --------------------------------------------------------- envelope
  it('round-trips an envelope and refuses anything that is not one', () => {
    const event = orderPaidEvent();
    const parsed = parseEnvelope(serializeEnvelope(event.envelope));

    assert.ok(parsed);
    assert.equal(parsed!.eventId, event.envelope.eventId);
    assert.equal(parsed!.eventVersion, event.envelope.eventVersion);
    assert.deepEqual(parsed!.payload, event.envelope.payload);

    assert.equal(parseEnvelope('this is not json'), null, 'garbage → dead-letter');
    assert.equal(parseEnvelope('{"eventType":"OrderPaid"}'), null, 'shapeless JSON → dead-letter');
    assert.equal(parseEnvelope(null), null, 'tombstone → dead-letter');
    assert.equal(parseEnvelope(Buffer.from('{"eventId":')), null, 'truncated → dead-letter');
  });

  it('keys both payment events of one order to the same partition', () => {
    const paid = orderPaidEvent({ orderId: 77, paymentId: 10 });
    const failed = buildPaymentFailedEvent({
      paymentId: 11,
      orderId: 77,
      orderNumber: 'ORD-77',
      userId: 5,
      amount: '10.00',
      currency: 'GBP',
      method: 'card',
      reason: 'declined',
      attemptCount: 1,
      orderStatus: 'PENDING',
      failedAt: new Date(),
    });

    assert.equal(paid.envelope.partitionKey, 'order-77');
    assert.equal(failed.envelope.partitionKey, 'order-77', 'same order → same partition → ordered');

    // The aggregate is the payment, the key is the order. Conflating them would
    // let "payment succeeded" and "payment failed" land on different partitions.
    assert.equal(failed.envelope.aggregateType, 'Payment');
    assert.equal(failed.envelope.aggregateId, '11');
    assert.notEqual(failed.envelope.partitionKey, failed.envelope.aggregateId);

    // No identity leaks into the event - only the internal numeric key.
    assert.equal(
      JSON.stringify(failed.envelope.payload).includes('@'),
      false,
      'events carry ids, never emails'
    );
  });

  // ------------------------------------------------------- visibility
  it('reports the backlog on /api/health without letting it gate status', async () => {
    // Start from an empty backlog so the delta below is unambiguous.
    //
    // Day 8 adds a wrinkle: a row that failed to publish is now DEFERRED until
    // its backoff expires, so a bare `dispatchOutbox()` no longer sweeps
    // everything that has ever failed. Clearing the schedule here says what the
    // test actually means: "wait for the backlog to be workable, then measure".
    await prisma.outboxEvent.updateMany({
      where: { status: 'PENDING' },
      data: { nextAttemptAt: null },
    });
    await dispatchWithRecording();
    const eventId = await enqueueScratch();

    const res = await api<HealthBody>('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.database, 'up');
    assert.equal(typeof res.body.kafka.pendingEvents, 'number');
    assert.equal(typeof res.body.kafka.deadEvents, 'number');
    assert.ok(res.body.kafka.pendingEvents >= 1, 'the queued event is visible');
    assert.ok(['up', 'down'].includes(res.body.kafka.status));
    assert.equal(typeof res.body.kafka.impact, 'string', 'impact is spelled out, never implied');

    await dispatchWithRecording();

    // The in-process dispatcher may still be mid-round when we ask, so retry
    // rather than assert against a round that never ran.
    let row = await readRow(eventId);
    for (let attempt = 0; attempt < 10 && row!.status !== 'PUBLISHED'; attempt += 1) {
      await dispatchWithRecording();
      row = await readRow(eventId);
    }
    assert.equal(row!.status, 'PUBLISHED');

    const drained = await api<HealthBody>('GET', '/api/health');
    assert.equal(drained.body.kafka.pendingEvents, 0, 'backlog drains once published');
    assert.equal(drained.body.status, 'ok', 'the backlog never decides the status either');
  });
});

