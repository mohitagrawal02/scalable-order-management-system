# Payments (Day 5)

How a cart order becomes a paid order — and why the flow looks the way it does.

## 1. Endpoints

| Method | Path                             | Auth | Purpose                                  |
| ------ | -------------------------------- | ---- | ---------------------------------------- |
| POST   | `/api/orders/:orderId/payments`  | JWT  | Create/attempt a payment for **your** order |
| GET    | `/api/orders/:orderId/payments`  | JWT  | Read the payment for **your** order        |

Request body for `POST`:

```json
{
  "idempotencyKey": "unique-key-at-least-8-chars",
  "method": "CARD",
  "simulation": { "outcome": "FAILURE" }
}
```

- `idempotencyKey` — **required**, 8–191 chars. Generate one per logical
  payment attempt (e.g. per checkout click), reuse it on retries of that same
  attempt.
- `method` — optional, `CARD | UPI | COD`, defaults to `CARD`.
- `simulation.outcome` — test hook for the simulated provider; honored only
  when `NODE_ENV !== 'production'`.
- **There is deliberately no `amount` field.** Unknown body fields are
  ignored. The amount always comes from `Order.totalAmount` server-side.

Responses: `201` (a charge was performed now), `200` (idempotent replay — no
new charge), `400` validation, `401` unauthenticated, `404` not yours / no
payment yet, `409` invalid state or key conflict.

```json
{
  "payment": {
    "id": 12, "orderId": 7, "amount": "501.00", "status": "SUCCEEDED",
    "method": "CARD", "transactionRef": "sim_ab12...", "attemptCount": 1,
    "failureReason": null, "createdAt": "...", "updatedAt": "..."
  },
  "order": { "id": 7, "orderNumber": "ORD-...", "status": "PAID" },
  "replayed": false
}
```

## 2. Architecture: provider abstraction

```
payment.controller  →  payment.service  →  PaymentProvider (interface)
                                              └── SimulatedPaymentProvider
```

- `paymentProvider.ts` defines `PaymentProvider` (`charge(request)`) — the
  **only** seam to an external payment network. Swapping in Stripe/Razorpay
  means writing one more implementation; nothing else changes.
- `simulatedPaymentProvider.ts` is deterministic (no `Math.random`): default
  outcome SUCCESS, explicit `forcedOutcome` hook for failure tests, and a
  hash-derived `sim_...` provider reference so replays reproduce the same id.

## 3. The trust boundary: where the amount comes from

The client can never decide money. `payment.validation.ts` accepts only
`idempotencyKey`, `method` and the simulation hook — an `amount` field in the
body is silently ignored. The service reads `Order.totalAmount` **inside the
same transaction that locks the order row**, and that is the number sent to
the provider. Same rule as Day-4 checkout (server-computed totals) extended
across the HTTP → provider boundary.

## 4. State machines (centralized in `payment.states.ts`)

```
Order:    PENDING ──→ PAYMENT_PROCESSING ──→ PAID
                        │        ↑
                        └────────┘  (payment failed: back to PENDING)

Payment:  PROCESSING ──→ SUCCEEDED          (terminal)
          PROCESSING ──→ FAILED ──→ PROCESSING   (retry, same row)
```


## 5. Why it's three phases (external system vs. DB transaction)

An external payment provider **cannot join a MySQL transaction**. So the flow
is split, and each phase states its guarantee:

| Phase | Inside tx? | What happens | Guarantee |
| ----- | ---------- | ------------ | --------- |
| A | **yes** | `SELECT … FOR UPDATE` on the order row → ownership → state machine → idempotency lookup → write payment `PROCESSING` + order `PAYMENT_PROCESSING` | Concurrent attempts for one order are serialized; unique constraints are the safety net |
| B | no | `provider.charge(amount = Order.totalAmount)` | Provider lives outside our transaction; a throw = treated as failure |
| C | **yes** | payment final state + order final state + notification commit **together** | You can never observe `SUCCEEDED` payment with a non-`PAID` order |

**Known limitation (documented, accepted today):** a crash between Phase A and
Phase C leaves `payment=PROCESSING / order=PAYMENT_PROCESSING` until a future
reconciliation job resets it. Real providers solve the same problem with
webhooks + reconciliation (see §9).

## 6. Idempotency: two constraints, two jobs

| Constraint | Column | Protects against |
| ---------- | ------ | ---------------- |
| `payments.order_id` **UNIQUE** | one payment row per order | ever creating a *second* payment (→ structurally at most one success) |
| `payments.idempotency_key` **UNIQUE** | one logical attempt per key | the *same client request* being processed twice (lost response, double-click, retry) |

Application-level handling on top of the constraints:

- **Same key, same order, repeated** → Phase A finds the existing row and
  returns it with `replayed: true` (HTTP 200). **No second provider charge.**
- **Same key, concurrently** → the order-row lock serializes the two requests;
  the loser sees the winner's row and replays. If a race still reaches the
  insert, `P2002` on the unique index is caught and translated to a replay /
  409 — the raw Prisma error never reaches the client.
- **Same key, different order** → 409 (global key uniqueness).
- **Different key, order already PAID** → 409 (`Order has already been paid`).

## 7. Retry semantics (chosen behavior)

- A failed payment **retries on the same row** (`attemptCount++`, new
  idempotency key) because `order_id` is unique — retry history is a counter,
  not extra rows. Because there is only ever one row per order, **two
  successful payments for one order are impossible** by construction.
- After a failure the order returns to `PENDING`, so it is payable again.
- Replaying the **old key of a failed attempt** returns the original `FAILED`
  result (idempotency = "same request → same response"), it does **not**
  re-charge. To actually retry, the client issues a **new** key — this mirrors
  how Stripe treats idempotency keys per attempt.

## 8. Why no Kafka/outbox yet

Today a payment is a single synchronous request/response inside one process —
an event bus would add infrastructure without removing any real complexity.
There is no second consumer of "payment succeeded" data yet: the notification
is written in the same transaction, and order history is a direct query.
**The trigger to introduce an outbox + Kafka:** a second service (analytics,
shipping, ledger) must react to `PaymentSucceeded`, or notifications become
email/SMS fan-out that shouldn't slow the payment response. Then Phase C
writes an `outbox` row in the same transaction and a relay publishes it —
at-least-once delivery, consumers idempotent by `payment.id`.

## 9. Real providers: what's deliberately deferred

- **Webhooks** — a real provider confirms the outcome asynchronously (3DS,
  bank delays). Our synchronous Phase B is the simulator's simplification;
  with a real provider, Phase B would *start* the charge and a webhook would
  perform Phase C. The Phase-A/Phase-C structure already matches that shape.
- **Reconciliation** — a scheduled job comparing provider statements with
  `payments` rows resolves the "crash between phases" gap (§5).
- Refunds, PCI scope, real credentials: out of scope for Day 5 by design.

Invariants the tables encode:

- an order reaches `PAID` **only** via `PAYMENT_PROCESSING`, i.e. only after a
  provider-verified success — never directly from a client request;
- a `FAILED` payment never marks the order `PAID` (failure writes
  `payment=FAILED` + `order=PENDING` + a notification in **one** transaction);
- `SUCCEEDED`/`PAID` are terminal for Day 5: no `PAID → PAID`, no recharging a
  succeeded payment, no `PAID → PAYMENT_PROCESSING`.

Any transition not in the table throws **409** with a uniform message.
