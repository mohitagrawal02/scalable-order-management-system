/**
 * Day 7 - LIVE Kafka suite.
 *
 * Every other Day-7 test runs against an injected `Publisher` so the suite
 * works with no broker at all. This one deliberately does not: it is the only
 * place the real sockets, real topic metadata and real at-least-once delivery
 * are verified. It therefore FAILS LOUDLY when the broker is down (see
 * `requireKafka`) rather than skipping quietly - same contract as the Day-6
 * Redis suites.
 *
 *     ..\infra\kafka\kafka.ps1 -Action start
 *     npm test
 *
 * WHY THE ROUND-TRIP TEST PUBLISHES TO THE DLQ TOPIC
 * ---------------------------------------------------
 * The probe consumer here needs a topic the notification worker is NOT
 * reading, otherwise the test would race a real consumer for the same
 * messages. `notification-service.dlq` is declared `consumedBy: null` - a
 * write-only log nobody subscribes to - which makes it the one topic where a
 * live test cannot interfere with (or be corrupted by) the running system.
 * Transport is transport: producing to and consuming from it exercises exactly
 * the same code path as `order.events`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { prisma } from '../../src/config/prisma';
import {
  ALL_TOPICS,
  TOPICS,
  TOPIC_DEFINITIONS,
  buildOrderPaidEvent,
  describeTopicPartitions,
  dispatchOutbox,
  ensureTopics,
  kafkaPublisher,
  publishEvent,
  startEventConsumer,
  type RunningConsumer,
} from '../../src/infrastructure/kafka';
import {
  api,
  cleanupTestData,
  createProduct,
  deleteOutboxRows,
  dispatchWithRecording,
  RecordingPublisher,
  registerAdmin,
  registerUser,
  requireKafka,
  startTestServer,
  stopTestServer,
  TestProduct,
  TestUser,
} from './helpers';

interface HealthBody {
  status: string;
  kafka: { status: string; pendingEvents: number; deadEvents: number; impact: string };
}

/** Polls until `predicate` is true, or returns false on timeout. */
async function eventually(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(100);
  }
  return false;
}

const probeGroup = `roundtrip-probe-${Date.now()}`;
const received: string[] = [];

