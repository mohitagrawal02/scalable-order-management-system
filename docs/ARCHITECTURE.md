# Architecture

> Status: **Day 1 — Foundation**. Written upfront so every later change has a
> documented baseline to deviate from.

## 1. Why we start with a modular monolith

**The default should be the simplest architecture that successfully ships.**
A modular monolith gives us:

- **One codebase, one deployable**: fastest possible iteration while features
  are still being defined. There is no cross-service complexity yet, so there
  is no reason to pay microservices' operational cost.
- **Clear module boundaries anyway**: the backend is organised as feature
  modules (`modules/auth`, `modules/products`, ...) with their own routers and
  controllers. Those boundaries are exactly the seams we would cut if a module
  ever graduates into its own service.
- **Transactions across features**: order creation will need cart + inventory
  + payment data to change atomically. That is trivial inside one process and
  painful across services; doing it with monolith-local transactions first
  teaches the *invariants* before the *distributed* complexity.
- **Interview honesty**: being able to say *"we deliberately started as a
  modular monolith and here is the exact pain that would push a module out"*
  is far stronger than a hand-waved microservices diagram.

**When this changes:** when a module has an independent scaling profile, a
different latency/availability requirement, or a separate team/ownership —
and only then.

## 2. Why MySQL

- **Relational by nature**: users, orders, order-items, payments and inventory
  have hard foreign-key relationships and need multi-row transactions. A
  relational database models this directly.
- **Constraints you get for free**: foreign keys, unique constraints,
  `ENUM` states, and `DECIMAL(10,2)` money prevent a whole class of bugs at
  the database layer instead of in application code.
- **Order correctness**: order totals must live in transactions; MySQL's
  ACID guarantees (row-level locking, repeatable reads) make this reliable.
- **Ubiquity & hiring relevance**: MySQL (and PostgreSQL) are the databases
  most backend roles actually use.

**When this changes:** read-heavy hot paths (e.g. product catalog) may later be
fronted by Redis or an elastic search index; MySQL remains the system of
record.

## 3. Major modules

Currently living in `backend/src/modules/`:

| Module     | Owner of                             | Status      |
| ---------- | ------------------------------------ | ----------- |
| `health`   | liveness / DB connectivity reporting | Day 1       |
| `auth`     | registration, login, JWT verification | Day 2      |
| `products` | catalog CRUD, public discovery, filtering | Day 3  |
| `cart`     | cart lifecycle                       | Day 4       |
| `orders`   | checkout, status transitions         | Day 4       |
| `payments` | payment flow, idempotency, state machines | Day 5   |
| `notifications` | user-facing event notifications | Day 5       |
| `inventory`| stock, reservations                  | future      |

Shared infrastructure in `src/` (config, errors, middleware, routes) grows
only when two or more modules need it. Day 2 added `middleware/requireAuth.ts`
and Day 3 added `middleware/requireRole.ts` — the authn/authz pair reused by
every future protected route (products admin, cart, orders).

## 4. Database design principles

Source of truth: `backend/prisma/schema.prisma`. Applied as SQL migrations in
`backend/prisma/migrations/` (see `database/README.md`).

- **Surrogate integer primary keys** — compact, index-friendly, stable.
  Public UUIDs can be added later for external exposure / sharding.
- **Money as `DECIMAL(10,2)`** — exact; never `FLOAT`/`DOUBLE`.
- **Enums for fixed states** — order/payment status, roles, notification types.
  Adding a value is a migration; the database cannot drift silently.
- **Timestamps on every aggregate**; `updated_at` only where rows actually
  change.
- **Indexes are earned, not assumed.** Every index maps to a query pattern
  that already exists (unique email/SKU identifiers; `orders.user_id`,
  `orders.status`, `products.category`, `notifications(user_id, created_at)`,
  and the `cart_items(cart_id, product_id)` uniqueness rule). Foreign-key
  indexes are created automatically by MySQL.
- **Delete behaviour is explicit** via `onDelete`: cascade for owner-owned
  children, `Restrict` for historical/financial references, `SetNull` where a
  reference is optional.

## 5. Technologies we are intentionally NOT using yet

