/**
 * Payment API integration tests (Day 5).
 *
 * Real HTTP against the real Express app + MySQL. Covers: success/failure,
 * server-side amount trust boundary, ownership, state machines, idempotency
 * (sequential + concurrent), retry semantics, and DB uniqueness constraints.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { prisma } from '../../src/config/prisma';
import {
  api,
  cleanupTestData,
  createProduct,
  registerAdmin,
  registerUser,
  startTestServer,
  stopTestServer,
  TestProduct,
  TestUser,
} from './helpers';

const ADDRESS = '221B Baker Street, London';

interface OrderDetail {
  order: { id: number; orderNumber: string; status: string; totalAmount: string };
}

interface PaymentBody {
  payment: {
    id: number;
    orderId: number;
    amount: string;
    status: string;
    method: string;
    transactionRef: string | null;
    attemptCount: number;
    failureReason: string | null;
  };
  order: { id: number; orderNumber: string; status: string };
  replayed: boolean;
}

let keySeq = 0;
const key = (label: string) => `pay-test-${label}-${++keySeq}-${Date.now()}`;

/** Adds an item to the user's cart and checks out (Day-4 flow). */
async function checkout(
  user: TestUser,
  productId: number,
  quantity: number
): Promise<{ id: number; totalAmount: string }> {
  await api('POST', '/api/cart/items', {
    token: user.token,
    body: { productId, quantity },
  });
  const res = await api<OrderDetail>('POST', '/api/orders', {
    token: user.token,
    body: { shippingAddress: ADDRESS },
  });
  if (res.status !== 201) {
    throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.order.id, totalAmount: res.body.order.totalAmount };
}

const pay = (token: string, orderId: number, body: unknown) =>
  api<PaymentBody>('POST', `/api/orders/${orderId}/payments`, { token, body });

