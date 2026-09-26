import { PaymentMethod } from '@prisma/client';
import { AppError } from '../../errors/AppError';
import { CreatePaymentInput } from './payment.types';

/**
 * Request validation for the payments module (same conventions as cart/orders:
 * dependency-free helpers throwing AppError(400)).
 *
 * WHAT IS DELIBERATELY ABSENT: `amount`, `userId`, `orderId`-as-body and
 * `status`. The server derives the amount from Order.totalAmount, the owner
 * from the JWT, the order from the URL, and the status from the provider
 * result. A malicious body cannot influence any of them.
 */

/** Matches Payment.idempotencyKey @db.VarChar(191). */
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 191;

const SUPPORTED_METHODS: readonly PaymentMethod[] = ['CARD', 'UPI', 'COD'];
const SUPPORTED_OUTCOMES = ['SUCCESS', 'FAILURE'] as const;

export const PAYMENT_VALIDATION_LIMITS = {
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
} as const;

/** Validates POST /api/orders/:orderId/payments. */
export function validateCreatePaymentInput(
  body: Record<string, unknown>
): CreatePaymentInput {
  // --- idempotency key (required) -----------------------------------------
  const rawKey = body.idempotencyKey;
  if (typeof rawKey !== 'string' || rawKey.trim().length === 0) {
    throw new AppError('idempotencyKey is required', 400);
  }
  const idempotencyKey = rawKey.trim();
  if (idempotencyKey.length < MIN_KEY_LENGTH) {
    throw new AppError(
      `idempotencyKey must be at least ${MIN_KEY_LENGTH} characters`,
      400
    );
  }
  if (idempotencyKey.length > MAX_KEY_LENGTH) {
    throw new AppError(
      `idempotencyKey must be at most ${MAX_KEY_LENGTH} characters`,
      400
    );
  }

  // --- payment method (optional, defaults to CARD) ------------------------
  let method: PaymentMethod = 'CARD';
  if (body.method !== undefined) {
    if (
      typeof body.method !== 'string' ||
      !SUPPORTED_METHODS.includes(body.method as PaymentMethod)
    ) {
      throw new AppError(
        `method must be one of: ${SUPPORTED_METHODS.join(', ')}`,
        400
      );
    }
    method = body.method as PaymentMethod;
  }

  // --- simulated outcome (test hook only) ---------------------------------
  let forcedOutcome: 'SUCCESS' | 'FAILURE' | undefined;
  if (body.simulation !== undefined) {
    const simulation = body.simulation;
    if (typeof simulation !== 'object' || simulation === null || Array.isArray(simulation)) {
      throw new AppError('simulation must be an object', 400);
    }
    const outcome = (simulation as Record<string, unknown>).outcome;
    if (outcome !== undefined) {
      if (
        typeof outcome !== 'string' ||
        !SUPPORTED_OUTCOMES.includes(outcome as 'SUCCESS' | 'FAILURE')
      ) {
        throw new AppError(
          `simulation.outcome must be one of: ${SUPPORTED_OUTCOMES.join(', ')}`,
          400
        );
      }
      forcedOutcome = outcome as 'SUCCESS' | 'FAILURE';
    }
  }

  return { idempotencyKey, method, forcedOutcome };
}
