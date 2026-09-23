import { Request, Response } from 'express';
import { AppError } from '../../errors/AppError';
import * as cartService from './cart.service';
import {
  parseProductIdParam,
  validateAddCartItemInput,
  validateUpdateCartItemInput,
} from './cart.validation';

/**
 * Cart HTTP layer: validate -> call the service -> shape the response.
 * No Prisma, no business rules. Auth is enforced upstream by `requireAuth`,
 * and the identity used is always `req.auth.user.id`.
 */

/** Reads the authenticated user id, or fails loudly if the guard is missing. */
function requireUserId(req: Request): number {
  const user = req.auth?.user;
  if (!user) {
    // Defensive only: requireAuth guarantees this on every mounted route.
    throw new AppError('Authentication required', 401);
  }
  return user.id;
}

/** GET /api/cart */
export async function getCart(req: Request, res: Response): Promise<void> {
  const cart = await cartService.getCart(requireUserId(req));
  res.status(200).json({ cart });
}

/** POST /api/cart/items */
export async function addCartItem(req: Request, res: Response): Promise<void> {
  const input = validateAddCartItemInput(req.body ?? {});
  const cart = await cartService.addCartItem(requireUserId(req), input);
  res.status(201).json({ cart });
}

/** PATCH /api/cart/items/:productId */
export async function updateCartItem(req: Request, res: Response): Promise<void> {
  const productId = parseProductIdParam(req.params.productId);
  const input = validateUpdateCartItemInput(req.body ?? {});
  const cart = await cartService.updateCartItem(
    requireUserId(req),
    productId,
    input
  );
  res.status(200).json({ cart });
}

/** DELETE /api/cart/items/:productId */
export async function removeCartItem(req: Request, res: Response): Promise<void> {
  const productId = parseProductIdParam(req.params.productId);
  const cart = await cartService.removeCartItem(requireUserId(req), productId);
  res.status(200).json({ cart });
}
