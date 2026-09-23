import { AppError } from '../../errors/AppError';
import { AddCartItemInput, UpdateCartItemInput } from './cart.types';

/**
 * Request validation for the cart module.
 *
 * Same convention as the auth/products modules: dependency-free helpers that
 * either return a normalized, typed value or throw AppError(400). Backend
 * validation is authoritative - a client can always be bypassed.
 */

const MIN_QUANTITY = 1;
/**
 * Per-line ceiling. This is a *usability guard*, not a stock guarantee: it
 * stops fat-finger/abusive quantities from reaching checkout. The real
 * authority on "how many are available" is inventory, checked at checkout.
 */
const MAX_QUANTITY_PER_ITEM = 100;

export const CART_LIMITS = { MIN_QUANTITY, MAX_QUANTITY_PER_ITEM } as const;

/**
 * Reads a positive-integer path parameter.
 *
 * Express 5 types route params as `string | string[] | undefined`, so array
 * forms are unwrapped before validation.
 */
export function parseProductIdParam(rawParam: unknown): number {
  const raw = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  if (typeof raw !== 'string') {
    throw new AppError('Invalid product id', 400);
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('Invalid product id', 400);
  }
  return id;
}

function parseProductId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AppError('productId must be a positive integer', 400);
  }
  return value;
}

function parseQuantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AppError('quantity must be an integer', 400);
  }
  if (value < MIN_QUANTITY) {
    // quantity 0 is deliberately NOT treated as a removal: removal has its own
    // endpoint (DELETE /api/cart/items/:productId), so a "0" here is a client
    // bug worth surfacing rather than a hidden state change.
    throw new AppError(
      `quantity must be at least ${MIN_QUANTITY} (use DELETE /api/cart/items/:productId to remove an item)`,
      400
    );
  }
  if (value > MAX_QUANTITY_PER_ITEM) {
    throw new AppError(
      `quantity must not exceed ${MAX_QUANTITY_PER_ITEM}`,
      400
    );
  }
  return value;
}

/** Validates POST /api/cart/items. */
export function validateAddCartItemInput(
  body: Record<string, unknown>
): AddCartItemInput {
  return {
    productId: parseProductId(body.productId),
    quantity: parseQuantity(body.quantity),
  };
}

/** Validates PATCH /api/cart/items/:productId. */
export function validateUpdateCartItemInput(
  body: Record<string, unknown>
): UpdateCartItemInput {
  return { quantity: parseQuantity(body.quantity) };
}
