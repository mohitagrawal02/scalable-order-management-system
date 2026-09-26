import { PaymentStatus } from '@prisma/client';

/**
 * Provider-facing contract for charging money.
 *
 * WHY AN INTERFACE AT ALL
 * -----------------------
 * The payment *business* rules (is this order payable? has it already been
 * paid? what is the amount?) do not change when you swap a simulated provider
 * for Stripe. Only the "talk to the outside world" part changes. Keeping that
 * part behind a narrow interface means `payment.service.ts` never mentions the
 * simulator, so a real provider is a drop-in replacement.
 *
 * SIMPLER ALTERNATIVE
 * -------------------
 * Call the simulator directly from the service. Fewer files, less ceremony -
 * but the service then encodes provider-specific assumptions, and every test
 * would need an HTTP-level mock instead of a plain function substitution.
 *
 * TRADE-OFF WE ACCEPT
 * -------------------
 * One more indirection for a project with exactly one provider. It is the
 * indirection that is the point of the exercise: this is the seam where
 * eventual consistency, timeouts and webhooks will later live.
 */

/** Outcome of an attempt, as reported by the provider. */
export type ProviderOutcome = 'SUCCESS' | 'FAILURE';

/** What the payment service asks the provider to do. */
export interface ChargeRequest {
  /** Server-derived amount. NEVER taken from the request body. */
  amount: string;
  currency: string;
  /** Our order number - the provider's own reference for the merchant. */
  orderReference: string;
  method: string;
  /**
   * Test-only hook: forces a specific outcome so failure paths are
   * deterministic. A real provider ignores this entirely.
   */
  forcedOutcome?: ProviderOutcome;
}

/** What the provider reports back. Deliberately provider-shaped, not DB-shaped. */
export interface ChargeResult {
  /** Provider-side identifier, e.g. `sim_...`. Null when the charge failed. */
  providerPaymentId: string | null;
  outcome: ProviderOutcome;
  /** Safe, human-readable explanation; never an internal stack trace. */
  failureReason?: string;
}

export interface PaymentProvider {
  readonly name: string;
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

/** Statuses that mean "this attempt is finished and will not change again". */
export const TERMINAL_PAYMENT_STATUSES: ReadonlyArray<PaymentStatus> = [
  'SUCCEEDED',
  'FAILED',
  'REFUNDED',
];

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.includes(status);
}