describe('Payments API (Day 5)', () => {
  let adminToken: string;
  let customer: TestUser;
  let otherCustomer: TestUser;
  let product: TestProduct;

  before(async () => {
    await startTestServer();
    await cleanupTestData();

    const admin = await registerAdmin();
    adminToken = admin.token;
    customer = await registerUser('Payment Customer');
    otherCustomer = await registerUser('Other Payment Customer');
    product = await createProduct(adminToken, { price: 79999.0, stock: 100 });
  });

  after(async () => {
    await cleanupTestData();
    await stopTestServer();
  });

  // ------------------------------------------------------------------ auth
  it('rejects an unauthenticated payment attempt with 401', async () => {
    const res = await api('POST', '/api/orders/1/payments', {
      body: { idempotencyKey: key('no-auth') },
    });
    assert.equal(res.status, 401);
  });

  it('rejects an unauthenticated payment lookup with 401', async () => {
    const res = await api('GET', '/api/orders/1/payments');
    assert.equal(res.status, 401);
  });

  it('rejects a malformed order id with 400', async () => {
    const res = await api('POST', '/api/orders/abc/payments', {
      token: customer.token,
      body: { idempotencyKey: key('bad-id') },
    });
    assert.equal(res.status, 400);
  });

  // ------------------------------------------------------------- validation
  it('requires an idempotency key (400 for missing/short keys)', async () => {
    const order = await checkout(customer, product.id, 1);

    const missing = await pay(customer.token, order.id, {});
    assert.equal(missing.status, 400);

    const short = await pay(customer.token, order.id, { idempotencyKey: 'abc' });
    assert.equal(short.status, 400);
  });

  it('rejects an unsupported payment method with 400', async () => {
    const order = await checkout(customer, product.id, 1);
    const res = await pay(customer.token, order.id, {
      idempotencyKey: key('bad-method'),
      method: 'BITCOIN',
    });
    assert.equal(res.status, 400);
  });

  // ------------------------------------------------------------- ownership
  it("refuses to pay another user's order (404, orders convention)", async () => {
    const order = await checkout(customer, product.id, 1);
    const res = await pay(otherCustomer.token, order.id, {
      idempotencyKey: key('wrong-owner'),
    });
    assert.equal(res.status, 404);
    // And the order is untouched.
    const detail = await api<OrderDetail>('GET', `/api/orders/${order.id}`, {
      token: customer.token,
    });
    assert.equal(detail.body.order.status, 'PENDING');
  });

  it('returns 404 for a nonexistent order', async () => {
    const res = await pay(customer.token, 99999999, {
      idempotencyKey: key('missing-order'),
    });
    assert.equal(res.status, 404);
  });

  it("cannot read another user's payment (404)", async () => {
    const order = await checkout(customer, product.id, 1);
    const res = await api('GET', `/api/orders/${order.id}/payments`, {
      token: otherCustomer.token,
    });
    assert.equal(res.status, 404);
  });

  it('returns 404 for a payment lookup before any attempt', async () => {
    const order = await checkout(customer, product.id, 1);
    const res = await api('GET', `/api/orders/${order.id}/payments`, {
      token: customer.token,
    });
    assert.equal(res.status, 404);
  });

  // -------------------------------------------------------- success path
  it('pays an order: server-side amount, PAID order, SUCCEEDED payment', async () => {
    const order = await checkout(customer, product.id, 2);
    assert.equal(order.totalAmount, '159998.00');

    const res = await pay(customer.token, order.id, {
      idempotencyKey: key('success'),
      method: 'CARD',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.replayed, false);

    // AMOUNT TRUST BOUNDARY: equals Order.totalAmount exactly.
    assert.equal(res.body.payment.amount, '159998.00');
    assert.equal(res.body.payment.status, 'SUCCEEDED');
    assert.equal(res.body.payment.attemptCount, 1);
    assert.match(res.body.payment.transactionRef ?? '', /^sim_[0-9a-f]{24}$/);
    assert.equal(res.body.payment.failureReason, null);

    // ORDER STATE MACHINE: PENDING -> PAYMENT_PROCESSING -> PAID.
    assert.equal(res.body.order.status, 'PAID');
    const detail = await api<OrderDetail>('GET', `/api/orders/${order.id}`, {
      token: customer.token,
    });
    assert.equal(detail.body.order.status, 'PAID');
  });

  it('ignores a client-supplied amount (server reads Order.total)', async () => {
    const order = await checkout(customer, product.id, 1);
    const res = await pay(customer.token, order.id, {
      idempotencyKey: key('amount-injection'),
      amount: '1.00', // malicious field: must be ignored entirely
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.payment.amount, order.totalAmount);
    assert.notEqual(res.body.payment.amount, '1.00');
  });

  // -------------------------------------------------------- failure path
  it('failed payment: FAILED payment, order back to PENDING, never PAID', async () => {
    const order = await checkout(customer, product.id, 1);
    const res = await pay(customer.token, order.id, {
      idempotencyKey: key('failure'),
      simulation: { outcome: 'FAILURE' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.payment.status, 'FAILED');
    assert.ok(res.body.payment.failureReason);
    assert.equal(res.body.payment.transactionRef, null);
    // THE invariant: FAILED payment never marks the order PAID.
    assert.equal(res.body.order.status, 'PENDING');
  });

  // -------------------------------------------------------- payment lookup
  it('returns the payment for the owner (GET after a successful pay)', async () => {
    const order = await checkout(customer, product.id, 1);
    await pay(customer.token, order.id, { idempotencyKey: key('get-ok') });

    const res = await api<{ payment: { status: string; amount: string } }>(
      'GET',
      `/api/orders/${order.id}/payments`,
      { token: customer.token }
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.payment.status, 'SUCCEEDED');
    assert.equal(res.body.payment.amount, order.totalAmount);
  });

  // ------------------------------------------------------------ idempotency
  it('replays the SAME idempotency key without charging twice (200, one row)', async () => {
    const order = await checkout(customer, product.id, 1);
    const k = key('replay');

    const first = await pay(customer.token, order.id, { idempotencyKey: k });
    assert.equal(first.status, 201);
    assert.equal(first.body.replayed, false);

    const second = await pay(customer.token, order.id, { idempotencyKey: k });
    assert.equal(second.status, 200, 'replay answers 200, not 201');
    assert.equal(second.body.replayed, true);
    assert.equal(second.body.payment.id, first.body.payment.id, 'same payment row');
    assert.equal(second.body.payment.attemptCount, 1, 'no extra provider attempt');
    assert.equal(second.body.payment.status, 'SUCCEEDED');

    // Exactly ONE payment row exists for this order (DB constraint + app).
    const count = await prisma.payment.count({ where: { orderId: order.id } });
    assert.equal(count, 1);
  });

  it('handles CONCURRENT duplicate requests with the same key safely', async () => {
    const order = await checkout(customer, product.id, 1);
    const k = key('concurrent');

    const [a, b] = await Promise.all([
      pay(customer.token, order.id, { idempotencyKey: k }),
      pay(customer.token, order.id, { idempotencyKey: k }),
    ]);

    // One request charges (201); the other replays (200). What must NEVER
    // happen: two payment rows or two provider charges.
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 201]);

    const count = await prisma.payment.count({ where: { orderId: order.id } });
    assert.equal(count, 1, 'exactly one payment row despite concurrent requests');

    const final = await api<{ payment: { status: string; attemptCount: number } }>(
      'GET',
      `/api/orders/${order.id}/payments`,
      { token: customer.token }
    );
    assert.equal(final.body.payment.status, 'SUCCEEDED');
    assert.equal(final.body.payment.attemptCount, 1, 'provider charged once');
  });

  it('rejects reusing an idempotency key on a DIFFERENT order (409)', async () => {
    const orderA = await checkout(customer, product.id, 1);
    const orderB = await checkout(customer, product.id, 1);
    const k = key('cross-order');

    const first = await pay(customer.token, orderA.id, { idempotencyKey: k });
    assert.equal(first.status, 201);

    const second = await pay(customer.token, orderB.id, { idempotencyKey: k });
    assert.equal(second.status, 409, 'global key uniqueness is enforced');

    const countB = await prisma.payment.count({ where: { orderId: orderB.id } });
    assert.equal(countB, 0, 'no payment row created on the conflicting order');
  });

  // ---------------------------------------------------------------- retries
  it('retry after failure reuses the SAME row (attemptCount++) and can succeed', async () => {
    const order = await checkout(customer, product.id, 1);

    const failed = await pay(customer.token, order.id, {
      idempotencyKey: key('retry-fail'),
      simulation: { outcome: 'FAILURE' },
    });
    assert.equal(failed.status, 201);
    assert.equal(failed.body.payment.status, 'FAILED');
    assert.equal(failed.body.order.status, 'PENDING', 'order payable again');

    // Retry = same order, NEW idempotency key (the old key replays the failure).
    const retried = await pay(customer.token, order.id, {
      idempotencyKey: key('retry-ok'),
    });
    assert.equal(retried.status, 201);
    assert.equal(
      retried.body.payment.id,
      failed.body.payment.id,
      'retry reuses the single payment row (orderId @unique)'
    );
    assert.equal(retried.body.payment.attemptCount, 2);
    assert.equal(retried.body.payment.status, 'SUCCEEDED');
    assert.equal(retried.body.order.status, 'PAID');

    // Still exactly one payment row - and therefore at most one success.
    const count = await prisma.payment.count({ where: { orderId: order.id } });
    assert.equal(count, 1);
  });

  it('replaying the key of a FAILED attempt returns the failure (no new charge)', async () => {
    const order = await checkout(customer, product.id, 1);
    const k = key('replay-failure');

    const first = await pay(customer.token, order.id, {
      idempotencyKey: k,
      simulation: { outcome: 'FAILURE' },
    });
    assert.equal(first.status, 201);

    const second = await pay(customer.token, order.id, { idempotencyKey: k });
    assert.equal(second.status, 200);
    assert.equal(second.body.replayed, true);
    assert.equal(second.body.payment.status, 'FAILED', 'original result replayed');
    assert.equal(second.body.payment.attemptCount, 1);
  });

  // --------------------------------------------------------- notifications
  it('successful payment creates a PAYMENT_SUCCEEDED notification for the owner', async () => {
    const order = await checkout(customer, product.id, 1);
    await pay(customer.token, order.id, { idempotencyKey: key('notif-ok') });

    const notifs = await api<{
      data: Array<{ type: string; message: string; order: { id: number } | null }>;
    }>('GET', '/api/notifications?limit=100', { token: customer.token });
    assert.equal(notifs.status, 200);
    const hit = notifs.body.data.find(
      (n) => n.type === 'PAYMENT_SUCCEEDED' && n.order?.id === order.id
    );
    assert.ok(hit, 'PAYMENT_SUCCEEDED notification referencing the order exists');
    assert.match(hit!.message, /Payment received for order/);
  });

  it('failed payment creates a PAYMENT_FAILED notification for the owner', async () => {
    const order = await checkout(customer, product.id, 1);
    await pay(customer.token, order.id, {
      idempotencyKey: key('notif-fail'),
      simulation: { outcome: 'FAILURE' },
    });

    const notifs = await api<{
      data: Array<{ type: string; order: { id: number } | null }>;
    }>('GET', '/api/notifications?limit=100', { token: customer.token });
    const hit = notifs.body.data.find(
      (n) => n.type === 'PAYMENT_FAILED' && n.order?.id === order.id
    );
    assert.ok(hit, 'PAYMENT_FAILED notification referencing the order exists');
  });

  it('notification list is scoped to the JWT identity (other users invisible)', async () => {
    // otherCustomer has no orders/notifications of their own; a query-string
    // userId cannot borrow customer's notifications (controller ignores it).
    const res = await api<{ data: unknown[]; pagination: { total: number } }>(
      'GET',
      `/api/notifications?userId=${customer.id}&limit=100`,
      { token: otherCustomer.token }
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.pagination.total, 0, "customer B sees none of A's notifications");
  });

  it('rejects unauthenticated notification access with 401', async () => {
    const res = await api('GET', '/api/notifications');
    assert.equal(res.status, 401);
  });
});

