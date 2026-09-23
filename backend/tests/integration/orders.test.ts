/**
 * Order / checkout integration tests (Day 4).
 *
 * The interesting cases here are the ones a plain CRUD test never catches:
 * atomicity, oversell protection under concurrency, and price snapshots.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { prisma } from '../../src/config/prisma';
import {
  api,
  cleanupTestData,
  createProduct,
  getCartItemCount,
  getOrderCount,
  getStock,
  registerAdmin,
  registerUser,
  startTestServer,
  stopTestServer,
  TestProduct,
  TestUser,
} from './helpers';

interface OrderSummary {
  id: number;
  orderNumber: string;
  status: string;
  totalAmount: string;
  itemCount: number;
}

interface OrderDetail {
  order: OrderSummary & {
    shippingAddress: string;
    items: Array<{
      productId: number;
      quantity: number;
      unitPrice: string;
      lineTotal: string;
      product: { id: number; name: string; sku: string };
    }>;
  };
}

interface OrderList {
  data: OrderSummary[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

const ADDRESS = '221B Baker Street, London';

/**
 * Fault-injection constants for the atomicity test: a temporary CHECK
 * constraint rejects any order item priced exactly `ROLLBACK_PRICE`, so the
 * `INSERT INTO order_items` fails *after* the order row exists.
 * (MySQL 8.0.16+ enforces CHECK constraints; this project runs 8.0.44.)
 */
const ROLLBACK_PRICE = 424242.42;
const ROLLBACK_CONSTRAINT = 'day4test_block_order_items';

/** Adds an item then checks out. */
async function addAndCheckout(
  user: TestUser,
  productId: number,
  quantity: number
): Promise<{ status: number; body: OrderDetail }> {
  await api('POST', '/api/cart/items', {
    token: user.token,
    body: { productId, quantity },
  });
  return api<OrderDetail>('POST', '/api/orders', {
    token: user.token,
    body: { shippingAddress: ADDRESS },
  });
}

