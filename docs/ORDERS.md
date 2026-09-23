# Orders & Transactional Checkout (Day 4)

Checkout is the most complex operation in the platform so far, because five
facts must hold **together or not at all**:

1. an `Order` row exists (with a server-computed total),
2. its `OrderItem` rows exist, carrying the **purchase-time price**,
3. inventory was decremented by exactly the ordered quantities,
4. the cart is emptied,
5. no other customer could buy the same units in between.

This document explains how the implementation makes that true — including when
two customers race for the last unit.

---

## 1. Request flow

```
Client
  ↓
requireAuth                       (JWT → req.auth.user.id)
  ↓
Order Router                      order.router.ts
  ↓
Validation                        order.validation.ts   (AppError 400)
  ↓
Controller                        order.controller.ts   (HTTP in/out only)
  ↓
Service                           order.service.ts
  ↓
BEGIN TRANSACTION
  ├─ lock cart row        SELECT … FOR UPDATE
  ├─ read cart lines      (+ product rows, ORDER BY id)
  ├─ lock inventory rows  SELECT … ORDER BY product_id FOR UPDATE
  ├─ validate             active? inventory exists? stock ≥ requested?
  ├─ create Order         (status PENDING, total = SUM(unitPrice × qty))
  ├─ create OrderItems    (unitPrice = snapshot of Product.price)
  ├─ decrement inventory  quantity = quantity − n   (per line)
  ├─ delete cart lines
  └─ COMMIT
  ↓
Order response                    (201) — or ROLLBACK + clean error
```

## 2. What a transaction guarantees (ACID)

- **Atomicity** — the whole checkout is one unit. If *any* statement fails
  (insufficient stock, a constraint, a crash), every write above it is undone:
  no partial order, no orphan order items, no half-decremented stock, and the
  cart is left untouched so the user can simply retry.
- **Consistency** — every invariant the schema declares still holds at COMMIT:
  FK targets exist, `total_amount` matches the items, stock never goes negative
  (the validation forbids it before the update is attempted).
- **Isolation** — while our transaction holds row locks on an inventory row, no
  other transaction can read-then-write that row. Concurrent checkouts on the
  same product are *serialized*: one wins, the loser re-reads the post-commit
  value and fails cleanly (§3).
- **Durability** — after COMMIT, the order survives crashes and restarts; MySQL
  has already written it to the redo log.

## 3. The inventory race, and why naive code oversells

The obvious implementation:

```sql
-- Customer A and Customer B run this "at the same time", stock = 1
SELECT quantity FROM inventory WHERE product_id = 1;  -- both read 1
-- application: if (quantity >= requested) then:
UPDATE inventory SET quantity = quantity - 1;         -- both commit
```

Both read `1`, both pass the check, both decrement → **one unit sold twice**
(stock = −1). The read and the write are two separate moments, and between them
the world can change. A check in application code cannot fix this; only the
database can, because only the database sees both writers.

### How this implementation prevents it

Inside the transaction, **before deciding anything**, we take exclusive row
locks:

```sql
SELECT id FROM carts WHERE user_id = ? FOR UPDATE;                 -- 1. own cart
SELECT product_id, quantity
FROM inventory
WHERE product_id IN (…)
ORDER BY product_id
FOR UPDATE;                                                        -- 2. stock rows
```

`FOR UPDATE` means: *any other transaction that tries to lock the same row
waits*. So when B's checkout reaches the inventory read while A is still
running, B **blocks** until A commits, then re-reads the *post-commit* value
(now `0`) and fails with `409 Insufficient stock`. The check-then-write becomes
safe because the rows cannot change between the check and the write — and the
decrement itself is a relative `quantity = quantity - n`, not a stale absolute
value.

