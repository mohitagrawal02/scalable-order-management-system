/**
 * Shared helpers for the API integration tests (Day 4+).
 *
 * These tests exercise the REAL Express app against the REAL local MySQL:
 *  - the app is started in-process via `createApp()` on an ephemeral port, so
 *    no manually started server is required;
 *  - data is created through the public HTTP API (never by writing tables
 *    directly), except for two things the API deliberately does not expose
 *    yet: inventory levels and a user's role. Those go through Prisma.
 *
 * Every row created here is namespaced with TEST_PREFIX and swept by
 * `cleanupTestData()` so the database is left exactly as it was found.
 */
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { createApp } from '../../src/app';
import { prisma } from '../../src/config/prisma';

/** All test-created email addresses start with this. */
export const TEST_PREFIX = 'day4test.';
const SKU_PREFIX = 'DAY4TEST-';

export const TEST_PASSWORD = 'IntegrationPass123!';

let server: Server | undefined;
let baseUrl = '';

/** Boots the app on a random free port. */
export async function startTestServer(): Promise<void> {
  if (server) return;
  const app = createApp();
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

export async function stopTestServer(): Promise<void> {
  if (server) {
    const running = server;
    server = undefined;
    await new Promise<void>((resolve) => running.close(() => resolve()));
  }
  await prisma.$disconnect();
}

export interface ApiResult<T> {
  status: number;
  body: T;
}

interface ApiOptions {
  token?: string;
  body?: unknown;
}

/** Minimal typed JSON client against the test server. */
export async function api<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: ApiOptions = {}
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: (text.length > 0 ? JSON.parse(text) : null) as T,
  };
}

export interface TestUser {
  id: number;
  email: string;
  token: string;
}

let userCounter = 0;
const runId = Date.now().toString(36);

/** Registers a fresh CUSTOMER via the public API and returns a live token. */
export async function registerUser(name = 'Test User'): Promise<TestUser> {
  const email = `${TEST_PREFIX}${runId}.${++userCounter}@example.com`;
  const registration = await api('POST', '/api/auth/register', {
    body: { name, email, password: TEST_PASSWORD },
  });
  if (registration.status !== 201) {
    throw new Error(
      `register failed: ${registration.status} ${JSON.stringify(registration.body)}`
    );
  }

  const login = await api<{ token: string; user: { id: number } }>(
    'POST',
    '/api/auth/login',
    { body: { email, password: TEST_PASSWORD } }
  );
  if (login.status !== 200) {
    throw new Error(`login failed: ${login.status}`);
  }

  return { id: login.body.user.id, email, token: login.body.token };
}

/**
 * Registers a user, promotes them to ADMIN directly in the database (there is
 * no role-management API yet), then logs in again so the JWT carries the role.
 */
export async function registerAdmin(): Promise<TestUser> {
  const user = await registerUser('Test Admin');
  await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });

  const login = await api<{ token: string }>('POST', '/api/auth/login', {
    body: { email: user.email, password: TEST_PASSWORD },
  });
  if (login.status !== 200) {
    throw new Error(`admin login failed: ${login.status}`);
  }
  return { ...user, token: login.body.token };
}

let productCounter = 0;

export interface TestProduct {
  id: number;
  name: string;
  sku: string;
  price: string;
}

/**
 * Creates a product through the admin API, then sets its stock through Prisma
 * (inventory is not exposed over HTTP yet - it arrives with a later milestone).
 */
export async function createProduct(
  adminToken: string,
  options: { price: number; stock: number; category?: string; isActive?: boolean }
): Promise<TestProduct> {
  const n = ++productCounter;
  const name = `Test Product ${runId}-${n}`;
  const sku = `${SKU_PREFIX}${runId}-${n}`;

  const created = await api<{ product: { id: number; price: string } }>(
    'POST',
    '/api/products',
    {
      token: adminToken,
      body: {
        name,
        description: `Integration test product ${n}`,
        price: options.price,
        sku,
        category: options.category ?? 'test-category',
      },
    }
  );
  if (created.status !== 201) {
    throw new Error(
      `product create failed: ${created.status} ${JSON.stringify(created.body)}`
    );
  }

  const productId = created.body.product.id;
  await prisma.inventory.upsert({
    where: { productId },
    update: { quantity: options.stock },
    create: { productId, quantity: options.stock },
  });

  if (options.isActive === false) {
    await prisma.product.update({
      where: { id: productId },
      data: { isActive: false },
    });
  }

  return { id: productId, name, sku, price: created.body.product.price };
}

/** Reads a product's current stock directly from the database. */
export async function getStock(productId: number): Promise<number | null> {
  const row = await prisma.inventory.findUnique({ where: { productId } });
  return row ? row.quantity : null;
}

/** Current number of cart lines for a user. */
export async function getCartItemCount(userId: number): Promise<number> {
  return prisma.cartItem.count({ where: { cart: { userId } } });
}

/** Number of orders belonging to a user. */
export async function getOrderCount(userId: number): Promise<number> {
  return prisma.order.count({ where: { userId } });
}

/**
 * Removes every row this suite could have created (matched by prefix), in
 * FK-safe order. Idempotent: safe to call before and after a run.
 */
export async function cleanupTestData(): Promise<void> {
  const userIds = (
    await prisma.user.findMany({
      where: { email: { startsWith: TEST_PREFIX } },
      select: { id: true },
    })
  ).map((u) => u.id);

  const productIds = (
    await prisma.product.findMany({
      where: { sku: { startsWith: SKU_PREFIX } },
      select: { id: true },
    })
  ).map((p) => p.id);

  if (userIds.length > 0) {
    const orderIds = (
      await prisma.order.findMany({
        where: { userId: { in: userIds } },
        select: { id: true },
      })
    ).map((o) => o.id);

    if (orderIds.length > 0) {
      // Ordering matters: notifications/payments reference orders, order_items
      // reference products with ON DELETE RESTRICT, so orders are removed first.
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    await prisma.cartItem.deleteMany({ where: { cart: { userId: { in: userIds } } } });
    await prisma.cart.deleteMany({ where: { userId: { in: userIds } } });
  }

  if (productIds.length > 0) {
    await prisma.inventory.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.cartItem.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  }

  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}
