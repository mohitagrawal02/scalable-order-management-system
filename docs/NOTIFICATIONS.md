# Notifications (Days 5 & 7)

## 1. API

| Method | Path                | Auth | Purpose                                    |
| ------ | ------------------- | ---- | ------------------------------------------ |
| GET    | `/api/notifications` | JWT | The **authenticated user's** notifications, newest first |

Query: `?page=1&limit=20` (`limit` ≤ 100). Response follows the project's
standard envelope:

```json
{
  "data": [
    {
      "id": 3,
      "type": "PAYMENT_SUCCEEDED",
      "message": "Payment received for order ORD-....",
      "read": false,
      "createdAt": "2026-09-24T...",
      "order": { "id": 7, "orderNumber": "ORD-...", "status": "PAID" }
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 2, "totalPages": 1 }
}
```

## 2. Ownership: identity comes only from the JWT

The controller reads `req.auth.user.id` (same `requireUserId` guard as the
payment/order controllers) and passes it to the service. There is **no code
path** that accepts a `userId` from the body or query string — a
`?userId=<someone-else>` parameter is simply ignored, so one user can never
list another user's notifications. Unauthenticated access → **401**.

## 3. Creation: the consumer writes it, not the payment transaction

`notification.service.ts` exposes two creators that take a Prisma **transaction
client** (`tx`) as their first argument:

- `createPaymentSucceededNotification(tx, …)` → type `PAYMENT_SUCCEEDED`
- `createPaymentFailedNotification(tx, …)` → type `PAYMENT_FAILED`

The **notification consumer** (`notification.consumer.ts`, Day 7) calls them.
A payment no longer writes a notification at all: it commits an `OrderPaid` /
`PaymentFailed` event to `outbox_events` **in the same transaction** as the
payment and order state, and the worker publishes that event to Kafka so this
consumer can turn it into a notification (see `docs/KAFKA.md`).

Consequences:

- a notification exists **iff** its event was consumed - no notification for a
  payment that was never committed (the outbox row rolls back with it), and no
  notification silently lost (a failing handler is retried, then dead-lettered);
- the write is **idempotent**: a `processed_events` marker keyed on
  `(consumer_group, event_id)` is inserted in the SAME transaction as the
  notification, so at-least-once delivery can never produce two rows;
- the read path (`listNotifications`) is unchanged - notifications are still
  never "sent" anywhere.

Types come from the existing `NotificationType` enum
(`ORDER_CONFIRMED, PAYMENT_SUCCEEDED, PAYMENT_FAILED, ORDER_SHIPPED,
ORDER_CANCELLED, ORDER_DELIVERED`) — no schema change was needed; the
order-lifecycle types are simply unused until later stages. `orderId` links
the notification to its order (`ON DELETE SET NULL`), and the response
embeds a small order summary when that link exists.

## 4. Why asynchronous now (Day 7)

Day 5 wrote the notification inside the payment transaction and documented why:
the fan-out was one row, so an outbox/queue would have been pure overhead.
**Day 7 paid that cost deliberately**, for three reasons:

- the notification path is no longer inside the transaction the customer is
  waiting for, so it can never slow down or fail a payment;
- the same event now feeds any number of future consumers (email, analytics,
  search, webhooks) without touching the payment code;
- the pattern is the lesson: the outbox, at-least-once delivery, consumer
  idempotency and the dead-letter queue are the machinery every asynchronous
  side effect needs.

What it costs: notifications are **eventually consistent** - a few milliseconds
behind the response in normal operation, and longer while the broker is down,
because the events simply wait in `outbox_events`. The creation API and the
ownership rules above are unchanged.

Full detail: [`docs/KAFKA.md`](./KAFKA.md).
stay unchanged.
