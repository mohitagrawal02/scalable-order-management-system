import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import {
  AddCartItemInput,
  CartItemResponse,
  CartResponse,
  UpdateCartItemInput,
} from './cart.types';
import { CART_LIMITS } from './cart.validation';

/** Per-line ceiling, shared with request validation so both agree. */
const MAX_CART_ITEM_QUANTITY = CART_LIMITS.MAX_QUANTITY_PER_ITEM;

/**
 * Cart business logic.
 *
 * Ownership rule that governs this whole module: every function takes the
 * `userId` that came from the verified JWT. A cart is never looked up by a
 * client-supplied user id, so one user simply cannot address another's cart.
 *
 * Nothing here reserves inventory. See docs/CART.md - the cart is intent.
 */

/** Product fields that are safe (and useful) to embed in a cart response. */
const cartProductSelect = {
  id: true,
  name: true,
  price: true,
  currency: true,
  sku: true,
  category: true,
  isActive: true,
  inventory: { select: { quantity: true } },
} satisfies Prisma.ProductSelect;

type CartWithItems = Prisma.CartGetPayload<{
  include: {
    items: { include: { product: { select: typeof cartProductSelect } } };
  };
}>;

const cartInclude = {
  items: {
    include: { product: { select: cartProductSelect } },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.CartInclude;

/** Maps a Prisma cart aggregate onto the public response shape. */
function toCartResponse(cart: CartWithItems): CartResponse {
  let totalQuantity = 0;
  let totalAmount = new Prisma.Decimal(0);

  const items: CartItemResponse[] = cart.items.map((item) => {
    // Decimal arithmetic only - never Number(), which would reintroduce
    // binary floating-point error into money values.
    const lineTotal = item.product.price.mul(item.quantity);
    totalQuantity += item.quantity;
    totalAmount = totalAmount.add(lineTotal);

    return {
      productId: item.productId,
      quantity: item.quantity,
      lineTotal: lineTotal.toFixed(2),
      product: {
        id: item.product.id,
        name: item.product.name,
        price: item.product.price.toFixed(2),
        currency: item.product.currency,
        sku: item.product.sku,
        category: item.product.category,
        isActive: item.product.isActive,
        availableQuantity: item.product.inventory?.quantity ?? null,
      },
    };
  });

  return {
    id: cart.id,
    items,
    itemCount: items.length,
    totalQuantity,
    totalAmount: totalAmount.toFixed(2),
  };
}

/**
 * Every user gets a cart at registration (Day 2 transaction). This helper is a
 * safety net for data created outside that path (seed scripts, manual SQL):
 * `upsert` keeps the "exactly one cart per user" invariant without a race.
 */
async function getOrCreateCart(userId: number) {
  const existing = await prisma.cart.findUnique({
    where: { userId },
    include: cartInclude,
  });
  if (existing) return existing;

  return prisma.cart.upsert({
    where: { userId },
    update: {},
    create: { userId },
    include: cartInclude,
  });
}

/**
 * POST /api/cart/items - add a product, or increase its quantity if it is
 * already in the cart.
 *
 * The `@@unique([cartId, productId])` constraint makes "one row per product" a
 * database fact, so the write is an `upsert` (Prisma emits
 * INSERT ... ON DUPLICATE KEY UPDATE). That single statement is both atomic and
 * tolerant of double-clicks; a SELECT-then-INSERT would instead race two
 * concurrent adds into a constraint violation.
 */
export async function addCartItem(
  userId: number,
  input: AddCartItemInput
): Promise<CartResponse> {
  const cart = await getOrCreateCart(userId);

  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: { id: true, isActive: true },
  });
  if (!product) {
    throw new AppError('Product not found', 404);
  }
  if (!product.isActive) {
    // Inactive products are hidden from the catalog, so they must not be
    // purchasable either.
    throw new AppError('Product is not available for purchase', 409);
  }

  const existing = await prisma.cartItem.findUnique({
    where: { cartId_productId: { cartId: cart.id, productId: input.productId } },
    select: { quantity: true },
  });

  // Guard the *resulting* quantity, not just the delta.
  if ((existing?.quantity ?? 0) + input.quantity > MAX_CART_ITEM_QUANTITY) {
    throw new AppError(
      `quantity must not exceed ${MAX_CART_ITEM_QUANTITY} per item`,
      400
    );
  }

  await prisma.cartItem.upsert({
    where: { cartId_productId: { cartId: cart.id, productId: input.productId } },
    update: { quantity: { increment: input.quantity } },
    create: {
      cartId: cart.id,
      productId: input.productId,
      quantity: input.quantity,
    },
  });

  return getCart(userId);
}

/**
 * PATCH /api/cart/items/:productId - set an absolute quantity for one line.
 *
 * `updateMany` with an explicit `cartId` filter (rather than `update` by unique
 * key) puts ownership inside the WHERE clause: a product sitting in *someone
 * else's* cart is indistinguishable from one that is not in your cart at all,
 * and both correctly produce 404.
 */
export async function updateCartItem(
  userId: number,
  productId: number,
  input: UpdateCartItemInput
): Promise<CartResponse> {
  const cart = await getOrCreateCart(userId);

  const result = await prisma.cartItem.updateMany({
    where: { cartId: cart.id, productId },
    data: { quantity: input.quantity },
  });
  if (result.count === 0) {
    throw new AppError('Cart item not found', 404);
  }

  return getCart(userId);
}

/** DELETE /api/cart/items/:productId - remove one line from the user's cart. */
export async function removeCartItem(
  userId: number,
  productId: number
): Promise<CartResponse> {
  const cart = await getOrCreateCart(userId);

  const result = await prisma.cartItem.deleteMany({
    where: { cartId: cart.id, productId },
  });
  if (result.count === 0) {
    throw new AppError('Cart item not found', 404);
  }

  return getCart(userId);
}
/** GET /api/cart - the authenticated user's cart (empty cart is valid). */
export async function getCart(userId: number): Promise<CartResponse> {
  const cart = await getOrCreateCart(userId);
  return toCartResponse(cart);
}