**Why `SELECT … FOR UPDATE` (raw SQL) instead of a plain Prisma read?** Prisma's
`findMany` issues a plain `SELECT` under MySQL's default `REPEATABLE READ`
isolation: a consistent *snapshot* read that does not block writers and does not
see their commits — exactly the behaviour that allows overselling. There is no
Prisma API for locking reads, so the two locking reads are isolated, commented
raw queries (`tx.$queryRaw` with parameter binding via tagged templates — the
values are sent as parameters, never string-concatenated, so injection is not
possible). Everything else in the transaction stays in the Prisma query builder.

### Lock ordering (deadlock avoidance)

Two transactions each needing two locks in *opposite* order is how deadlocks
happen. Two defences:

- all inventory rows are locked by **one statement** with `ORDER BY product_id`,
  so every checkout acquires them in the same ascending global order;
- each checkout first locks **its own cart row** — carts are per-user, so that
  lock is never contended between different users, but it *does* serialize two
  concurrent checkouts of the same cart (a double-clicked "Place order" — the
  second one sees an empty cart instead of creating a duplicate order).


---

## 4. Validation inside the transaction (why re-check what the cart "knows")

A cart line may be minutes or weeks old. Before writing anything we re-validate,
*while holding the locks*:

- product still exists and `isActive` → otherwise `409` (line stays in the cart;
  the user is told which product is unavailable),
- an inventory row exists → `409` if not,
- `stock ≥ requested` → `409 Insufficient stock` otherwise.

**Why 409 (Conflict) and not 400?** The request is well-formed; what conflicts
is the *server-side state* the client does not control. 409 means "your request
is fine but the current state prevents it". The response names the product and
shows the available quantity so the client can react.

What happens on 409 — verified by tests: **no order row, no order items, no
inventory change, cart untouched.**

## 5. Price snapshots — why `OrderItem.unitPrice` exists

`Product.price` is *current*; it changes with repricing. `OrderItem.unitPrice`
is what the customer actually agreed to pay at checkout, captured in the same
transaction that creates the order.

```
Day 1  checkout: Product.price = 80,000  → order_items.unit_price = 80000.00
Day 30 repricing: Product.price = 85,000
Day 31 order history still shows 80,000.00   ← correct; order total unchanged
```

Consequences:

- **Totals are computed from snapshots**: `totalAmount = Σ(unitPrice × qty)`,
  never from `Product.price`. The order total can never drift out of sync with
  its own items.
- **The client never sends a total.** `POST /api/orders` accepts only
  `shippingAddress`; anything else in the body (`totalAmount`, `userId`,
  `status`) is ignored by design — pricing and ownership are server facts.
- Refunds, invoices, and analytics in later stages all read `unitPrice`, so
  they are automatically historically accurate.
- The order detail response *also* returns the product's current price
  (`product.currentPrice`, informational) so a UI can show "price changed" —
  but the money fields are snapshot-only.

## 6. Money handling

- `DECIMAL(10,2)` columns → `Prisma.Decimal` values in code.
- `totalAmount` is accumulated with `Decimal.add(price.mul(quantity))` inside
  the transaction; no floating point ever touches it.
- Serialized as a string via `.toFixed(2)` in every response.

## 7. Order number and status lifecycle

- `orderNumber` is generated server-side (unique in the schema) — a
  human-friendly identifier for support and invoices. The auto-increment `id`
  stays the primary key; exposing sequential ids alone would let anyone count
  our orders.
- Initial status is **`PENDING`** — the schema's "created, unpaid" state:

```
PENDING ──(payment, Day 5)──→ PAID ──→ FULFILLED ──→ SHIPPED ──→ DELIVERED
   │                                                         (terminal)
   └──(cancel/refund paths arrive with payments)──→ CANCELLED / REFUNDED
```

Only `PENDING` is written today. No state machine is implemented yet — status
transitions arrive with the payment stage, enforced in the service layer.

## 8. Reading orders (ownership + pagination)

- `GET /api/orders` — paginated summaries (`{ data, pagination }` envelope,
  same shape as the products list; `page` ≥ 1, `limit` ≤ 100, bad input → 400).
  Served by `idx_orders_user_id`; sorted newest-first on the PK.
