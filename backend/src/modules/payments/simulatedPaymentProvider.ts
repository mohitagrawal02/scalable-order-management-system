import { createHash } from 'node:crypto';
import { config } from '../../config';
import { ChargeRequest, ChargeResult, PaymentProvider } from './paymentProvider';

/**
 * Deterministic simulated payment provider.
 *
 * DETERMINISM (no Math.random anywhere)
 * -------------------------------------
 * Random outcomes make failures unreproducible and tests flaky. Instead:
 *   - the default outcome is SUCCESS;
 *   - a caller may explicitly request FAILURE through the documented test hook
 *     (`forcedOutcome`), which is how the failure path is covered by tests;
 *   - the returned provider id is a hash of the attempt's identity, so the
 *     same logical attempt always yields the same id (idempotent by design).
 *
 * WHAT THE CLIENT CAN AND CANNOT CONTROL
 * --------------------------------------
 * A client can ask for a *simulated outcome*; it can never name a payment
 * status. `Payment.status` is written only by the payment service, from this
 * provider's result. Requests can never make the database say SUCCESS.
 *
 * This file is the only place that knows there is no real payment network.
 * Swapping in Stripe means adding one more `PaymentProvider` implementation.
 */
export const simulatedPaymentProvider: PaymentProvider = {
  name: 'simulated',

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const outcome = request.forcedOutcome ?? 'SUCCESS';

    if (outcome === 'FAILURE') {
      return {
        providerPaymentId: null,
        outcome: 'FAILURE',
        failureReason: 'Simulated decline (test hook: simulation.outcome=FAILURE)',
      };
    }

    return {
      providerPaymentId: buildProviderPaymentId(request),
      outcome: 'SUCCESS',
    };
  },
};

/**
 * `sim_` + 24 hex chars, derived from the attempt's identity.
 *
 * Deterministic rather than random: replaying the same attempt reproduces the
 * same provider reference, which mirrors how real providers de-duplicate.
 */
function buildProviderPaymentId(request: ChargeRequest): string {
  const digest = createHash('sha256')
    .update(
      [
        simulatedPaymentProvider.name,
        request.orderReference,
        request.amount,
        request.method,
      ].join('|')
    )
    .digest('hex');

  return `sim_${digest.slice(0, 24)}`;
}

/** Exposed for tests: confirms the simulator is wired up when expected. */
export const simulatedProviderEnabled = config.env !== 'production';
