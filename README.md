# E-commerce & Order Management Platform

A **learning-oriented, production-style** e-commerce platform. Designed to grow
from a small, well-structured application into a scalable event-driven system —
one deliberate stage at a time.

> **Status: Days 1–9 complete.** Backend foundation, MySQL schema, JWT auth,
> admin product catalog, the shopping cart, transactional checkout with
> concurrency-safe inventory, simulated payments with idempotency +
> notifications, **Kafka events through a transactional outbox**,
> **observability: correlated logs, route-pattern metrics, probes and graceful
> shutdown**, and **delivery: one multi-stage image that is both the API and the
> worker, a Compose stack that boots the entire system, and a CI pipeline that
> builds that image and runs it**. Admin order management, the inventory API and
> the frontend come next.

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
| Infra      | Kafka 3 (KRaft) + transactional outbox    | Async side effects off the request path                        |
| Delivery   | Docker (multi-stage, non-root, tini) · Compose · GitHub Actions | One image for both process roles; CI boots the stack it builds, so the Dockerfile cannot rot |
| Ops        | Structured logs, request ids, in-process metrics, liveness/readiness, graceful shutdown | Be observable and deployable without adding a metrics stack |
## 3. Current architecture (Days 1-8)

```
+--------------------------+          +--------------------------+
|  API process             |          |  Worker process          |
|  npm run dev             |          |  npm run worker          |
|                          |          |                          |
|  Express (TypeScript)    |          |  + outbox dispatcher     |
|   +-- apiRouter          |          |    PENDING -> PUBLISHED  |
|      +-- health / auth   |          |  + notification consumer |
|      +-- products        |          |    events -> notifications
|      +-- cart / orders   |          |    (+ dedup + DLQ)       |
|      +-- payments        |          |                          |
|   +-- error handling     |          |  same modules, same DB   |
+------------+-------------+          +-------------+------------+
             |                                       |
             |      +------------+      +------------v-----------+
             +----->|  MySQL 8   |<-----|  Kafka 3 (KRaft)       |
                    | 11 tables  |      |  order.events    (7d)  |
                    | outbox     |      |  payment.events  (7d)  |
                    | processed  |      |  *.dlq           (30d) |
                    +------------+      +------------------------+
             |
        +----v----+
        | Redis 8 |   Day 6: catalog cache + login rate limit
        +---------+
```

- **Modular monolith**: one deployable backend with clearly separated modules.
  No microservices yet (see `docs/ARCHITECTURE.md`).
- **Day 8 is cross-cutting, not a module**: every request gets an id that follows
  it into every log line (`AsyncLocalStorage`), one access-log line and one
  metric per route *pattern*; `/api/health/live` and `/api/health/ready` answer
  "restart me?" and "route to me?" separately; `GET /api/metrics` reports the
  counters; and both processes shut down through the same named-step sequence.
  Details and trade-offs in [`docs/RELIABILITY.md`](./docs/RELIABILITY.md).
- The API and the worker are two entrypoints into the SAME codebase. Kafka only
  carries asynchronous side effects and never sits on the request path; its
  status never changes the health endpoint's overall status (see `docs/KAFKA.md`).
- Schema in `backend/prisma/schema.prisma`, applied via reviewable SQL
  migrations in `backend/prisma/migrations/`.

## 4. Repository layout

