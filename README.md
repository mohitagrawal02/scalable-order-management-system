# E-commerce & Order Management Platform

A **learning-oriented, production-style** e-commerce platform. Designed to grow
from a small, well-structured application into a scalable event-driven system â€”
one deliberate stage at a time.

> **Status: Days 1–6 complete.** Backend foundation, MySQL schema, JWT auth,
> admin product catalog, the shopping cart, transactional checkout with
> concurrency-safe inventory, simulated payments with idempotency +
> notifications, and **Redis catalog caching + login rate limiting with graceful
> degradation**. Admin order management, the inventory API, and the frontend
> come next.

---

## 1. Project purpose

- A strong **portfolio project** for SDE / backend interviews.
- A practical **system-design learning project**: the architecture evolves with
  each stage, and every technology we add must solve a *real* problem.

The platform will eventually support:

1. User registration & login
2. Product catalog
3. Product search / filtering
4. Shopping cart
5. Order creation
6. Simulated payment processing
7. Inventory management
8. Order status tracking
9. Notifications

## 2. Technology stack

| Layer      | Choice                                    | Why                                                                   |
| ---------- | ----------------------------------------- | --------------------------------------------------------------------- |
| Backend    | Node.js + Express + TypeScript            | Type-safe, huge ecosystem, easy to grow into modular monolith         |
| Database   | MySQL 8                                   | Battle-tested relational store; enums, decimals, FK-safe transactions |
| ORM        | Prisma                                    | Strong typed client + reviewable SQL migrations                       |
| Cache/Rate | Redis (ioredis)                           | O(1) catalog caching, atomic login rate-limiting, fail-open fallback  |
| Frontend   | React + TypeScript *(starts in a later stage)* | Declarative UI, strongest ecosystem for hooking up to a JSON API   |
| Infra      | *Deliberately deferred*                   | Kafka, workers, Docker etc. arrive when they earn their place         |
## 3. Current architecture (Days 1–5)
## 3. Current architecture (Day 1)

```
┌──────────────────────────────┐
│  Express (TypeScript)        │  API layer, runs as a single process
│  └── apiRouter               │    feature modules mounted as routers
│     ├── health / auth        │    GET /api/health · register/login/me + rate limiting
│     ├── products             │    Day 2 & Day 6: cached catalog (detail + list)
│     ├── cart / orders        │    Day 4: cart + transactional checkout
│     └── payments / notifs    │    Day 5: 3-phase payment flow + notifications
│  error handling middleware   │    uniform JSON errors + 404s
└──────────────┬───────────────┘
               │
       ┌───────┴───────────────────────┐
       ▼                               ▼
┌──────────────┐               ┌──────────────┐
│   Redis 8    │               │   MySQL 8    │
│  (ioredis)   │               │ (ecommerce)  │
│              │               │              │
│ · catalog    │               │ · 9 tables   │
│ · rate limit │               │ · ACID txs   │
└──────────────┘               └──────────────┘
```

- **Modular monolith**: one deployable backend with clearly separated modules.
  No microservices yet (see `docs/ARCHITECTURE.md`).
- Schema in `backend/prisma/schema.prisma`, applied via reviewable SQL
  migrations in `backend/prisma/migrations/`.

## 4. Repository layout

```
ecommerce-platform/
â”œâ”€â”€ backend/                  # Node.js + Express + TypeScript API
â”‚   â”œâ”€â”€ prisma/
â”‚   â”‚   â”œâ”€â”€ schema.prisma     # source of truth for the database
â”‚   â”‚   â””â”€â”€ migrations/       # applied, reviewable SQL migrations
â”‚   â””â”€â”€ src/
â”‚       â”œâ”€â”€ config/           # env config + prisma client singleton
â”‚       â”œâ”€â”€ errors/           # AppError used by handlers
â”‚       â”œâ”€â”€ middleware/       # 404 + global error + requireAuth + requireRole
â”‚       â”œâ”€â”€ modules/          # feature modules (health, auth, products, cart, orders)
â”‚       â”œâ”€â”€ routes/           # apiRouter that mounts modules
â”‚       â”œâ”€â”€ app.ts            # express app factory
â”‚       â””â”€â”€ server.ts         # HTTP entrypoint + graceful shutdown
â”‚   â””â”€â”€ tests/
â”‚       â””â”€â”€ integration/      # npm test â†’ real app + real MySQL (Day 4)
â”œâ”€â”€ database/                 # database design docs + DDL reference
â”œâ”€â”€ frontend/                 # (starts in a later stage)
├── docs/
│   ├── ARCHITECTURE.md       # architecture rationale & evolution path
│   ├── AUTH.md               # authentication flows & security decisions
│   ├── PRODUCTS.md           # product catalog, pagination/search/index trade-offs
│   ├── CART.md               # cart-as-intent, uniqueness, upsert semantics
│   ├── ORDERS.md             # transactional checkout, locking, price snapshots
│   ├── PAYMENTS.md           # simulated payment processing, idempotency & state machine
│   ├── NOTIFICATIONS.md      # notifications & user scoping
│   └── REDIS.md              # Redis catalog cache, rate limiting & fail-open resilience
├── .gitignore
â””â”€â”€ README.md
```

