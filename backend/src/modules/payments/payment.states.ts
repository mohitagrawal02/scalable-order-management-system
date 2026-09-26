import { OrderStatus, PaymentStatus } from '@prisma/client';
import { AppError } from '../../errors/AppError';

/**
 * Centralized state-transition rules for Day 5.
 *
 * WHY A TABLE INSTEAD OF `if` STATEMENTS SPREAD OVER THE SERVICE
 * --------------------------------------------------------------
 * Transition rules are the kind of logic that quietly diverges when written
 * in five places ("oh, the retry path allows X but the create path doesn't").
 * One table per aggregate makes the whole machine readable at a glance and
 * gives invalid transitions a single, uniform error (409).
 *
 * SIMPLER ALTERNATIVE
 * -------------------
 * A couple of `if (order.status !== 'PENDING') throw` checks inline in the
 * service. Fewer files - and perfectly adequate for one transition. The table
 * earns its place because Day 5 already needs FOUR transitions and later
 * stages (cancel, fulfil, refund) will extend the same machine.
 *
 * THE MACHINES (kept intentionally minimal - only transitions that exist):
 *
 *   Order:       PENDING ──▶ PAYMENT_PROCESSING ──▶ PAID
 *                              │         ▲
 *                              └─────────┘  (payment failed: back to PENDING,
 *                                            so the order stays payable)
 *
 *   Payment:     PROCESSING ──▶ SUCCEEDED
 *                PROCESSING ──▶ FAILED
 *                FAILED      ──▶ PROCESSING   (retry reuses the same row)
 *
 * Invariants the tables encode:
 *  - an order reaches PAID only via PAYMENT_PROCESSING (i.e. only after a
 *    provider-verified success - never directly from a client request);
 *  - a FAILED payment never carries the order to PAID;
 *  - SUCCEEDED is terminal for both machines (no PAID → PAID, no double
 *    charge, no SUCCEEDED → PROCESSING).
 */

/** Allowed OrderStatus transitions. Extended by later milestones. */
export const ORDER_TRANSITIONS: Readonly<
  Record<OrderStatus, readonly OrderStatus[]>
> = {
  PENDING: ['PAYMENT_PROCESSING'],
  PAYMENT_PROCESSING: ['PAID', 'PENDING'], // failure returns the order to PENDING
  PAID: [], // terminal for Day 5 (fulfilment/refund transitions arrive later)
  FULFILLED: [],
  SHIPPED: [],
  DELIVERED: [],
  CANCELLED: [],
  REFUNDED: [],
};

/** Allowed PaymentStatus transitions. */
export const PAYMENT_TRANSITIONS: Readonly<
  Record<PaymentStatus, readonly PaymentStatus[]>
> = {
  PENDING: ['PROCESSING', 'FAILED'],
  PROCESSING: ['SUCCEEDED', 'FAILED'],
  FAILED: ['PROCESSING'], // retry: same row, attemptCount++
  SUCCEEDED: [], // terminal - a succeeded payment is never re-charged
  REFUNDED: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function canTransitionPayment(
  from: PaymentStatus,
  to: PaymentStatus
): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

/** Throws 409 unless the order transition is allowed. */
export function assertOrderTransition(
  from: OrderStatus,
  to: OrderStatus
): void {
  if (!canTransitionOrder(from, to)) {
    throw new AppError(`Invalid order state transition: ${from} → ${to}`, 409);
  }
}

/** Throws 409 unless the payment transition is allowed. */
export function assertPaymentTransition(
  from: PaymentStatus,
  to: PaymentStatus
): void {
  if (!canTransitionPayment(from, to)) {
    throw new AppError(
      `Invalid payment state transition: ${from} → ${to}`,
      409
    );
  }
}
