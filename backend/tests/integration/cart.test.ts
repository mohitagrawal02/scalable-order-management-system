/**
 * Cart API integration tests (Day 4).
 *
 * Run against the real Express app + real MySQL. See helpers.ts.
 * Coverage: ownership, upsert-on-duplicate-add, validation, inactive products,
 * update/remove semantics.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  api,
  cleanupTestData,
  createProduct,
  getCartItemCount,
  registerAdmin,
  registerUser,
  startTestServer,
  stopTestServer,
  TestProduct,
  TestUser,
} from './helpers';

/** Minimal response shape the assertions care about. */
interface CartBody {
  cart: {
    id: number;
    items: Array<{
      productId: number;
      quantity: number;
      lineTotal: string;
      product: { id: number; name: string; sku: string; isActive: boolean };
    }>;
    itemCount: number;
    totalQuantity: number;
    totalAmount: string;
  };
}

describe('Cart API (Day 4)', () => {
  let customer: TestUser;
  let otherCustomer: TestUser;
  let adminToken: string;
  let product: TestProduct;
  let inactiveProduct: TestProduct;

  before(async () => {
    await startTestServer();
    await cleanupTestData();

    const admin = await registerAdmin();
    adminToken = admin.token;
    customer = await registerUser('Cart Customer');
    otherCustomer = await registerUser('Other Customer');

    product = await createProduct(adminToken, { price: 79999.0, stock: 25 });
    inactiveProduct = await createProduct(adminToken, {
      price: 500.0,
      stock: 5,
      isActive: false,
    });
  });

  after(async () => {
    await cleanupTestData();
    await stopTestServer();
  });

  it('rejects an unauthenticated GET /api/cart with 401', async () => {
    const res = await api('GET', '/api/cart');
    assert.equal(res.status, 401);
  });

  it('rejects an invalid token with 401', async () => {
    const res = await api('GET', '/api/cart', { token: 'not-a-real-token' });
    assert.equal(res.status, 401);
  });

  it("returns the authenticated user's own (initially empty) cart", async () => {
    const res = await api<CartBody>('GET', '/api/cart', {
      token: customer.token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.cart.items.length, 0);
    assert.equal(res.body.cart.itemCount, 0);
    assert.equal(res.body.cart.totalAmount, '0.00');
  });

  it('adds a valid product to the cart', async () => {
    const res = await api<CartBody>('POST', '/api/cart/items', {
      token: customer.token,
      body: { productId: product.id, quantity: 2 },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.cart.items.length, 1);
    assert.equal(res.body.cart.items[0]!.productId, product.id);
    assert.equal(res.body.cart.items[0]!.quantity, 2);
    assert.equal(res.body.cart.items[0]!.lineTotal, '159998.00');
    assert.equal(res.body.cart.totalAmount, '159998.00');
    // Only safe product fields are exposed.
    assert.equal('passwordHash' in res.body.cart.items[0]!.product, false);
  });

  it('increases quantity instead of duplicating the line when added twice', async () => {
    const res = await api<CartBody>('POST', '/api/cart/items', {
      token: customer.token,
      body: { productId: product.id, quantity: 3 },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.cart.itemCount, 1, 'still a single cart line');
    assert.equal(res.body.cart.items[0]!.quantity, 5);
    assert.equal(await getCartItemCount(customer.id), 1);

    // Reset to a known quantity for the following tests.
    await api('PATCH', `/api/cart/items/${product.id}`, {
      token: customer.token,
      body: { quantity: 2 },
    });
  });

  it('rejects invalid quantities with 400', async () => {
    for (const quantity of [0, -1, 1.5, '2', 101]) {
      const res = await api('POST', '/api/cart/items', {
        token: customer.token,
        body: { productId: product.id, quantity },
      });
      assert.equal(
        res.status,
        400,
        `quantity=${String(quantity)} must be rejected`
      );
    }
  });

  it('rejects a missing or invalid productId with 400', async () => {
    const missing = await api('POST', '/api/cart/items', {
      token: customer.token,
      body: { quantity: 1 },
    });
    assert.equal(missing.status, 400);

    const nonInteger = await api('POST', '/api/cart/items', {
      token: customer.token,
      body: { productId: 'abc', quantity: 1 },
    });
    assert.equal(nonInteger.status, 400);
  });

  it('returns 404 when adding a nonexistent product', async () => {
    const res = await api('POST', '/api/cart/items', {
      token: customer.token,
      body: { productId: 99999999, quantity: 1 },
    });
    assert.equal(res.status, 404);
  });

  it('refuses to add an inactive product (409) and does not create a line', async () => {
    const res = await api('POST', '/api/cart/items', {
      token: customer.token,
      body: { productId: inactiveProduct.id, quantity: 1 },
    });
    assert.equal(res.status, 409);
    assert.equal(
      await getCartItemCount(customer.id),
      1,
      'cart still holds only the earlier active product'
    );
  });

  it('updates an existing cart line', async () => {
    const res = await api<CartBody>('PATCH', `/api/cart/items/${product.id}`, {
      token: customer.token,
      body: { quantity: 4 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.cart.items[0]!.quantity, 4);
  });

  it('returns 400 for an invalid product id in the path', async () => {
    const res = await api('PATCH', '/api/cart/items/abc', {
      token: customer.token,
      body: { quantity: 1 },
    });
    assert.equal(res.status, 400);
  });

  it('returns 404 when updating a line that is not in the cart', async () => {
    const res = await api('PATCH', `/api/cart/items/${inactiveProduct.id}`, {
      token: customer.token,
      body: { quantity: 1 },
    });
    assert.equal(res.status, 404);
  });

  it("does not let a user modify another user's cart line", async () => {
    // otherCustomer owns a different cart; their cart is a distinct row.
    await api('POST', '/api/cart/items', {
      token: otherCustomer.token,
      body: { productId: product.id, quantity: 7 },
    });

    const patch = await api<CartBody>(
      'PATCH',
      `/api/cart/items/${product.id}`,
      { token: customer.token, body: { quantity: 9 } }
    );
    // `customer` DOES have this product, so this succeeds - but it must have
    // touched only their own cart.
    assert.equal(patch.status, 200);
    assert.equal(patch.body.cart.items[0]!.quantity, 9);

    const otherCart = await api<CartBody>('GET', '/api/cart', {
      token: otherCustomer.token,
    });
    assert.equal(
      otherCart.body.cart.items[0]!.quantity,
      7,
      "another user's quantity is untouched"
    );
    assert.notEqual(otherCart.body.cart.id, patch.body.cart.id);
  });

  it('returns 404 when deleting a line that is not in the cart', async () => {
    const res = await api('DELETE', `/api/cart/items/${inactiveProduct.id}`, {
      token: customer.token,
    });
    assert.equal(res.status, 404);
  });

  it('removes a cart line from the authenticated cart only', async () => {
    const res = await api<CartBody>('DELETE', `/api/cart/items/${product.id}`, {
      token: customer.token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.cart.items.length, 0);
    assert.equal(res.body.cart.totalAmount, '0.00');
    assert.equal(await getCartItemCount(customer.id), 0);

    // The other user's line survived the delete.
    assert.equal(await getCartItemCount(otherCustomer.id), 1);
  });
});