describe('Orders API (Day 4)', () => {
  let customer: TestUser;
  let otherCustomer: TestUser;
  let adminToken: string;
  let product: TestProduct;
  /** Id of the order created in the "snapshots prices" test, reused to prove history is immutable. */
  let firstOrderId: number;

  before(async () => {
    await startTestServer();
    await cleanupTestData();

    const admin = await registerAdmin();
    adminToken = admin.token;
    customer = await registerUser('Order Customer');
    otherCustomer = await registerUser('Other Order Customer');
    product = await createProduct(adminToken, { price: 79999.0, stock: 10 });
  });

  after(async () => {
    await cleanupTestData();
    await stopTestServer();
  });

  it('rejects an unauthenticated checkout with 401', async () => {
    const res = await api('POST', '/api/orders', {
      body: { shippingAddress: ADDRESS },
    });
    assert.equal(res.status, 401);
  });

  it('refuses to create an order from an empty cart', async () => {
    const res = await api('POST', '/api/orders', {
      token: customer.token,
      body: { shippingAddress: ADDRESS },
    });
    assert.equal(res.status, 409);
    assert.equal(await getOrderCount(customer.id), 0);
  });

  it('requires a shipping address', async () => {
    const res = await api('POST', '/api/orders', {
      token: customer.token,
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('creates an order, snapshots prices, decrements stock and clears the cart', async () => {
    const before = await getStock(product.id);
    assert.equal(before, 10);

    const res = await addAndCheckout(customer, product.id, 3);

    assert.equal(res.status, 201);
    const order = res.body.order;
    firstOrderId = order.id;
    assert.equal(order.status, 'PENDING');
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0]!.quantity, 3);
    // Price snapshot taken from the catalog at purchase time.
    assert.equal(order.items[0]!.unitPrice, '79999.00');
    assert.equal(order.items[0]!.lineTotal, '239997.00');
    // Server-calculated total equals SUM(unitPrice x quantity).
    assert.equal(order.totalAmount, '239997.00');
    assert.equal(order.orderNumber.startsWith('ORD-'), true);

    assert.equal(await getStock(product.id), 7, 'stock 10 - 3 = 7');
    assert.equal(await getCartItemCount(customer.id), 0, 'cart cleared');
    assert.equal(await getOrderCount(customer.id), 1);
  });

  it('keeps the historical price after the catalog price changes', async () => {
    // Snapshot semantics have two halves:
    //   (a) orders placed BEFORE a price change keep their old price,
    //   (b) orders placed AFTER it use the new price.
    const historicalPrice = product.price; // '79999.00' at checkout time
    const newPrice = '94999.00';
    await prisma.product.update({
      where: { id: product.id },
      data: { price: newPrice },
    });

    // (a) The order created before the change must still read the old price.
    const historical = await api<OrderDetail>('GET', `/api/orders/${firstOrderId}`, {
      token: customer.token,
    });
    assert.equal(historical.status, 200);
    assert.equal(
      historical.body.order.items[0]!.unitPrice,
      historicalPrice,
      'order history is not rewritten when the catalog price changes'
    );
    assert.equal(historical.body.order.totalAmount, '239997.00');

    // (b) A NEW checkout snapshots whatever the catalog says now.
    const created = await addAndCheckout(otherCustomer, product.id, 1);
    assert.equal(created.status, 201);
    assert.equal(
      created.body.order.items[0]!.unitPrice,
      newPrice,
      'a new order uses the current catalog price'
    );
    assert.equal(created.body.order.totalAmount, newPrice);

    // Changing the catalog price again must not rewrite either order.
    await prisma.product.update({
      where: { id: product.id },
      data: { price: '1000.00' },
    });
    const refetched = await api<OrderDetail>(
      'GET',
      `/api/orders/${created.body.order.id}`,
      { token: otherCustomer.token }
    );
    assert.equal(refetched.body.order.items[0]!.unitPrice, newPrice);
    assert.equal(refetched.body.order.totalAmount, newPrice);

    // Restore the fixture price for the tests that follow.
    await prisma.product.update({
      where: { id: product.id },
      data: { price: historicalPrice },
    });
  });

  it('rejects insufficient inventory with 409 and changes nothing', async () => {
    const scarce = await createProduct(adminToken, {
      price: 1500.0,
      stock: 2,
    });

    await api('POST', '/api/cart/items', {
      token: customer.token,
      body: { productId: scarce.id, quantity: 5 },
    });

    const res = await api('POST', '/api/orders', {
      token: customer.token,
      body: { shippingAddress: ADDRESS },
    });
    assert.equal(res.status, 409);

    assert.equal(await getStock(scarce.id), 2, 'stock untouched');
    assert.equal(
      await getCartItemCount(customer.id),
      1,
      'cart intentionally preserved for a retry'
    );
    const ordersBefore = await getOrderCount(customer.id);
    assert.equal(ordersBefore, 1, 'no new order was created');
  });

  it('does not partially decrement stock when one line is unavailable', async () => {
    const ok = await createProduct(adminToken, { price: 100.0, stock: 50 });
    const tooFew = await createProduct(adminToken, { price: 200.0, stock: 1 });

    await api('POST', '/api/cart/items', {
      token: customer.token,
      body: { productId: ok.id, quantity: 2 },
    });
    await api('POST', '/api/cart/items', {
      token: customer.token,
      body: { productId: tooFew.id, quantity: 4 },
    });

    const res = await api('POST', '/api/orders', {
      token: customer.token,
      body: { shippingAddress: ADDRESS },
    });
    assert.equal(res.status, 409);
    assert.equal(await getStock(ok.id), 50, 'the valid line was NOT decremented');
    assert.equal(await getStock(tooFew.id), 1);
  });

  it('refuses to check out a product that became inactive after being added', async () => {
    // Fresh user: the ONLY line in their cart is the product being deactivated,
    // so the 409 can only come from that product.
    const fresh = await registerUser('Inactive Product Buyer');
    const doomed = await createProduct(adminToken, { price: 300.0, stock: 5 });
    await api('POST', '/api/cart/items', {
      token: fresh.token,
      body: { productId: doomed.id, quantity: 1 },
    });
    await prisma.product.update({
      where: { id: doomed.id },
      data: { isActive: false },
    });

    const res = await api('POST', '/api/orders', {
      token: fresh.token,
      body: { shippingAddress: ADDRESS },
    });
    assert.equal(res.status, 409);
    assert.equal(await getStock(doomed.id), 5, 'stock untouched');
    assert.equal(await getCartItemCount(fresh.id), 1, 'cart preserved');
    assert.equal(await getOrderCount(fresh.id), 0, 'no order created');
  });

  it('lists only the authenticated user\'s orders', async () => {
    const mine = await api<OrderList>('GET', '/api/orders', {
      token: otherCustomer.token,
    });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.pagination.total, 1);
    assert.equal(mine.body.data.length, 1);

    const theirs = await api<OrderList>('GET', '/api/orders', {
      token: customer.token,
    });
    assert.equal(theirs.body.pagination.total, 1);
    assert.notEqual(theirs.body.data[0]!.id, mine.body.data[0]!.id);

    // No order of another user is reachable, even by id.
    const foreign = await api(
      'GET',
      `/api/orders/${mine.body.data[0]!.id}`,
      { token: customer.token }
    );
    assert.equal(foreign.status, 404, 'foreign order looks nonexistent');
  });

  it('returns 404 for a nonexistent order and 400 for an invalid id', async () => {
    const missing = await api('GET', '/api/orders/99999999', {
      token: customer.token,
    });
    assert.equal(missing.status, 404);

    const invalid = await api('GET', '/api/orders/not-a-number', {
      token: customer.token,
    });
    assert.equal(invalid.status, 400);
  });

  it('never exposes password hashes through order responses', async () => {
    const res = await api<OrderList>('GET', '/api/orders', {
      token: customer.token,
    });
    const serialized = JSON.stringify(res.body);
    assert.equal(serialized.includes('passwordHash'), false);
    assert.equal(serialized.includes('password_hash'), false);
  });

  it('protects a referenced product from deletion (409) instead of erasing history', async () => {
    // `product` has already been ordered above.
    const res = await api('DELETE', `/api/products/${product.id}`, {
      token: adminToken,
    });
    assert.equal(res.status, 409);

    // Order history is intact.
    const orders = await api<OrderList>('GET', '/api/orders', {
      token: otherCustomer.token,
    });
    assert.equal(orders.body.pagination.total, 1);
  });

  it('checkout is atomic: concurrent attempts cannot oversell the last unit', async () => {
    const lastOne = await createProduct(adminToken, { price: 999.0, stock: 1 });

    // Two FRESH buyers, each with exactly one line in their cart, so nothing
    // else in either cart can influence the outcome of the race.
    const buyerA = await registerUser('Race Buyer A');
    const buyerB = await registerUser('Race Buyer B');

    await api('POST', '/api/cart/items', {
      token: buyerA.token,
      body: { productId: lastOne.id, quantity: 1 },
    });
    await api('POST', '/api/cart/items', {
      token: buyerB.token,
      body: { productId: lastOne.id, quantity: 1 },
    });

    // Fire both checkouts at the same time.
    const [a, b] = await Promise.all([
      api('POST', '/api/orders', {
        token: buyerA.token,
        body: { shippingAddress: ADDRESS },
      }),
      api('POST', '/api/orders', {
        token: buyerB.token,
        body: { shippingAddress: ADDRESS },
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(
      statuses,
      [201, 409],
      `expected exactly one winner, got ${statuses}`
    );

    assert.equal(await getStock(lastOne.id), 0, 'stock never goes negative');

    const totalOrders =
      (await getOrderCount(buyerA.id)) + (await getOrderCount(buyerB.id));
    assert.equal(totalOrders, 1, 'exactly one order was created');

    // The loser keeps their cart so they can retry later.
    const loserCartItems =
      a.status === 409
        ? await getCartItemCount(buyerA.id)
        : await getCartItemCount(buyerB.id);
    assert.equal(loserCartItems, 1, 'loser cart preserved');
  });

  it('rolls back every write when a statement fails mid-transaction (atomicity)', async () => {
    // Forced fault injection *after* the order row is inserted but *before*
    // COMMIT: a CHECK constraint that rejects one specific price. Prisma emits
    // `INSERT orders` then `INSERT order_items`, so this proves the earlier
    // order row is undone - not merely that the request errored.
    //
    // The constraint is created and dropped by this test alone; production code
    // contains no test hooks (a deliberate choice - see docs/ORDERS.md).
    const doomed = await createProduct(adminToken, {
      price: ROLLBACK_PRICE,
      stock: 8,
    });
    const buyer = await registerUser('Rollback Buyer');
    await api('POST', '/api/cart/items', {
      token: buyer.token,
      body: { productId: doomed.id, quantity: 2 },
    });

    await prisma.$executeRawUnsafe(
      `ALTER TABLE order_items ADD CONSTRAINT ${ROLLBACK_CONSTRAINT} ` +
        `CHECK (unit_price <> ${ROLLBACK_PRICE})`
    );

    try {
      const res = await api('POST', '/api/orders', {
        token: buyer.token,
        body: { shippingAddress: ADDRESS },
      });
      // Unknown database failure -> existing global 500 handler.
      assert.equal(res.status, 500);
      assert.equal(
        'stack' in (res.body ?? {}),
        false,
        'no stack trace leaks to the client'
      );

      assert.equal(await getOrderCount(buyer.id), 0, 'no partial order row');
      assert.equal(
        await prisma.orderItem.count({ where: { productId: doomed.id } }),
        0,
        'no partial order items'
      );
      assert.equal(
        await getStock(doomed.id),
        8,
        'inventory was NOT decremented'
      );
      assert.equal(
        await getCartItemCount(buyer.id),
        1,
        'cart was NOT cleared - the user can retry'
      );
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE order_items DROP CHECK ${ROLLBACK_CONSTRAINT}`
      );
    }

    // With the fault removed, the very same cart now checks out successfully.
    const retry = await api('POST', '/api/orders', {
      token: buyer.token,
      body: { shippingAddress: ADDRESS },
    });
    assert.equal(retry.status, 201, 'the preserved cart is still usable');
    assert.equal(await getStock(doomed.id), 6);
    assert.equal(await getCartItemCount(buyer.id), 0);
  });
});