describe('Kafka, live (Day 7)', () => {
  let probe: RunningConsumer | undefined;
  const probeTransport = new RecordingPublisher();
  let customer: TestUser;
  let product: TestProduct;
  const scratchEventIds: string[] = [];

  before(async () => {
    // Loud, not silent: this suite exists to verify a real broker.
    await requireKafka();
    // Topics are declared in code (auto-create is off), so a fresh broker needs
    // them provisioned before anything can be produced.
    await ensureTopics();

    await startTestServer();
    await cleanupTestData();

    const admin = await registerAdmin();
    customer = await registerUser('Kafka Live Customer');
    product = await createProduct(admin.token, { price: 2599.0, stock: 20 });

    probe = await startEventConsumer({
      name: 'roundtrip-probe',
      groupId: probeGroup,
      topics: [TOPICS.NOTIFICATION_DLQ],
      fromBeginning: false,
      // Failures are captured in memory instead of published anywhere.
      deadLetterTopic: TOPICS.NOTIFICATION_DLQ,
      publisher: probeTransport,
      handler: async (event) => {
        if (event.envelope) received.push(event.envelope.eventId);
      },
    });
    // Give the group time to be assigned before anything is produced, otherwise
    // a fast publish could land before the subscription exists.
    await delay(500);
  });

  after(async () => {
    if (probe) await probe.stop();
    await deleteOutboxRows(scratchEventIds.splice(0));
    await cleanupTestData();
    await stopTestServer();
  });

  it('has every declared topic on the broker, with the configured partitions', async () => {
    for (const definition of TOPIC_DEFINITIONS) {
      const partitions = await describeTopicPartitions(definition.name);
      assert.equal(
        partitions,
        definition.partitions,
        `${definition.name} should have ${definition.partitions} partitions`
      );
    }
    assert.equal(ALL_TOPICS.length, 3, 'exactly three topics - no speculative ones');
  });

  it('round-trips a real message from producer to consumer', async () => {
    const event = buildOrderPaidEvent({
      paymentId: 1,
      orderId: 991_001,
      orderNumber: 'ORD-LIVE-PROBE',
      userId: 991_001,
      totalAmount: '25.99',
      currency: 'GBP',
      method: 'card',
      paidAt: new Date(),
    });

    const published = await publishEvent({
      topic: TOPICS.NOTIFICATION_DLQ,
      key: event.key,
      envelope: event.envelope,
    });
    assert.equal(published.published, true, 'the broker accepted the record (acks=-1)');

    const got = await eventually(async () => received.includes(event.envelope.eventId));
    assert.ok(got, 'the consumer received exactly the envelope that was produced');
  });

  it('dead-letters a malformed message instead of crashing the consumer', async () => {
    const marker = `poison-${Date.now()}`;

    await kafkaPublisher.publish({
      topic: TOPICS.NOTIFICATION_DLQ,
      key: marker,
      value: '{"this":"is not an envelope"',
      headers: { eventId: marker },
    });

    const sawDeadLetter = await eventually(async () => probeTransport.published.length > 0);
    assert.ok(sawDeadLetter, 'the malformed record was dead-lettered, not retried forever');

    const published = probeTransport.published[probeTransport.published.length - 1];
    assert.equal(published.headers.deadLetter, 'true');
    assert.equal(published.headers.consumerGroup, probeGroup);
    assert.equal(published.headers.originalTopic, TOPICS.NOTIFICATION_DLQ);

    const record = JSON.parse(published.value) as Record<string, unknown>;
    assert.equal(record.error, 'Message is not a valid event envelope');
    assert.equal(record.attempts, 0, 'no retry budget wasted on a permanent failure');
    assert.equal(record.consumerGroup, probeGroup);
    assert.ok(String(record.rawValue).includes('is not an envelope'), 'original bytes preserved');
    assert.equal(record.event, null, 'there was no envelope to preserve');
  });


  it('lets the outbox dispatcher reach the real broker for a real payment', async () => {
    const added = await api('POST', '/api/cart/items', {
      token: customer.token,
      body: { productId: product.id, quantity: 1 },
    });
    assert.equal(added.status, 201);

    const checkout = await api<{ order: { id: number } }>('POST', '/api/orders', {
      token: customer.token,
      body: { shippingAddress: '221B Baker Street, London' },
    });
    assert.equal(checkout.status, 201);
    const orderId = checkout.body.order.id;

    const paid = await api('POST', `/api/orders/${orderId}/payments`, {
      token: customer.token,
      body: { idempotencyKey: `live-outbox-${Date.now()}` },
    });
    assert.equal(paid.status, 201);

    let row = await prisma.outboxEvent.findFirst({ where: { partitionKey: `order-${orderId}` } });
    assert.ok(row, 'the payment committed its outbox row');
    const eventId = row!.eventId;
    scratchEventIds.push(eventId);

    // Real transport this time - no injected publisher, exactly what the API's
    // own dispatcher does after a commit.
    for (let attempt = 0; attempt < 10 && row!.status !== 'PUBLISHED'; attempt += 1) {
      await dispatchOutbox();
      row = await prisma.outboxEvent.findUnique({ where: { eventId } });
      if (row!.status !== 'PUBLISHED') await delay(200);
    }

    assert.equal(row!.status, 'PUBLISHED', 'the broker accepted the committed event');
    assert.ok(row!.publishedAt);
    assert.equal(row!.lastError, null);
  });

  it('reports the broker as up on /api/health without letting it gate status', async () => {
    // Drain first so the backlog number below describes this suite, not a
    // previous one.
    await dispatchWithRecording();

    const res = await api<HealthBody>('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.kafka.status, 'up', 'a live broker answers the health probe');
    assert.equal(typeof res.body.kafka.pendingEvents, 'number');
    assert.ok(res.body.kafka.pendingEvents >= 0);
    assert.ok(res.body.kafka.deadEvents >= 0);
    assert.match(res.body.kafka.impact, /none/);
  });
});

