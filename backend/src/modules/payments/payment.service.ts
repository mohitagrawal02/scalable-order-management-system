import { Order, Payment, Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import {
  createPaymentFailedNotification,
  createPaymentSucceededNotification,
} from '../notifications/notification.service';
import { assertOrderTransition, assertPaymentTransition } from './payment.states';
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentOrderSummary,
  PaymentResponse,
} from './payment.types';
import { ChargeResult, PaymentProvider } from './paymentProvider';
import {
  simulatedPaymentProvider,
  simulatedProviderEnabled,
} from './simulatedPaymentProvider';

// The controller imports PaymentResponse from this module; re-export it so the
// HTTP layer has a single import site.
export type { PaymentResponse } from './payment.types';

/**
 * Payment service - the heart of Day 5.
 *
 * WHY PAYMENTS ARE HARDER THAN CRUD
 * ----------------------------------
 * An external payment provider CANNOT join our MySQL transaction. We must
 * therefore split the work into phases and be explicit about what each phase
 * guarantees:
 *
 *   Phase A (tx 1):  lock the order row (SELECT ... FOR UPDATE, same pattern
 *                    as Day-4 checkout) -> ownership check -> state machine ->
 *                    idempotency-key replay lookup -> create/retry the payment
 *                    row as PROCESSING and move the order to
 *                    PAYMENT_PROCESSING. Unique constraints
 *                    (orderId @unique, idempotencyKey @unique) are the
 *                    concurrency safety net; P2002 is caught and translated
 *                    into a replay or a 409.
 *   Phase B (no tx): call the provider with the SERVER-SIDE amount
 *                    (order.totalAmount). The provider lives outside our
 *                    transaction; if it throws we treat the attempt as a
 *                    failure with a safe reason.
 *   Phase C (tx 2):  persist the outcome atomically - payment state, order
 *                    state and the notification commit TOGETHER (each update
 *                    is compare-and-swap guarded by the expected status, so a
 *                    surprise state change rolls the whole thing back).
 *
 * The observable invariant: you can never see SUCCEEDED payment paired with a
 * non-PAID order, because both writes happen in one transaction.
 *
 * KNOWN LIMITATION (documented, not solved today): a crash between Phase A and
 * Phase C leaves payment=PROCESSING / order=PAYMENT_PROCESSING until a future
 * reconciliation job resets it. Real providers also need webhooks for the same
 * reason - see docs/PAYMENTS.md.
 */

/** Single currency until multi-currency becomes a real requirement. */
const CURRENCY = 'INR';

/** The only provider wired up today; swapping in Stripe changes this line. */
const provider: PaymentProvider = simulatedPaymentProvider;

/** Generous ceilings: the transaction holds an order-row lock (Day-4 style). */
const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

/** Result of Phase A. Both variants carry the same rows; only intent differs. */
type PhaseA =
  | { kind: 'replay'; payment: Payment; order: Order }
  | { kind: 'charge'; payment: Payment; order: Order };

