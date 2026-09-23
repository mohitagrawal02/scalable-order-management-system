import { Request, Response } from 'express';
import { AppError } from '../../errors/AppError';
import * as orderService from './order.service';
import {
  parseListOrdersQuery,
  parseOrderIdParam,
  validateCreateOrderInput,
} from './order.validation';

/**
 * Order HTTP layer: validate -> service -> respond.
 *
 * Business rules (pricing, stock, ownership) live in the service; this file only
 * translates HTTP in and out.
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

/** POST /api/orders - checkout the authenticated user's cart. */
export async function createOrder(req: Request, res: Response): Promise<void> {
  const input = validateCreateOrderInput(req.body ?? {});
  const order = await orderService.createOrderFromCart(
    requireUserId(req),
    input
  );
  res.status(201).json({ order });
}

/** GET /api/orders - the authenticated user's order history. */
export async function listOrders(req: Request, res: Response): Promise<void> {
  const params = parseListOrdersQuery(req.query as Record<string, unknown>);
  const result = await orderService.listOrders(requireUserId(req), params);
  res.status(200).json(result);
}

/** GET /api/orders/:id - one of the authenticated user's orders. */
export async function getOrder(req: Request, res: Response): Promise<void> {
  const orderId = parseOrderIdParam(req.params.id);
  const order = await orderService.getOrderById(requireUserId(req), orderId);
  res.status(200).json({ order });
}