## 5. Running locally

### Prerequisites

- Node.js 18+ (developed on 22.x)
- MySQL 8 running locally

### 1. Start (or point at) MySQL and create the database + user

```sql
CREATE DATABASE ecommerce_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'ecommerce_app'@'localhost' IDENTIFIED BY 'app_password123';
GRANT ALL PRIVILEGES ON ecommerce_platform.* TO 'ecommerce_app'@'localhost';
FLUSH PRIVILEGES;
```

> **Heads-up for Windows:** the MySQL **service** often cannot be started
> without an admin PowerShell. A non-admin-friendly alternative is documented
> in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#local-mysql-on-windows-without-admin).

### 2. Configure environment variables

```bash
cd backend
cp .env.example .env     # then edit DATABASE_URL if your MySQL differs
```

### 3. Install, generate client, apply migrations

```bash
cd backend
npm install
npm run prisma:generate
npm run prisma:migrate   # prisma migrate dev -- creates + applies
```

### 4. Run the API

```bash
npm run dev              # ts-node-dev with auto-restart (dev)
# or
npm run build && npm start   # compiled to dist/ (prod-style)
```

### 5. Verify

```bash
curl http://localhost:4000/api/health
# â†’ {"status":"ok","service":"ecommerce-platform-backend","database":"up",...}
```

### Useful scripts

| Script               | What it does                              |
| -------------------- | ----------------------------------------- |
| `npm run dev`        | hot-reload dev server                     |
| `npm run build`      | compile TypeScript to `dist/`             |
| `npm run start`      | run compiled `dist/server.js`             |
| `npm run typecheck`  | `tsc --noEmit`                            |
| `npm test`           | integration tests (real app + real MySQL) |
| `npm run prisma:generate` | (re)generate the Prisma client       |
| `npm run prisma:migrate`  | create & apply a new migration        |
| `npm run prisma:studio`   | browser-based DB explorer             |

## 6. Authentication API (Day 2)

| Method | Path            | Auth required | Purpose                                      |
| ------ | --------------- | ------------- | -------------------------------------------- |
| POST   | `/api/auth/register` | no      | Create a user + cart atomically, bcrypt-hashed password |
| POST   | `/api/auth/login`    | no      | Verify credentials, return a signed JWT     |
| GET    | `/api/auth/me`       | **yes** | Return the authenticated user's safe profile |

Flow documentation: [`docs/AUTH.md`](./docs/AUTH.md) covers registration,
login, JWT verification, why passwords are hashed, why User+Cart creation is a
transaction, and the security/trade-off decisions.

## 7. Product Catalog API (Day 3)

| Method | Path                 | Auth  | Purpose                                            |
| ------ | -------------------- | ----- | -------------------------------------------------- |
| GET    | `/api/products`      | public | List: pagination, `search`, `category`, `minPrice`/`maxPrice` |
| GET    | `/api/products/:id`  | public | Product detail (404 if missing/inactive)           |
| POST   | `/api/products`      | ADMIN | Create a product                                   |
| PATCH  | `/api/products/:id`  | ADMIN | Update product fields                              |
| DELETE | `/api/products/:id`  | ADMIN | Delete (409 if referenced by orders/cart history)  |

- Public listing shape: `{ data: [...], pagination: { page, limit, total, totalPages } }`
- Offsetting pagination with safe caps (`limit` â‰¤ 100); offset-vs-cursor
  trade-offs documented in [`docs/PRODUCTS.md`](./docs/PRODUCTS.md).
- Authorization via reusable `requireRole('ADMIN')` middleware
  (401 unauthenticated / 403 wrong role; role always read from the
  authenticated identity, never the request).