/** Safe API shape for a payment row. Money always as a decimal string. */
function toPaymentResponse(row: Payment): PaymentResponse {
  return {
    id: row.id,
    orderId: row.orderId,
    amount: row.amount.toFixed(2),
    status: row.status,
    method: row.method,
    transactionRef: row.transactionRef,
    attemptCount: row.attemptCount,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toOrderSummary(order: Order): PaymentOrderSummary {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
  };
}

/**
 * POST /api/orders/:orderId/payments - create/attempt a payment.
 *
 * `replayed: true` means the idempotency key matched an existing payment and
 * NO new provider charge was performed (controller answers 200 instead 201).
 */
export async function createPayment(
  userId: number,
  orderId: number,
  input: CreatePaymentInput
): Promise<CreatePaymentResult> {
  // ------- Phase A: transactionally prepare the attempt (locks the order) --
  let phaseA: PhaseA;
  try {
    phaseA = await prisma.$transaction(async (tx): Promise<PhaseA> => {
      // Row lock - same pattern as Day-4 checkout. It serializes concurrent
      // attempts for THIS order, so at most one of them can reach the provider
      // (the unique constraints remain the safety net underneath).
      const locked = await tx.$queryRaw<
        Array<{ id: number; user_id: number }>
      >`SELECT id, user_id FROM orders WHERE id = ${orderId} FOR UPDATE`;

      // Another user's order is indistinguishable from a missing one (404),
      // matching the orders-module convention.
      if (locked.length === 0 || locked[0].user_id !== userId) {
        throw new AppError('Order not found', 404);
      }

      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      const existing = await tx.payment.findUnique({ where: { orderId } });

      // (A) Same key seen before -> idempotent replay, NO new charge.
      if (existing && existing.idempotencyKey === input.idempotencyKey) {
        return { kind: 'replay', payment: existing, order };
      }

      if (existing) {
        // (C) Already paid -> never a second successful payment, whatever key
        // the client sends now.
        if (existing.status === 'SUCCEEDED' || order.status === 'PAID') {
          throw new AppError('Order has already been paid', 409);
        }
        // Concurrent attempt with a DIFFERENT key while one is in flight.
        if (existing.status === 'PROCESSING') {
          throw new AppError(
            'A payment for this order is already in progress',
            409
          );
        }

        // (D) Retry: the FAILED (or never-charged PENDING) row is REUSED -
        // orderId @unique forbids a second payment row per order, which is
        // exactly what makes "at most one success" structural.
        assertPaymentTransition(existing.status, 'PROCESSING');
        assertOrderTransition(order.status, 'PAYMENT_PROCESSING');

        const payment = await tx.payment.update({
          where: { id: existing.id },
          data: {
            idempotencyKey: input.idempotencyKey,
            method: input.method,
            status: 'PROCESSING',
            attemptCount: { increment: 1 },
            failureReason: null,
          },
        });
        const updatedOrder = await tx.order.update({
          where: { id: order.id },
          data: { status: 'PAYMENT_PROCESSING' },
        });
        return { kind: 'charge', payment, order: updatedOrder };
      }

      // Fresh payment. Only a PENDING order is payable (state machine).
      // The amount written here is Order.totalAmount read under the lock -
      // the client never supplied a number (trust boundary).
      assertOrderTransition(order.status, 'PAYMENT_PROCESSING');

      const payment = await tx.payment.create({
        data: {
          orderId: order.id,
          amount: order.totalAmount,
          status: 'PROCESSING',
          method: input.method,
          idempotencyKey: input.idempotencyKey,
          attemptCount: 1,
        },
      });
      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: { status: 'PAYMENT_PROCESSING' },
      });
      return { kind: 'charge', payment, order: updatedOrder };
    }, TX_OPTIONS);
  } catch (err) {
    // Unique-constraint safety net on top of the row lock: the same
    // idempotencyKey used for a DIFFERENT order collides on the global unique
    // index. Translate - never leak - the Prisma error.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new AppError(
        'idempotencyKey was already used for another request',
        409
      );
    }
    throw err;
  }

  // ------- Phase A replay: same key, already-known result -----------------
  if (phaseA.kind === 'replay') {
    return {
      payment: toPaymentResponse(phaseA.payment),
      order: toOrderSummary(phaseA.order),
      replayed: true,
    };
  }

  // ------- Phase B: call the provider OUTSIDE any DB transaction ----------
  // The provider cannot join our MySQL transaction (documented in
  // docs/PAYMENTS.md). The amount sent is ALWAYS Order.totalAmount read in
  // Phase A - a client-supplied amount never exists at this point.
  let charge: ChargeResult;
  try {
    charge = await provider.charge({
      amount: phaseA.order.totalAmount.toFixed(2),
      currency: CURRENCY,
      orderReference: phaseA.order.orderNumber,
      method: phaseA.payment.method,
      forcedOutcome: simulatedProviderEnabled
        ? input.forcedOutcome
        : undefined, // test hook is inert in production
    });
  } catch (err) {
    // A provider that throws has told us nothing definitive; treat the attempt
    // as failed (retryable) rather than guessing SUCCESS.
    charge = {
      providerPaymentId: null,
      outcome: 'FAILURE',
      failureReason:
        err instanceof Error ? 'Provider error' : 'Unknown provider error',
    };
  }

  // ------- Phase C: persist the outcome atomically ------------------------
  // payment + order + notification commit TOGETHER. The observable invariant:
  // you can never see SUCCEEDED payment paired with a non-PAID order.
  const saved = await prisma.$transaction(async (tx) => {
    if (charge.outcome === 'SUCCESS') {
      assertPaymentTransition('PROCESSING', 'SUCCEEDED');
      assertOrderTransition('PAYMENT_PROCESSING', 'PAID');

      const payment = await tx.payment.update({
        where: { id: phaseA.payment.id },
        data: {
          status: 'SUCCEEDED',
          transactionRef: charge.providerPaymentId,
          failureReason: null,
        },
      });
      const order = await tx.order.update({
        where: { id: phaseA.order.id },
        data: { status: 'PAID' },
      });
      await createPaymentSucceededNotification(tx, {
        userId,
        orderId: order.id,
        orderNumber: order.orderNumber,
      });
      return { payment, order };
    }

    // Failure: payment FAILED and order returns to PENDING (payable again).
    // A FAILED payment can never be paired with a PAID order.
    assertPaymentTransition('PROCESSING', 'FAILED');
    assertOrderTransition('PAYMENT_PROCESSING', 'PENDING');

    const reason = (charge.failureReason ?? 'Payment failed').slice(0, 255);
    const payment = await tx.payment.update({
      where: { id: phaseA.payment.id },
      data: { status: 'FAILED', failureReason: reason },
    });
    const order = await tx.order.update({
      where: { id: phaseA.order.id },
      data: { status: 'PENDING' },
    });
    await createPaymentFailedNotification(tx, {
      userId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      reason,
    });
    return { payment, order };
  }, TX_OPTIONS);

  return {
    payment: toPaymentResponse(saved.payment),
    order: toOrderSummary(saved.order),
    replayed: false,
  };
}

/**
 * GET /api/orders/:orderId/payments - the payment for the caller's order.
 *
 * Ownership is part of the query (same convention as orders): another user's
 * order is indistinguishable from a missing one, and an order that simply has
 * no payment attempt yet returns null -> controller answers 404.
 */
export async function getPaymentForOrder(
  userId: number,
  orderId: number
): Promise<PaymentResponse | null> {
  const payment = await prisma.payment.findFirst({
    where: { orderId, order: { userId } },
  });
  return payment ? toPaymentResponse(payment) : null;
}
