import { Request, Response } from 'express';
import { AppError } from '../../errors/AppError';
import { parseOrderIdParam } from '../orders/order.validation';
import {
  createPayment,
  getPaymentForOrder,
  PaymentResponse,
} from './payment.service';
import { validateCreatePaymentInput } from './payment.validation';

/**
 * Payment HTTP layer. Controllers stay thin: parse -> validate -> service ->
 * respond. All business rules (ownership, state machine, idempotency) live in
 * the service so they cannot be bypassed by any other entry point.
 */

/**
 * POST /api/orders/:orderId/payments
 *
 * Note the request body carries NO amount. The authoritative amount always
 * comes from Order.totalAmount inside the service (trust boundary).
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

export async function createPaymentHandler(
  req: Request,
  res: Response
): Promise<void> {
  const orderId = parseOrderIdParam(req.params.orderId);
  const input = validateCreatePaymentInput(req.body);
  const userId = requireUserId(req);

  const result = await createPayment(userId, orderId, input);

  // 201 = we performed a charge now; 200 = an idempotent replay/reuse.
  res.status(result.replayed ? 200 : 201).json({
    payment: result.payment,
    order: result.order,
    replayed: result.replayed,
  });
}

/** GET /api/orders/:orderId/payments - payment for the caller's own order. */
export async function getPaymentHandler(
  req: Request,
  res: Response
): Promise<void> {
  const orderId = parseOrderIdParam(req.params.orderId);
  const userId = requireUserId(req);

  const payment: PaymentResponse | null = await getPaymentForOrder(
    userId,
    orderId
  );
  if (!payment) {
    // Ownership passed (the service 404s otherwise), so this order simply has
    // no payment attempt yet.
    throw new AppError('No payment found for this order', 404);
  }
  res.status(200).json({ payment });
}