## 8. Cart & Checkout API (Day 4)

| Method | Path                         | Auth | Purpose                                                       |
| ------ | ---------------------------- | ---- | ------------------------------------------------------------- |
| GET    | `/api/cart`                  | JWT  | Own cart (empty cart is a valid response)                     |
| POST   | `/api/cart/items`            | JWT  | Add product / increase existing line (upsert)                 |
| PATCH  | `/api/cart/items/:productId` | JWT  | Set absolute quantity (0 is rejected â€” use DELETE)            |
| DELETE | `/api/cart/items/:productId` | JWT  | Remove one line                                               |
| POST   | `/api/orders`                | JWT  | **Checkout**: cart â†’ order inside one transaction             |
| GET    | `/api/orders`                | JWT  | Own order history (`{ data, pagination }`)                    |
| GET    | `/api/orders/:id`            | JWT  | Own order detail with snapshot prices (404 if not yours)      |

Checkout guarantees (all verified by integration tests):

- **Atomic** â€” order + order items + inventory decrement + cart clear happen in
  one MySQL transaction; any failure rolls back *everything* (verified with a
  fault-injected mid-transaction failure: no partial order, stock untouched,
  cart intact).
- **Concurrency-safe** â€” `SELECT â€¦ FOR UPDATE` row locks (cart row first, then
  inventory rows in `product_id` order) make two customers racing for the last
  unit produce exactly one `201` and one `409` â€” stock can never go negative.
- **Price snapshots** â€” `OrderItem.unitPrice` freezes the purchase price; later
  `Product.price` changes never rewrite history; totals are
  `Î£(unitPrice Ã— qty)`, computed server-side with `Decimal` (never trusted from
  the client).
- **Ownership everywhere** â€” cart and order lookups are keyed by the JWT
  identity; another user's order/cart is indistinguishable from nonexistent
  (404). No `userId` is ever accepted from a request body.

Flow & trade-off documentation: [`docs/CART.md`](./docs/CART.md),
[`docs/ORDERS.md`](./ORDERS.md) (transactions, the oversell race, idempotency
analysis, evolution path).

Integration tests: `cd backend && npm test` (29 tests against the real app +
real MySQL; auto-cleanup, no seed data left behind).

## 9. Payments & Notifications API (Day 5)

| Method | Path                            | Auth | Purpose                                                |
| ------ | ------------------------------- | ---- | ------------------------------------------------------ |
| POST   | `/api/orders/:orderId/payments` | JWT  | Charge **your** order (server-side amount, idempotent) |
| GET    | `/api/orders/:orderId/payments` | JWT  | Read the payment for **your** order                     |
| GET    | `/api/notifications`            | JWT  | Your notifications, newest first (`page`/`limit`)       |

Payment guarantees (all verified by integration + live tests):

- **Server-side amount** â€” the request body has no `amount` field; the value
  charged and stored always equals `Order.totalAmount` (client-supplied
  numbers are ignored).
- **State machines** â€” `PENDING â†’ PAYMENT_PROCESSING â†’ PAID` for orders;
  `PROCESSING â†’ SUCCEEDED | FAILED` for payments, centralized in
  `payment.states.ts`; invalid transitions â†’ 409. A failed payment returns the
  order to `PENDING` and can never pair `FAILED` with `PAID`.
- **Idempotency** â€” `idempotencyKey` (required) replays the original result
  with HTTP 200 and **no second charge** (including concurrent duplicates,
  backed by `payments.idempotency_key UNIQUE`); `payments.order_id UNIQUE`
  means one payment row per order, so two successes are structurally
  impossible. Retries reuse the same row (`attemptCount++`).
- **Provider abstraction** â€” a `PaymentProvider` interface with a
  deterministic simulator behind it; swapping in a real PSP changes one file.
- **Notifications** â€” `PAYMENT_SUCCEEDED` / `PAYMENT_FAILED` rows are written
  in the *same transaction* as the payment/order state; the list endpoint is
  keyed strictly off the JWT identity.

Details: [`docs/PAYMENTS.md`](./docs/PAYMENTS.md) (three-phase flow, both
unique constraints, retry semantics, external-provider consistency, why no
Kafka/outbox yet) Â· [`docs/NOTIFICATIONS.md`](./docs/NOTIFICATIONS.md).

## 10. Current status

**Done (Day 1)**

