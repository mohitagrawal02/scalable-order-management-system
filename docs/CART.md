# Cart Module

The shopping cart records **what a user intends to buy**. It is not a
reservation, not a price quote, and not a stock guarantee. Everything else in
this document follows from that one sentence.

---

## 1. Where it sits

```
Client
  ↓
Express
  ↓
Cart Router              (mounts requireAuth once for the whole router)
  ↓
Validation               cart.validation.ts   (AppError(400))
  ↓
Controller               HTTP in/out only
  ↓
Service                  ownership + business rules
  ↓
Prisma
  ↓
MySQL
```

Files: `cart.router.ts` → `cart.controller.ts` → `cart.service.ts` →
`cart.validation.ts` → `cart.types.ts`.
The layer split is the same one established by the auth (Day 2) and products
(Day 3) modules, so there is exactly one convention to learn.

---

## 2. Endpoints

| Method | Path                             | Auth | Purpose                                    |
| ------ | -------------------------------- | ---- | ------------------------------------------ |
| GET    | `/api/cart`                      | yes  | The authenticated user's cart (empty is valid) |
| POST   | `/api/cart/items`                | yes  | Add a product, or increase its quantity    |
| PATCH  | `/api/cart/items/:productId`     | yes  | Set an absolute quantity for one line      |
| DELETE | `/api/cart/items/:productId`     | yes  | Remove one line                            |

`POST /api/cart/items` → `201`; the other three → `200`. All four return the
**whole updated cart**, so the client never has to guess the resulting state.

```jsonc
// GET /api/cart
{
  "cart": {
    "id": 1,
    "items": [
      {
        "productId": 10,
        "quantity": 2,
        "lineTotal": "159998.00",
        "product": {
          "id": 10,
          "name": "iPhone 17",
          "price": "79999.00",
          "currency": "INR",
          "sku": "IPHONE-17-128",
          "category": "smartphones",
          "isActive": true,
          "availableQuantity": 8
        }
      }
    ],
    "itemCount": 1,
    "totalQuantity": 2,
    "totalAmount": "159998.00"
  }
}
```

---

## 3. Ownership

`Cart.userId` is `@unique` in the schema: **exactly one cart per user**, created
inside the Day 2 registration transaction.

Every cart function takes the `userId` that came from the verified JWT
(`req.auth.user.id`). No endpoint accepts a `userId` in the body, and no query
is ever built from a client-supplied user id. A user therefore *cannot* address
another user's cart — not because a check blocks it, but because the owner is
part of the lookup itself:

```ts
prisma.cartItem.updateMany({ where: { cartId: cart.id, productId } })
//                                  ^^^^^^^^^^^^ from the JWT, not the request
```

There is no "get cart by id" endpoint at all, so IDOR (insecure direct object
reference) has no surface here.

## 4. CartItem uniqueness

```prisma
@@unique([cartId, productId], map: "uq_cart_items_cart_product")
```

One row per `(cart, product)`. Adding iPhone twice must not create two lines, so
the write is an **upsert** (`INSERT ... ON DUPLICATE KEY UPDATE`):

- it is a *single* statement, so two concurrent adds cannot race each other into
  a constraint violation;
- a double-clicked "Add to cart" merges into one line instead of erroring;
- the database constraint — not application code — guarantees the invariant.

The service also guards the **resulting** quantity, not just the delta: adding 60
to an existing 60 is rejected even though `60` alone is within the per-line cap.

## 5. Adding / updating / removing

| Action            | Behaviour                                                                 |
| ----------------- | ------------------------------------------------------------------------- |
| Add new product   | creates the line                                                          |
| Add existing      | `quantity += n` (increases; never duplicates)                             |
| Product missing   | `404`                                                                     |
| Product inactive  | `409` — hidden from the catalog means not purchasable either              |
| Bad quantity      | `400` — must be an integer, ≥ 1, ≤ 100 per line                           |
| Update to `0`     | `400`, **not** a removal — removal has its own endpoint (no hidden state change) |
| Update/remove a line not in *your* cart | `404` (indistinguishable from "doesn't exist")       |

`quantity` is validated as an integer explicitly: `1.5`, `"2"` and `-1` are all
rejected. Backend validation is authoritative — client-side validation is a

---

## 6. Cart validation vs checkout validation

Adding an item does **not** guarantee it can still be bought.

```
10:00  stock = 1        user adds iPhone × 1 to the cart
10:05  another customer checks out → stock = 0
10:07  our user checks out → 409 Insufficient stock
```

- **Cart stores intent.** It is long-lived and volatile-proof: products get
  deactivated, deleted, or sold out while a cart sits open for days.
- **Checkout performs the authoritative check.** Stock is validated *inside* the
  checkout transaction, under row locks, immediately before it is decremented
  (see [`ORDERS.md`](./ORDERS.md) §3–4). That is the only moment the answer can
  be trusted.
- The cart never reserves stock. Reserving on "add" would freeze inventory for
  abandoned carts (most carts never convert) and would require TTL/expiry
  machinery that nothing yet justifies.
- The cart API does not reject quantities above current stock on purpose — a
  stock-limited add would make the endpoint lie ("out of stock" today, "in
  stock" tomorrow) and still not make checkout safe. `availableQuantity` is
  exposed so the UI can *warn*, never enforce.

## 7. Money handling

- `price` is `DECIMAL(10,2)` in MySQL, `Prisma.Decimal` in TypeScript.
- `lineTotal = price.mul(quantity)`; `totalAmount` accumulates with `.add()`.
- Never `Number(...)`, never `parseFloat`, never `0.1 + 0.2` — binary floating
  point must not touch money.
- Serialized with `.toFixed(2)` → a **string** in JSON, so no JS runtime or
  client can silently round it.
- Cart totals use the **current catalog price** and are informational. The
  amount that matters is recomputed at checkout and frozen (ORDERS.md §5).

## 8. Indexes — what each query uses

| Query (every request)             | Index that serves it                                    |
| --------------------------------- | ------------------------------------------------------- |
| find the user's cart              | `carts.user_id` UNIQUE                                  |
| load the cart's lines             | `uq_cart_items_cart_product` (prefix `cart_id`)         |
| upsert/patch/delete one line      | the same composite unique index                         |
| FK integrity on `product_id`      | `cart_items_product_id` (auto-created FK index)         |

**Zero new indexes were added on Day 4**: every cart query is a point lookup on
an index that already existed for a constraint or a Day-1 query pattern.

## 9. Known limitations / future evolution

- **No price/stock drift warnings yet** — a UI badge ("price changed",
  "only 2 left") can be added later by comparing the cart snapshot against live
  values at read time.
- **No guest carts / cart merge** — arrives with sessions, if ever needed.
- **No cart-level discount/coupon fields** — deferred with payments (Day 5+).
- **Redis** would become useful when carts are read on every page view; today
  every cart read is already a couple of unique-index lookups on tiny rows.
- `Inventory.reservedQuantity` exists in the schema and is untouched — it is
  the natural home for real reservations when payments/fulfillment arrive.

convenience, never a control.
