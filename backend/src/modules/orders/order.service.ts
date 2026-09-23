import { randomBytes } from 'node:crypto';
import { Order, Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import {
  CreateOrderInput,
  ListOrdersParams,
  OrderDetailResponse,
  OrderItemResponse,
  OrderSummaryResponse,
  PaginatedOrders,
} from './order.types';

/**
 * Order business logic - the heart of Day 4.
 *
 * Checkout is the first operation in this project that must be *atomic across
 * multiple tables*: an order row, its item rows, inventory decrements and a
 * cart clear. Any partial outcome is a real-world bug (an order with no stock
 * removed, or stock removed for an order that does not exist), so the whole
 * sequence runs inside one Prisma interactive transaction.
 *
 * Concurrency: see the detailed comments on `createOrderFromCart`.
 */

/** Product fields embedded in an order item (safe, minimal, no secrets). */
const orderItemProductSelect = {
  id: true,
  name: true,
  sku: true,
  category: true,
  price: true,
  isActive: true,
} satisfies Prisma.ProductSelect;

const orderDetailInclude = {
  items: {
    include: { product: { select: orderItemProductSelect } },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.OrderInclude;

type OrderWithItems = Prisma.OrderGetPayload<{ include: typeof orderDetailInclude }>;

/**
 * Human-readable, sortable, collision-resistant order number.
 *
 * Format: ORD-<yyyyMMddHHmmss>-<6 hex chars>  ->  25 chars (column is 32).
 * The timestamp makes it readable and roughly sortable; the random suffix makes
 * collisions between two orders placed in the same second vanishingly unlikely.
 * The `order_number` UNIQUE constraint is still the real guarantee.
 */
function generateOrderNumber(now: Date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `ORD-${stamp}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

function toOrderDetail(order: OrderWithItems): OrderDetailResponse {
  const items: OrderItemResponse[] = order.items.map((item) => ({
    productId: item.productId,
    quantity: item.quantity,
    // The snapshot: what the customer actually paid, independent of the
    // product's current catalog price.
    unitPrice: item.unitPrice.toFixed(2),
    lineTotal: item.unitPrice.mul(item.quantity).toFixed(2),
    product: {
      id: item.product.id,
      name: item.product.name,
      sku: item.product.sku,
      category: item.product.category,
      currentPrice: item.product.price.toFixed(2),
      isActive: item.product.isActive,
    },
  }));

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    totalAmount: order.totalAmount.toFixed(2),
    shippingAddress: order.shippingAddress,
    items,
    itemCount: items.length,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function toOrderSummary(
  order: Order & { _count: { items: number } }
): OrderSummaryResponse {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    totalAmount: order.totalAmount.toFixed(2),
    itemCount: order._count.items,
    createdAt: order.createdAt,
  };
}

/** Row shapes returned by the raw locking reads inside the transaction. */
interface LockedCartRow {
  id: number;
}
interface LockedInventoryRow {
  product_id: number;
  quantity: number;
}

/**
 * POST /api/orders - convert the authenticated user's cart into an order.
 *
 * WHY THIS IS COMPLICATED
 * -----------------------
 * Five facts must hold together or not at all:
 *   1. an Order row exists,
 *   2. its OrderItems exist with the *purchase-time* price,
 *   3. inventory was decremented for exactly those quantities,
 *   4. the cart is emptied,
 *   5. the total equals SUM(unitPrice x quantity).
 *
 * WHY THE NAIVE READ-THEN-WRITE OVERSELS
 * --------------------------------------
 * The obvious implementation is:
 *     SELECT quantity FROM inventory WHERE product_id = 1;   -- both see 1
 *     if (quantity >= 1) UPDATE inventory SET quantity = 0;  -- both commit
 * Two customers checking out the last unit simultaneously both read "1", both
 * pass the check, and both write - selling one unit twice. The read and the
 * write are not protected against each other.
 *
 * HOW THIS IMPLEMENTATION PREVENTS IT
 * -----------------------------------
 * Inside the transaction we take *exclusive row locks* before deciding:
 *
 *   SELECT ... FOR UPDATE   (on the cart row, then on the inventory rows)
 *
 * `FOR UPDATE` means "reserve these rows; anyone else touching them waits".
 * The second checkout therefore blocks at its inventory read until the first
 * transaction commits, then re-reads the *post-commit* value (0) and correctly
 * fails with 409. The check-then-write becomes safe because the rows cannot
 * change between the check and the write; the decrement is additionally an
 * atomic `quantity = quantity - n`.
 *
 * LOCK ORDERING (deadlock avoidance)
 * ----------------------------------
 * Deadlock happens when two transactions grab the same two rows in opposite
 * orders. We avoid it two ways:
 *   - the inventory rows are locked by ONE statement with `ORDER BY product_id`,
 *     so MySQL acquires them in a globally consistent ascending order;
 *   - every checkout locks its own cart row first, and carts are per-user, so
 *     that lock is never contended between different users.
 *
 * WHAT IS *NOT* DONE HERE
 * -----------------------
 * `Inventory.reservedQuantity` is untouched: the cart never reserves stock
 * (see docs/CART.md). Reservation is a separate future concern.
 */
export async function createOrderFromCart(
  userId: number,
  input: CreateOrderInput
): Promise<OrderDetailResponse> {
  const order = await prisma.$transaction(
    async (tx) => {
      // --- 1. Lock the user's cart row ------------------------------------
      // Locking the cart serializes two concurrent checkouts of the SAME cart
      // (double-clicked "Place order"), so the loser sees an empty cart instead
      // of creating a duplicate order.
      const cartRows = await tx.$queryRaw<LockedCartRow[]>`
        SELECT id FROM carts WHERE user_id = ${userId} FOR UPDATE
      `;
      const cartId = cartRows[0]?.id;
      if (cartId === undefined) {
        throw new AppError('Cart not found for this user', 404);
      }

      // --- 2. Read the cart lines (with the live product rows) ------------
      const cartItems = await tx.cartItem.findMany({
        where: { cartId },
        include: {
          product: {
            select: { id: true, name: true, price: true, isActive: true },
          },
        },
        orderBy: { id: 'asc' },
      });

      if (cartItems.length === 0) {
        // An empty cart is a client-state conflict, not a malformed request:
        // 409 tells the caller "your state is wrong", not "your syntax is wrong".
        throw new AppError('Cart is empty - add items before checking out', 409);
      }

      // --- 3. Lock the inventory rows, in a consistent global order -------
      const productIds = cartItems
        .map((item) => item.productId)
        .sort((a, b) => a - b);

      const lockedInventory = await tx.$queryRaw<LockedInventoryRow[]>`
        SELECT product_id, quantity
        FROM inventory
        WHERE product_id IN (${Prisma.join(productIds)})
        ORDER BY product_id
        FOR UPDATE
      `;
      const stockByProduct = new Map(
        lockedInventory.map((row) => [row.product_id, row.quantity])
      );

      // --- 4. Authoritative validation (inside the lock) ------------------
      // Re-validated here because the cart may be minutes or days old: a
      // product can be deactivated, deleted, or sold out since it was added.
      let totalAmount = new Prisma.Decimal(0);

      for (const item of cartItems) {
        if (!item.product.isActive) {
          throw new AppError(
            `Product "${item.product.name}" is no longer available`,
            409
          );
        }

        const available = stockByProduct.get(item.productId);
        if (available === undefined) {
          throw new AppError(
            `Product "${item.product.name}" has no inventory record`,
            409
          );
        }
        if (available < item.quantity) {
          throw new AppError(
            `Insufficient stock for "${item.product.name}": requested ${item.quantity}, available ${available}`,
            409
          );
        }

        // Decimal math only; the client never supplies a total.
        totalAmount = totalAmount.add(item.product.price.mul(item.quantity));
      }

      // --- 5. Create the order and its items (price snapshot) -------------
      const created = await tx.order.create({
        data: {
          orderNumber: generateOrderNumber(),
          userId,
          status: 'PENDING', // payment happens in a later stage
          totalAmount,
          shippingAddress: input.shippingAddress,
          items: {
            create: cartItems.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              // Snapshot: today's price is frozen into the order forever.
              unitPrice: item.product.price,
            })),
          },
        },
        include: orderDetailInclude,
      });

      // --- 6. Decrement inventory ----------------------------------------
      for (const item of cartItems) {
        await tx.inventory.update({
          where: { productId: item.productId },
          data: { quantity: { decrement: item.quantity } },
        });
      }

      // --- 7. Empty the cart ---------------------------------------------
      // Last, so a rollback anywhere above leaves the cart untouched and the
      // user can simply retry.
      await tx.cartItem.deleteMany({ where: { cartId } });

      return created;
    },
    {
      // Generous ceilings: the transaction holds row locks, so we want it to
      // finish quickly, but lock waits on a busy row must be tolerated.
      maxWait: 5_000,
      timeout: 10_000,
    }
  );

  return toOrderDetail(order);
}

/**
 * GET /api/orders - paginated order history for the authenticated user.
 *
 * Ownership is structural: `where: { userId }` is always applied, so there is
 * no code path that can return someone else's order. Served by
 * `idx_orders_user_id` (already in the schema).
 *
 * Order summaries intentionally skip the items join - the list view needs a
 * count, not the lines, so `_count` avoids fetching data nobody will render.
 */
export async function listOrders(
  userId: number,
  params: ListOrdersParams
): Promise<PaginatedOrders> {
  const { page, limit } = params;
  const where: Prisma.OrderWhereInput = { userId };

  // Sequential (not $transaction) because offset pagination over two reads is
  // already only "approximately consistent"; this is a read-only listing view.
  const [total, orders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy: { id: 'desc' }, // newest first
      skip: (page - 1) * limit,
      take: limit,
      include: { _count: { select: { items: true } } },
    }),
  ]);

  return {
    data: orders.map(toOrderSummary),
    pagination: {
      page,
      limit,
      total,
      // 0 pages for 0 rows keeps the arithmetic honest for an empty history.
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * GET /api/orders/:id - one order belonging to the authenticated user.
 *
 * The `userId` filter is part of the lookup, not a check afterwards: another
 * user's order is indistinguishable from a nonexistent one (404 either way),
 * which also avoids leaking the existence of other users' orders.
 */
export async function getOrderById(
  userId: number,
  orderId: number
): Promise<OrderDetailResponse> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    include: orderDetailInclude,
  });
  if (!order) {
    throw new AppError('Order not found', 404);
  }
  return toOrderDetail(order);
}