- [x] Repo layout (frontend / backend / database / docs)
- [x] Backend: Express + TypeScript, strict tsconfig, env config
- [x] Prisma chosen as ORM, MySQL connector
- [x] Schema for all 9 business entities + status enums
- [x] Initial migration created, reviewed, applied
- [x] `GET /api/health` with real DB ping
- [x] Global error handling + JSON 404s
- [x] `README.md`, `docs/ARCHITECTURE.md`

**Done (Day 2)**

- [x] `POST /api/auth/register` â€” validation, email normalization, bcrypt(12),
      **User + Cart created in one transaction**, P2002â†’409 duplicate handling
- [x] `POST /api/auth/login` â€” single query, bcrypt compare, signed JWT
      (HS256, 15m, `iss`)
- [x] `GET /api/auth/me` protected by reusable `requireAuth` middleware
- [x] JWT config via env with fail-fast validation; `.env` git-ignored
- [x] Consistent errors: 400 validation, 401 auth, 409 conflict
- [x] `docs/AUTH.md` with flows, transactions, security decisions

**Done (Day 3)**

- [x] `GET /api/products` â€” public, offset pagination (page/limit, `limit` â‰¤ 100),
      `search` (name/description `contains`), `category`, `minPrice`/`maxPrice`,
      composable filters, `{ data, pagination }` envelope
- [x] `GET /api/products/:id` â€” public detail, clean 400/404
- [x] `POST /api/products` (ADMIN) â€” validation, SKU uniqueness â†’ 409
- [x] `PATCH /api/products/:id` (ADMIN) â€” partial updates, immutable id, 404/409
- [x] `DELETE /api/products/:id` (ADMIN) â€” reference guard â†’ clean 409 when
      the product appears in orders or carts (order history is never cascaded)
- [x] `requireRole('ADMIN')` middleware (401 vs 403, role from identity)
- [x] Migration: `idx_products_price` (range-filter index, decision documented)
- [x] `docs/PRODUCTS.md` â€” query design, pagination/search/index trade-offs,
      authorization, system-design evolution notes

**Done (Day 4)**

- [x] Cart module â€” `GET /api/cart`, add (upsert on `UNIQUE(cart_id, product_id)`),
      update, remove; ownership from the JWT identity; backend-authoritative
      validation (400/404/409 table in `docs/CART.md`)
- [x] Checkout â€” `POST /api/orders`: cart â†’ order inside **one transaction**
      (order + items + inventory decrement + cart clear, or full rollback)
- [x] Concurrency safety â€” `SELECT â€¦ FOR UPDATE` on the cart row, then
      inventory rows in `product_id` order; two checkouts racing for the last
      unit â†’ exactly one 201, one 409, stock never negative
- [x] Price snapshots â€” `OrderItem.unitPrice` frozen at checkout; totals =
      `Î£(unitPrice Ã— qty)` in `Decimal`, computed server-side
- [x] `GET /api/orders` (paginated summaries) and `GET /api/orders/:id`
      (detail; other users' orders 404, IDOR-safe)
- [x] Integration test suite (`npm test`, 29 tests: cart, checkout, atomicity
      via fault injection, concurrent-checkout race) with automatic cleanup
- [x] `docs/CART.md` + `docs/ORDERS.md` â€” ACID, the oversell race, snapshot
      pricing, idempotency analysis, evolution path
- [x] **No schema change, no new migration, no new indexes needed** â€” Day 1
      schema and existing indexes already covered every Day-4 query

**Not done yet â€” deliberately**

- âŒ Payment simulation, inventory reservations, notifications (Day 5)
- âŒ Admin order management, order cancellation, refunds
- âŒ Frontend scaffold
- âŒ Cursor pagination, MySQL FULLTEXT / search engine (documented evolution path)
- âŒ Idempotency keys (analysed in `docs/ORDERS.md` Â§9 â€” built with payments)
- âŒ Refresh tokens, OAuth, password reset, email verification, login rate limiting
- âŒ Redis, Kafka, background workers, Docker, Kubernetes, microservices

## 10. Planned future stages

| Stage | Scope |
| ----- | ----- |
| 4 | ~~Cart + orders + transactional order creation~~ **done (Day 4)** |
| 5 | Simulated payments, inventory reservations, order status transitions, notifications |
| 6 | Caching (Redis), background workers, rate limiting |
| 7 | Events (Kafka), observability, containerization (Docker), CI |

Exact scope may change as we learn; the rule stays: **only add what solves a
real problem we have actually hit**.