| Tech            | Why not yet                                              | Likely trigger                          |
| --------------- | -------------------------------------------------------- | --------------------------------------- |
| Redis           | No caching or rate-limiting need exists; state is in MySQL | Read-heavy product pages; hot sessions |
| Kafka           | No cross-service events; a single process can handle everything transactionally | Notifications/analytics fan-out; second service |
| Background workers | Nothing is slow or out-of-band yet                    | Payment confirmations, invoice emails  |
| Docker / K8s    | Local dev is simpler without it; adds mental load now     | Reproducible env for others / CI + deployment |
| Microservices   | No independent scaling or ownership boundary yet          | A module with an independent profile   |
| Frontend        | No API surface worth consuming yet                        | After auth/products APIs exist          |

This list is the point of the exercise: **technologies arrive when a concrete
problem requires them**, not to make the diagram impressive.

## 5.5 Authentication notes (Day 2)

Authentication deliberately stayed simple and self-contained:

- **Stateless JWT (HS256)** — no session storage; any instance can verify any
  token as long as `JWT_SECRET` matches. 15-minute default lifetime.
- **bcrypt (bcryptjs, cost 12)** — one-way hashing with a random salt per
  password. Never encryption, never plaintext.
- **One transaction on registration** — `User` + `Cart` are created inside a
  single MySQL transaction so the "every user has exactly one cart"
  invariant cannot break, even under failure or concurrent load.
- **Layers** — route → controller → service → Prisma → MySQL, with
  validation and the reusable `requireAuth` middleware as separate seams.

Full reasoning, flows, and trade-offs: [`AUTH.md`](./AUTH.md). Next-stage
candidates that follow the same discipline: product catalog (products module),
and orders buying from the same transactional playbook.

## 5.6 Product catalog notes (Day 3)

- **Read-heavy, write-rare**: the catalog is the first module where read
  performance dominates. Filters compile into one dynamic `WHERE`; offset
  pagination and substring search are deliberately simple with their scale
  limits documented (`PRODUCTS.md` §4–5) instead of pre-optimised.
- **Authorization split**: `requireAuth` (401) vs `requireRole` (403) as two
  composable middlewares; role always re-read from the database row, so role
  changes take effect without waiting for token expiry.
- **History is immutable**: products referenced by `order_items`/`cart_items`
  cannot be deleted (schema `RESTRICT` + app-level 409 guard). Deactivation
  (`isActive: false`) is the catalog removal path.
- **One new index** (`idx_products_price`) with a written decision record;
  `%substring%` search documented as unindexable by B-trees rather than
  pretending an index solves it.

Full reasoning, query design, and trade-offs: [`PRODUCTS.md`](./PRODUCTS.md).

## 5.7 Checkout & transactions notes (Day 4)

Checkout is where the monolith earns its keep — one MySQL transaction can span
carts, products, orders, and inventory because they share a process and a
database:

- **Cart is intent, checkout is authority** — the cart never reserves stock;
  every guarantee is re-established inside the checkout transaction, under row
  locks. Splitting the "truth" this way is what makes long-lived carts safe.
- **Row locks, not optimistic hopes** — `SELECT … FOR UPDATE` (cart row first,
  then inventory rows in `product_id` order) turns the check-then-write race
  into a serialized queue: two buyers of the last unit get one 201 and one 409.
  The two locking reads are the only raw SQL in the service, isolated and
  parameter-bound; everything else stays in the Prisma builder.
- **Deadlock prevention by construction** — single lock-taking statement with a
  fixed `ORDER BY`, plus per-user cart locks that never contend across users.
- **Price snapshots** — `OrderItem.unitPrice` freezes money at purchase time;
  totals are derived from snapshots, so repricing can never rewrite history.
- **What stayed out of the transaction** — emails, analytics, anything remote.
  When those arrive, the order of operations becomes *commit → publish event*
  (outbox pattern), not "hold a transaction open across a network call".
- **Idempotency deferred with a written analysis** (`ORDERS.md` §9): double-click
  is already serialized by the cart lock; retry-after-commit needs idempotency
  keys, which become mandatory with payments (double-charge risk).

Full flows, the ACID walkthrough, and the evolution path: [`CART.md`](./CART.md),
[`ORDERS.md`](./ORDERS.md).


## 5.8 Redis Caching & Rate Limiting (Day 6)

In Day 6, Redis is added to accelerate read-heavy catalog traffic and protect authentication from brute-force attempts:

- **Product Catalog Cache-Aside**:
  - `product:<id>` cached on read with 60-second TTL; deleted on update/delete.
  - `catalog:list:version` counter bumped on every catalog mutation; list query keys incorporate the version (`product:list:v<version>:<hash>`), invalidating all pagination/filter variations in O(1) time without blocking Redis with `KEYS` or scans.