```
ecommerce-platform/
├── backend/                  # Node.js + Express + TypeScript API
│   ├── prisma/
│   │   ├── schema.prisma     # source of truth for the database
│   │   └── migrations/       # applied, reviewable SQL migrations
│   └── src/
│       ├── config/           # env config + prisma client singleton
│       ├── errors/           # AppError used by handlers
│       ├── infrastructure/   # redis/ and kafka/ (outbox, producer, consumer)
│       ├── middleware/       # 404 + global error + requireAuth + requireRole
│       ├── modules/          # feature modules (health, auth, products, cart, orders)
│       ├── routes/           # apiRouter that mounts modules
│       ├── app.ts            # express app factory
│       └── server.ts         # HTTP entrypoint + graceful shutdown
│       └── worker.ts         # Day 7 entrypoint: dispatcher + consumer
│   ├── Dockerfile            # Day 9: one build, two targets (runtime, migrate)
│   ├── .dockerignore         # keeps node_modules + .env out of the build context
│   └── tests/
│       └── integration/      # npm test → real app + real MySQL (Days 4-7)
├── database/                 # database design docs + DDL reference
├── frontend/                 # (starts in a later stage)
├── infra/kafka/              # host-run KRaft broker (the no-Docker path)
├── docker-compose.yml        # Day 9: mysql + redis + kafka + migrate + api + worker
├── .env.example              # Compose variables (only JWT_SECRET is mandatory)
├── .github/workflows/ci.yml  # type-check → integration tests → build + boot stack
├── docs/
│   ├── ARCHITECTURE.md       # architecture rationale & evolution path
│   ├── AUTH.md               # authentication flows & security decisions
│   ├── PRODUCTS.md           # product catalog, pagination/search/index trade-offs
│   ├── CART.md               # cart-as-intent, uniqueness, upsert semantics
│   ├── ORDERS.md             # transactional checkout, locking, price snapshots
│   ├── PAYMENTS.md           # simulated payment processing, idempotency & state machine
│   ├── NOTIFICATIONS.md      # notifications & user scoping
│   ├── REDIS.md              # Redis catalog cache, rate limiting & fail-open resilience
│   ├── KAFKA.md              # outbox, at-least-once delivery, consumer idempotency
│   ├── RELIABILITY.md        # structured logs, request ids, metrics, probes, shutdown
│   └── DEPLOYMENT.md         # Day 9: containers, the local stack, what CI proves
├── .gitignore
└── README.md
```

## 5. Running locally

Two ways, chosen by whether you want Docker to own the dependencies:

| Path | What you get | Needs |
| ---- | ------------ | ----- |
| **5a. Containers** | MySQL, Redis, Kafka, migrations, API and worker from one `up` command | Docker |
| **5b. Host** | The Days 1–8 path: `npm run dev` against a local MySQL, Redis/Kafka optional | Node + MySQL |

### 5a. The whole stack in containers (Day 9)

```bash
copy .env.example .env            # only JWT_SECRET is mandatory
docker compose up -d --build
curl http://localhost:4000/api/health/ready
curl http://localhost:4000/api/metrics
docker compose logs -f worker     # "ready" once it joins its consumer group
docker compose stop api           # watch the Day 8 shutdown steps run, exit 0
docker compose down               # add -v to drop the MySQL/Kafka volumes
```

| Service | Host address | Notes |
| ------- | ------------ | ----- |
| api | `http://localhost:4000` | `/api/health/live`, `/api/health/ready`, `/api/metrics` |
| worker | — | the **same image** as the api; its `command:` points at `dist/worker.js` |
| mysql | `127.0.0.1:3308` | 3308, so it coexists with a local mysqld on 3306/3307 |
| redis | `127.0.0.1:6380` | for poking at the cache; containers use `redis:6379` |
| kafka | `127.0.0.1:29092` | host listener; containers use `kafka:9092` |

Inside the network, connection strings use **service names** (`mysql`, `redis`,
`kafka`) — `localhost` there is the container itself, which is why this stack's
`DATABASE_URL` is a different string from `backend/.env`'s on purpose. The
one-shot `migrate` service applies the committed SQL before either app container
starts, and `stop_grace_period` is deliberately larger than `SHUTDOWN_TIMEOUT_MS`
so `SIGTERM` is not a race the platform wins.

> **Honesty note:** this project is developed on a machine with **no Docker
> installed**. The image and the stack are therefore built and booted by CI
> (`.github/workflows/ci.yml`, `docker` job) — which is also what stops them
> rotting. `docs/DEPLOYMENT.md` §9 states exactly what was verified where.

### 5b. On the host (the path used in Days 1–8)

Everything below is unchanged: `npm run dev` against a local MySQL, with Redis
and Kafka optional (fail-open cache, outbox-queued events) and the host-run
broker script in `infra/kafka/`.

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

### 5. Start Kafka and the worker (Day 7)

Notifications are produced asynchronously: the payment commits an event to the
MySQL **transactional outbox**, the worker publishes it to Kafka, and the
notification consumer writes the notification. The API alone still serves every
request - with no broker (or `KAFKA_ENABLED=false`) events simply wait in
`outbox_events` until Kafka is available.

