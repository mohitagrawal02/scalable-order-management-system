# Notifications (Day 5)

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

## 3. Creation: written inside the payment transaction

`notification.service.ts` exposes two creators that take a Prisma **transaction
client** (`tx`) as their first argument:

- `createPaymentSucceededNotification(tx, …)` → type `PAYMENT_SUCCEEDED`
- `createPaymentFailedNotification(tx, …)` → type `PAYMENT_FAILED`

The payment service calls them in **Phase C**, the same transaction that
writes the final payment status and order status. Consequences:

- a notification exists **iff** the state change it describes was committed —
  no notification for a rolled-back payment, and no payment without its
  notification;
- the read path (`listNotifications`) is a plain query — notifications are
  never "sent" anywhere yet.

Types come from the existing `NotificationType` enum
(`ORDER_CONFIRMED, PAYMENT_SUCCEEDED, PAYMENT_FAILED, ORDER_SHIPPED,
ORDER_CANCELLED, ORDER_DELIVERED`) — no schema change was needed; the
order-lifecycle types are simply unused until later stages. `orderId` links
the notification to its order (`ON DELETE SET NULL`), and the response
embeds a small order summary when that link exists.

## 4. Why synchronous (and when this changes)

Right now the fan-out is exactly one row in the same transaction — an
outbox/queue would be pure overhead. **The future architecture:** when
notifications become email/SMS/push (slow, fallible external work), Phase C will
write the notification *intent* (or an outbox row) transactionally, and a
**background worker** will consume it and call the delivery channels —
retries with backoff, dead-lettering, and no impact on payment latency. That
is the Day-6+ worker milestone; the creation API and ownership rules above
stay unchanged.