- **Login Rate Limiter**:
  - 5 attempts per 60-second window scoped to SHA-256 hashed `(ip, account)` tuple.
  - Evaluated via an atomic Redis Lua script (`INCR` + `EXPIRE` on first touch + `TTL`) to guarantee zero race conditions and prevent infinite key retention.
- **Fail-Open Policy**:
  - If Redis is down, unreachable, or times out (>500ms), errors are logged and the system fails open: catalog reads fall back to MySQL and login attempts proceed.
  - Client configured with `enableOfflineQueue: false` and `commandTimeout: 500ms` so failures resolve in microseconds rather than blocking Node event loops.
- **Health Check Integration**: `/api/health` reports Redis connectivity and degradation state without degrading overall service status.

Full details: [`REDIS.md`](./REDIS.md).

## 5.9 Reliability & observability notes (Day 8)

Days 1-7 answered "does it work?". Day 8 answers "could anyone tell?" — and it is
architecture rather than polish, because three of its decisions change what the
system *does* under failure:

- **Liveness must not check dependencies.** `/api/health/live` reads nothing, so a
  database failover cannot fail every probe at once and make the orchestrator
  restart a fleet that was only waiting. Traffic routing is `/api/health/ready`,
  where MySQL is required and Redis and Kafka are explicitly not.
- **Correlation is a cross-cutting concern.** A request id is bound once, in the
  first middleware, and reaches the cache, the outbox and the error handler
  through `AsyncLocalStorage` — no signature changed. The worker binds the
  equivalent per message, and the event `correlationId` is the seam between the
  two processes.
- **Metrics must bound their own cardinality.** Labels are route *patterns*, with
  digit/UUID segments collapsed and a hard label cap, because a metrics map that
  keys on user input is a memory leak with a dashboard attached.
- **Shutdown is a sequence, not a callback.** Named steps run in the order that
  makes each later close safe; one step failing is recorded and does not skip the
  rest; a drain window plus an idle-socket sweep plus a watchdog mean a deploy
  neither drops a client mid-request nor hangs until the platform kills us.
- **Nothing here adds infrastructure.** No metrics server, no sidecar, no log
  shipper — an in-process registry, JSON on stdout, and endpoints a process
  supervisor can already reach. Prometheus is an evolution step
  ([§6](#6-how-the-architecture-is-expected-to-evolve)), not a prerequisite.

Full details, including the defects found while inspecting Day 7 (notably the
outbox retry budget being consumed by the poll interval):
[`RELIABILITY.md`](./RELIABILITY.md).

## 6. How the architecture is expected to evolve

1. **Day 2–4 (done) — features:** auth, products, cart, transactional
   checkout — all inside the monolith, using MySQL transactions. Next:
   payments, inventory reservation, notifications.
2. **Read optimisation:** Redis caching in front of hot reads; rate limiting
   becomes necessary the moment real clients hit the API.
3. **Out-of-band work:** background workers for notifications/emails; an
   outbox-style pattern once events need to leave the process safely.
4. **Event-driven:** Kafka arrives when multiple consumers need the same fact
   (e.g. every order event consumed by notification + analytics + search
   sync) — the classic reason to introduce a broker, not before.
5. **Scale-out:** stateless HTTP tier horizontally; extract a module only when
   one has a distinct lifecycle (classic candidate: payments worker).

We do not know we will need all of these. The architecture is a *path*, and
each stage re-evaluates it.

## 7. Local MySQL on Windows (without admin)

The MySQL **Windows service** (`MYSQL80`) often requires an elevated shell to
start. Non-admin-friendly alternative used for this project's dev verification:

```powershell
# 1. Initialise a throwaway data dir (one time)
& 'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqld.exe' --initialize-insecure `
    --datadir="$env:USERPROFILE\mysql-local-data"

# 2. Start mysqld standalone on a custom port
Start-Process -FilePath 'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqld.exe' `
    -ArgumentList "--datadir=$env:USERPROFILE\mysql-local-data", '--port=3307' `
    -RedirectStandardError "$env:USERPROFILE\mysql-local-data\stderr.log" `
    -WindowStyle Hidden

# 3. Connect as root (no password) and create app db + user
mysql -u root -h 127.0.0.1 -P 3307
```

Any separately hosted MySQL works the same way — just change `DATABASE_URL`.