```bash
npm run kafka:start     # format once, then launch the local KRaft broker
npm run kafka:status    # broker up? port listening?
npm run worker          # outbox dispatcher + notification consumer
```

Startup order: **MySQL -> Kafka broker -> API -> worker**.

### 6. Verify

```bash
curl http://localhost:4000/api/health
# → {"status":"ok","service":"ecommerce-platform-backend","database":"up",...}
```

Probes and counters (Day 8):

```bash
curl -i http://localhost:4000/api/health/live   # "alive" - restart me?  (never checks a dependency)
curl http://localhost:4000/api/health/ready     # "ready" - route to me?  (503 only if MySQL is down)
curl http://localhost:4000/api/metrics          # counters: http / cache / rate limit / events
```

Every response also carries `X-Request-ID`. Quote that id and every log line
written about the request can be found — see `docs/RELIABILITY.md`.

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
| `npm run worker`      | outbox dispatcher + notification consumer   |
| `npm run kafka:start` | start the local KRaft Kafka broker          |
| `npm run kafka:stop`  | stop the Kafka broker                       |
| `npm run kafka:status`| broker health + port check                  |
| `npm run kafka:topics`| list topics                                 |

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
- Offsetting pagination with safe caps (`limit` ≤ 100); offset-vs-cursor
  trade-offs documented in [`docs/PRODUCTS.md`](./docs/PRODUCTS.md).
- Authorization via reusable `requireRole('ADMIN')` middleware
  (401 unauthenticated / 403 wrong role; role always read from the
  authenticated identity, never the request).

## 8. Cart & Checkout API (Day 4)

| Method | Path                         | Auth | Purpose                                                       |
| ------ | ---------------------------- | ---- | ------------------------------------------------------------- |
| GET    | `/api/cart`                  | JWT  | Own cart (empty cart is a valid response)                     |
| POST   | `/api/cart/items`            | JWT  | Add product / increase existing line (upsert)                 |
| PATCH  | `/api/cart/items/:productId` | JWT  | Set absolute quantity (0 is rejected — use DELETE)            |
| DELETE | `/api/cart/items/:productId` | JWT  | Remove one line                                               |
| POST   | `/api/orders`                | JWT  | **Checkout**: cart → order inside one transaction             |
| GET    | `/api/orders`                | JWT  | Own order history (`{ data, pagination }`)                    |
| GET    | `/api/orders/:id`            | JWT  | Own order detail with snapshot prices (404 if not yours)      |

Checkout guarantees (all verified by integration tests):

- **Atomic** — order + order items + inventory decrement + cart clear happen in
  one MySQL transaction; any failure rolls back *everything* (verified with a
  fault-injected mid-transaction failure: no partial order, stock untouched,
  cart intact).
- **Concurrency-safe** — `SELECT … FOR UPDATE` row locks (cart row first, then
  inventory rows in `product_id` order) make two customers racing for the last
  unit produce exactly one `201` and one `409` — stock can never go negative.
- **Price snapshots** — `OrderItem.unitPrice` freezes the purchase price; later
  `Product.price` changes never rewrite history; totals are
  `Σ(unitPrice × qty)`, computed server-side with `Decimal` (never trusted from
  the client).
- **Ownership everywhere** — cart and order lookups are keyed by the JWT
  identity; another user's order/cart is indistinguishable from nonexistent
  (404). No `userId` is ever accepted from a request body.

Flow & trade-off documentation: [`docs/CART.md`](./docs/CART.md),
[`docs/ORDERS.md`](./ORDERS.md) (transactions, the oversell race, idempotency
analysis, evolution path).

Integration tests: `cd backend && npm test` (29 tests against the real app +
real MySQL; auto-cleanup, no seed data left behind).

## 9. Payments & Notifications API (Days 5 & 7)

| Method | Path                            | Auth | Purpose                                                |
| ------ | ------------------------------- | ---- | ------------------------------------------------------ |
| POST   | `/api/orders/:orderId/payments` | JWT  | Charge **your** order (server-side amount, idempotent) |
| GET    | `/api/orders/:orderId/payments` | JWT  | Read the payment for **your** order                     |
| GET    | `/api/notifications`            | JWT  | Your notifications, newest first (`page`/`limit`)       |