- `GET /api/orders/:id` — detail with items. The `userId` filter is part of the
  `findFirst` lookup, **not** a check afterwards: another user's order is
  indistinguishable from a nonexistent one (both `404`), which also avoids
  leaking the existence of other users' orders (an IDOR-safe pattern).
- List rows are summaries (no item join); detail is one indexed query

---

## 9. Idempotency — analysed, deliberately not built

Scenario: the client sends `POST /api/orders`, the network times out *after*
the commit. The client cannot know whether the order exists, and a naive retry
creates a **second order** (and, once payments exist, charges stock twice).

What already protects us: the cart row is locked at the start of the
transaction, so a true double-click while the first request is still running
sees an empty cart and gets `409` instead of duplicating. What does *not*
protect us is a retry **after** a successful commit — inherent to stateless
retries.

The standard fix when needed: the client sends an **`Idempotency-Key`** header;
the server stores `key → response` (unique-indexed) and replays the stored
response for duplicate keys instead of re-executing. That requires real design
decisions (storage — MySQL table now, Redis later; TTL; response capture), and
nothing before payments justifies it. **Planned for the payment stage**, where
"double-charge" makes idempotency mandatory rather than theoretical.

## 10. Indexes used (none added)

| Query                                | Index                                   |
| ------------------------------------ | --------------------------------------- |
| lock the cart (`user_id = ?`)        | `carts.user_id` UNIQUE                  |
| read cart lines                      | `uq_cart_items_cart_product` prefix     |
| lock inventory (`product_id IN (…)`) | `inventory.product_id` UNIQUE           |
| create order / list by user          | `idx_orders_user_id`                    |
| order detail join                    | `order_items.order_id` FK index         |
| order-number lookup                  | `orders.order_number` UNIQUE            |

Every Day-4 write also maintains these indexes — the write overhead is the
price of the read paths above, and all six predate today's work.

## 11. System-design evolution notes (documented, not built)

| Scale / trigger                        | What breaks first                            | Planned answer                                        |
| -------------------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| `?page=50000` on a huge orders table   | `OFFSET` scans and discards the skipped rows | keyset/cursor pagination ("after id X")               |
| millions of rows                       | list queries + index size                    | covering indexes; later partitioning by user/date     |
| read-heavy "my orders" pages           | every page view hits MySQL                   | Redis cache with user-scoped keys (Day 6)             |
| payment confirmations, emails          | slow remote steps would sit inside the checkout transaction | commit first, then publish an event (Kafka/outbox, later stage) |
| two services (orders ≠ payments)       | a cross-service invariant cannot share one transaction | saga / outbox pattern — *why* the outbox exists |
| payment gateway (Day 5)                | order created before payment, but stock must not stay sold if payment fails | reservation semantics via `Inventory.reservedQuantity` + expiry |

The deepest lesson encoded in this module: **a database transaction is the
strongest consistency tool we have, but it only reaches as far as one
database.** Keeping cross-service concerns out of today's checkout means
adopting sagas/outbox later is an *addition*, not a rewrite.

## 12. Error catalogue

| Situation                                   | HTTP | Body (example)                                   |
| ------------------------------------------- | ---- | ------------------------------------------------ |
| missing/invalid/expired JWT                 | 401  | `Authentication required`                        |
| empty cart                                  | 409  | `Cart is empty - add items before checking out`  |
| product deactivated since add               | 409  | `Product "X" is no longer available`             |
| no inventory row for product                | 409  | `Product "X" has no inventory record`            |
| insufficient stock                          | 409  | `Insufficient stock for "X": requested 3, available 1` |
| order not found / not yours                 | 404  | `Order not found`                                |
| bad `:id` / bad paging / bad address        | 400  | validation message                               |
| unexpected database failure                 | 500  | `Internal server error` (details logged, never returned) |

No Prisma error, SQL text, or stack trace ever reaches the client — the global
error handler from Day 1 is the single mapping point.

  (`order_items.order_id` FK index) plus product info.
