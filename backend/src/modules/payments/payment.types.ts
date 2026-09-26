import { OrderStatus, PaymentMethod, PaymentStatus } from '@prisma/client';

/**
 * Payment module response/input shapes.
 *
 * Money is serialized as a string (`Decimal.toFixed(2)`), never a JS number -
 * same rule as the orders module.
 *
 * Note what is absent: there is NO client-supplied amount or userId field
 * anywhere in these types. The amount comes from `Order.totalAmount` and the
 * owner from the JWT; the database is never told anything about money based
 * on what a request body claims.
 */

/** Safe payment representation returned by the API. */
export interface PaymentResponse {
  id: number;
  orderId: number;
  /** Server-derived: Order.totalAmount at the time of the attempt. */
  amount: string;
  status: PaymentStatus;
  method: PaymentMethod;
  /** Provider-side reference (`sim_...`), null until a charge succeeds. */
  transactionRef: string | null;
  /** How many times the provider has been asked to charge this order. */
  attemptCount: number;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Minimal order identity paired with a payment in responses. */
export interface PaymentOrderSummary {
  id: number;
  orderNumber: string;
  status: OrderStatus;
}

/** Result of POST /api/orders/:orderId/payments. */
export interface CreatePaymentResult {
  payment: PaymentResponse;
  order: PaymentOrderSummary;
  /**
   * True when this request was an idempotent replay (same key seen before) and
   * NO new provider charge was performed.
   */
  replayed: boolean;
}

/** Validated input for creating/attempting a payment. */
export interface CreatePaymentInput {
  idempotencyKey: string;
  method: PaymentMethod;
  /**
   * Test-only simulated outcome (see simulatedPaymentProvider). Never honored
   * outside the simulator; a real provider would ignore it entirely.
   */
  forcedOutcome?: 'SUCCESS' | 'FAILURE';
}