Payment guarantees (all verified by integration + live tests):

- **Server-side amount** — the request body has no `amount` field; the value
  charged and stored always equals `Order.totalAmount` (client-supplied
  numbers are ignored).
- **State machines** — `PENDING → PAYMENT_PROCESSING → PAID` for orders;
  `PROCESSING → SUCCEEDED | FAILED` for payments, centralized in
  `payment.states.ts`; invalid transitions → 409. A failed payment returns the
  order to `PENDING` and can never pair `FAILED` with `PAID`.
- **Idempotency** — `idempotencyKey` (required) replays the original result
  with HTTP 200 and **no second charge** (including concurrent duplicates,
  backed by `payments.idempotency_key UNIQUE`); `payments.order_id UNIQUE`
  means one payment row per order, so two successes are structurally
  impossible. Retries reuse the same row (`attemptCount++`).
- **Provider abstraction** — a `PaymentProvider` interface with a
  deterministic simulator behind it; swapping in a real PSP changes one file.
- **Notifications** ... `PAYMENT_SUCCEEDED` / `PAYMENT_FAILED` are **not** written
  by the payment transaction any more. The payment commits an outbox event
  instead and the notification appears once the worker has consumed it, so it is
  eventually consistent by a few milliseconds - in exchange a slow notification
  path can no longer slow down or fail a payment. The list endpoint is still
  keyed strictly off the JWT identity.

Details: [`docs/PAYMENTS.md`](./docs/PAYMENTS.md) (three-phase flow, both
unique constraints, retry semantics, external-provider consistency) ..
[`docs/NOTIFICATIONS.md`](./docs/NOTIFICATIONS.md) ..
[`docs/KAFKA.md`](./docs/KAFKA.md) (transactional outbox, at-least-once
delivery, consumer idempotency, dead-letter queues).

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

- [x] `POST /api/auth/register` — validation, email normalization, bcrypt(12),
      **User + Cart created in one transaction**, P2002→409 duplicate handling
- [x] `POST /api/auth/login` — single query, bcrypt compare, signed JWT
      (HS256, 15m, `iss`)
- [x] `GET /api/auth/me` protected by reusable `requireAuth` middleware
- [x] JWT config via env with fail-fast validation; `.env` git-ignored
- [x] Consistent errors: 400 validation, 401 auth, 409 conflict
- [x] `docs/AUTH.md` with flows, transactions, security decisions

**Done (Day 3)**

- [x] `GET /api/products` — public, offset pagination (page/limit, `limit` ≤ 100),
      `search` (name/description `contains`), `category`, `minPrice`/`maxPrice`,
      composable filters, `{ data, pagination }` envelope
- [x] `GET /api/products/:id` — public detail, clean 400/404
- [x] `POST /api/products` (ADMIN) — validation, SKU uniqueness → 409
- [x] `PATCH /api/products/:id` (ADMIN) — partial updates, immutable id, 404/409
- [x] `DELETE /api/products/:id` (ADMIN) — reference guard → clean 409 when
      the product appears in orders or carts (order history is never cascaded)
- [x] `requireRole('ADMIN')` middleware (401 vs 403, role from identity)
- [x] Migration: `idx_products_price` (range-filter index, decision documented)
- [x] `docs/PRODUCTS.md` — query design, pagination/search/index trade-offs,
      authorization, system-design evolution notes

**Done (Day 4)**

- [x] Cart module — `GET /api/cart`, add (upsert on `UNIQUE(cart_id, product_id)`),
      update, remove; ownership from the JWT identity; backend-authoritative
      validation (400/404/409 table in `docs/CART.md`)
- [x] Checkout — `POST /api/orders`: cart → order inside **one transaction**
      (order + items + inventory decrement + cart clear, or full rollback)
- [x] Concurrency safety — `SELECT … FOR UPDATE` on the cart row, then
      inventory rows in `product_id` order; two checkouts racing for the last
      unit → exactly one 201, one 409, stock never negative
- [x] Price snapshots — `OrderItem.unitPrice` frozen at checkout; totals =
      `Σ(unitPrice × qty)` in `Decimal`, computed server-side
- [x] `GET /api/orders` (paginated summaries) and `GET /api/orders/:id`
      (detail; other users' orders 404, IDOR-safe)
- [x] Integration test suite (`npm test`, 29 tests: cart, checkout, atomicity
      via fault injection, concurrent-checkout race) with automatic cleanup
- [x] `docs/CART.md` + `docs/ORDERS.md` — ACID, the oversell race, snapshot
      pricing, idempotency analysis, evolution path
- [x] **No schema change, no new migration, no new indexes needed** — Day 1
      schema and existing indexes already covered every Day-4 query

**Done (Day 5)**

- [x] Three-phase payment flow (PENDING ... PROCESSING ... SUCCEEDED/FAILED),
      server-side amount (the body has no `amount` field), `idempotencyKey`
      replay with no second charge, one payment row per order
- [x] `PaymentProvider` interface behind a deterministic simulator
- [x] Notifications (`PAYMENT_SUCCEEDED` / `PAYMENT_FAILED`) with ownership
      taken from the JWT identity, not from a query string
- [x] `docs/PAYMENTS.md` + `docs/NOTIFICATIONS.md`

**Done (Day 6)**

- [x] Redis catalog cache ... cache-aside, version-bump invalidation, TTL fallback
- [x] Fixed-window login rate limiter (atomic Lua, keyed on IP + account)
- [x] Fail-open degradation ... a Redis outage degrades performance, never requests
- [x] `GET /api/health` reports Redis without letting it decide the status
- [x] `docs/REDIS.md`

**Done (Day 7)**

- [x] Transactional outbox ... `outbox_events` committed in the SAME transaction
      as the payment; publish-first / mark-second dispatcher; `DEAD` after the
      retry budget; no claim or lock taken before publishing
- [x] Kafka 3 (KRaft, local, no Docker) with declared topics + `ensureTopics()`;
      `infra/kafka/kafka.ps1` + `npm run kafka:*`
- [x] Event envelope + `OrderPaid` / `PaymentFailed`; partition key `order-<id>`
      so one order's payment events can never be reordered
- [x] At-least-once consumer ... manual commits, `processed_events` dedup written
      in the same transaction as the notification, permanent failures (and only
      those) go straight to the DLQ
- [x] Second entrypoint `src/worker.ts` (`npm run worker`): outbox dispatcher +
      notification consumer, running the same modules as the API
- [x] `GET /api/health` ... `kafka.pendingEvents` / `kafka.deadEvents`, with
      Kafka never deciding the overall status
- [x] `docs/KAFKA.md`

**Done (Day 8)**

- [x] Structured JSON logger (`src/infrastructure/logging/`) — level filtering,
      key-based redaction at any depth, error serialization, `setLogSink()` as a
      test seam; **no** pino/winston dependency, and zero `console.*` left
- [x] Request ids: `X-Request-ID` echoed (caller-supplied ids reused only if they
      match `[A-Za-z0-9._-]{8,64}`), propagated to every log line through
      `AsyncLocalStorage` — no function signature changed
- [x] One access-log line per request (`info`/`warn`/`error` by outcome) + a
      global error policy that stops logging 4xx as failures
- [x] In-process HTTP metrics keyed by **route pattern**, not URL; digit/UUID
      segments collapsed and a 200-label cap so cardinality cannot explode
- [x] `GET /api/metrics` — http + cache + `security.rateLimit.degraded` +
      producer/outbox/consumer counters, bearer-token gated via `METRICS_TOKEN`
- [x] `GET /api/health/live` (checks nothing, so no dependency can restart the
      fleet) and `GET /api/health/ready` (only MySQL gates traffic)
- [x] Graceful shutdown as an ordered, named, individually-timed step list with an
      idempotent signal handler, a drain window for in-flight requests, an
      idle-socket sweep, and a watchdog that names the step that hung
- [x] **Defect fixed**: the outbox retry budget was being consumed by the 2s poll
      interval, so ~20s of broker downtime dead-lettered every queued event;
      retries now back off 1s → 60s via `outbox_events.next_attempt_at` (new
      column + migration)
- [x] **Defect fixed**: the rate limiter's fail-open was invisible — it is now a
      counted, timestamped security signal (`degraded`)
- [x] Failure-injection tests: Redis down under traffic, a throwing shutdown step,
      a wedged step, duplicate SIGTERMs, a request in flight while closing, a
      keep-alive socket, a request overrunning the drain, a broker refusing
      publishes (`npm test`: 108 tests, 8 files)
- [x] `docs/RELIABILITY.md` + the Day-8 variables in `.env.example`

**Done (Day 9)**

- [x] One multi-stage `Dockerfile` with two targets: `runtime` (runs as the
      non-root `node` user, `tini` as PID 1 so Day 8's `SIGTERM` sequence actually
      runs) and `migrate` (prisma CLI + migrations, nothing else). The API and the
      worker are the **same bytes** — the role is a Compose `command:` override
- [x] `prisma generate` runs inside the image, because the query engine is a
      native per-platform binary; `.dockerignore` keeps `node_modules` and `.env`
      out of the build context (one breaks the Linux build, the other leaks a
      secret into layer cache)
- [x] Build-time assertions: the generated client and its engine binary exist, and
      both entrypoints parse — a broken image fails a build, not a deploy
- [x] A production-only install that was checked rather than assumed: npm installs
      `@prisma/client`'s optional peer `prisma` even under `--omit=dev`, and
      `--omit=peer` does not remove it (both verified against this lockfile), so
      the ~50 MB CLI is deleted in the layer that created it — and CI booting the
      image is what makes that a checked claim
- [x] `docker-compose.yml`: MySQL 8.4, Redis 7, single-node KRaft Kafka, a
      one-shot `migrate` service, `api`, `worker`. Every `depends_on` edge is a
      healthcheck or an exit code, never "the container was created"; Kafka
      publishes only its host listener, because advertised addresses must be
      reachable from the *client's* network
- [x] `stop_grace_period: 15s` > `SHUTDOWN_TIMEOUT_MS: 10000` as one decision, and
      host ports 3308/6380/29092 so the stack coexists with this machine's own
      MySQL/Redis/Kafka instead of fighting them
- [x] GitHub Actions: `static` (no ESLint config exists in this repo, so
      `tsc --noEmit` *is* the lint step and is named as such) → `integration-tests`
      against MySQL/Redis/Kafka service containers, with broker readiness proven
      first so a missing Kafka cannot masquerade as a passing suite → `docker`
      (build both targets, `compose up --wait`, probe live/ready/metrics,
      register + login + catalog smoke test, assert the worker joined its group and
      that `docker compose stop` exits **0**, not 137)
- [x] `docs/DEPLOYMENT.md` — decisions with their costs, what was verified where,
      troubleshooting, and next steps

**Not done yet — deliberately**

- ❌ Admin order management, order cancellation, refunds
- ❌ Frontend scaffold
- ❌ Cursor pagination, MySQL FULLTEXT / search engine (documented evolution path)
- ❌ Idempotency keys for **checkout** (analysed in `docs/ORDERS.md` §9 — payments
      have them; checkout does not yet)
- ... Refresh tokens, OAuth, password reset, email verification
- ... Kubernetes manifests, autoscaling, microservices (containerization and CI
      are done — see `docs/DEPLOYMENT.md`)

## 11. Planned future stages

| Stage | Scope |
| ----- | ----- |
| 4 | ~~Cart + orders + transactional order creation~~ **done (Day 4)** |
| 5 | ~~Simulated payments, inventory reservations, order status transitions, notifications~~ **done (Day 5)** |
| 6 | ~~Caching (Redis), background workers, rate limiting~~ **done (Day 6)** |
| 7 | ~~Events (Kafka)~~ **done (Day 7)** |
| 8 | ~~Observability: logs, request ids, metrics, probes, graceful shutdown~~ **done (Day 8)** |
| 9 | ~~Containerization (multi-stage image + Compose stack) and CI (type-check, integration tests on real services, image build + stack boot)~~ **done (Day 9)** |
| 10 | Frontend (React + TypeScript) against this API, plus admin order management |

Exact scope may change as we learn; the rule stays: **only add what solves a
real problem we have actually hit**.
