# Product Catalog — design & flows (Day 3)

> Status: Day 3 complete. Admin product management + public product discovery.

## 1. Endpoints

| Method | Path                 | Auth              | Purpose                                    |
| ------ | -------------------- | ----------------- | ------------------------------------------ |
| GET    | `/api/products`      | public            | List products (pagination + filters)       |
| GET    | `/api/products/:id`  | public            | Product detail (404 if missing/inactive)   |
| POST   | `/api/products`      | ADMIN             | Create a product                           |
| PATCH  | `/api/products/:id`  | ADMIN             | Update product fields                      |
| DELETE | `/api/products/:id`  | ADMIN             | Delete (blocked by references → 409)       |

## 2. Module architecture

```
Client
 ↓
Express (app.ts)
 ↓
Product Router (product.router.ts)      requireAuth + requireRole('ADMIN') for admin routes
 ↓
Validation (product.validation.ts)      body / query parsing & rules → 400 on failure
 ↓
Controller (product.controller.ts)      HTTP layer: parse params, call service, shape response
 ↓
Product Service (product.service.ts)    business rules, dynamic filters, delete guard
 ↓
Prisma Client (typed queries)
 ↓
MySQL
```

The layers match the auth module exactly. Controllers never talk to Prisma;
services never touch `req`/`res`. Authorization lives in the router so it is
impossible to "forget" it on a new admin handler.

## 3. Query design

**Filtering** — the service builds the Prisma `where` clause dynamically from
exactly the parameters supplied:

| Parameter  | Prisma filter                                   | Notes                          |
| ---------- | ----------------------------------------------- | ------------------------------ |
| `category` | `category: value` (equality)                    | exact match, uses index        |
| `minPrice` | `price: { gte: value }`                         | range scan on the price index  |
| `maxPrice` | `price: { lte: value }`                         | combined into one range        |
| `search`   | `OR: [{name contains}, {description contains}]` | see §5 for the trade-off       |

Filters compose with AND automatically because each supplied parameter adds
one field to the same `where` object. Unsupplied parameters add nothing — the
query stays as cheap as the caller asked it to be.

The public list always adds `isActive: true` — inactive products (soft-removed
from the catalog) are invisible to discovery but keep their historical
references intact.

**Ordering** — `ORDER BY id DESC` ("newest first"). Deterministic ordering is
required for pagination to be stable: without a total order, MySQL may return
rows in different orders across page requests (duplicating or skipping rows).
`id` is unique and free to sort (clustered PK); adding `createdAt` to the
ORDER BY would need an index to stay cheap at scale.

**Pagination** — offset-based (`skip`/`take`). `page` defaults to 1, `limit`
defaults to 20 and is capped at 100. `page=-100` / `limit=1000000` are
rejected with 400 before reaching Prisma. Response shape:

```json
{ "data": [ ... ], "pagination": { "page": 1, "limit": 20, "total": 8, "totalPages": 1 } }
```

## 4. Pagination trade-off (offset now, cursor later)

Offset pagination (`LIMIT 20 OFFSET 40`) is what we shipped because it is
simple, stateless, and gives clients free "jump to page N" plus exact totals
(`total`, `totalPages`) — everything a small catalog UI needs.

**The cost appears with large offsets.** `page=50000&limit=20` makes MySQL
walk 1,000,000 index/row positions to *throw away* the first 999,980. Two
consequences:

- Deep pages get linearly slower (O(offset)) even though only 20 rows return.
- Between two page requests, an insert/delete shifts offsets: rows can be
  duplicated or skipped ("drift"). Deterministic ORDER BY limits but does not
  remove this.

**Cursor/keyset pagination** fixes both: the client passes an opaque cursor
(e.g. the last seen `id`) and the query becomes
`WHERE id < cursor ORDER BY id DESC LIMIT 20` — a single index seek, constant
cost per page, no drift. The trade-off: no page numbers, no total count
(counting is separate), and clients must track a cursor. That is the
standard evolution for large catalogs and the likely Day-N change if product
volume or deep paging becomes real. We did **not** build it now — there is no
evidence yet that offset is slow at realistic catalog sizes, and the
pagination contract is centralized in `product.validation.ts` +
`product.service.ts`, so migrating later touches two small files.

## 5. Search trade-off (relational `contains` now, engines later)

Current search is `WHERE name LIKE '%term%' OR description LIKE '%term%'`
(Prisma `contains`). Case-insensitivity comes for free from the table's
`utf8mb4_unicode_ci` collation — no `mode: 'insensitive'` needed (that option
is PostgreSQL-only anyway).

**Why this is enough today:** small-to-medium catalogs, exact substring
matching, no relevance ranking, no typos-tolerance, no facets. Adding
Elasticsearch/OpenSearch now would mean a second datastore, an indexing
pipeline, sync semantics — complexity with no current problem to justify it.

**Why a B-tree index does NOT help this query:** a B-tree can serve
`LIKE 'term%'` (prefix) but **cannot** serve a leading-wildcard `LIKE
'%term%'` — the tree is sorted by the left edge of the string, so the
substring can be anywhere. That is why there is deliberately **no index on
`name`/`description`**: it would add write cost and storage while the query
still full-scans. This limitation is documented, not hidden.

**When it stops being enough** (and what we would do):
- Slowness at scale → MySQL **FULLTEXT** index first (natural-language
  matching, still in-process, no new infra) — the natural next step.
- Relevance ranking, typo tolerance, facets, cross-field scoring, real-time
  analytics → a dedicated search engine (Elasticsearch/OpenSearch/Meilisearch)
  fed by an outbox/CDC pipeline. That arrives together with the eventing
  stage, not before.

## 6. Index inventory and trade-offs

| Index                        | Added | Query it serves                          | Why it helps                          |
| ---------------------------- | ----- | ---------------------------------------- | ------------------------------------- |
| `products_sku_key` (unique)  | Day 1 | SKU uniqueness + `WHERE sku = ?`         | constraint + O(log n) lookup          |
| `idx_products_category`      | Day 1 | `WHERE category = ?` (browse filter)     | equality → index dive                 |
| `idx_products_price`         | Day 3 | `WHERE price BETWEEN x AND y`            | range scan instead of full scan       |
| (FK indexes on product refs) | auto  | order/cart lookups by product            | MySQL indexes FK columns              |

**Day-3 index decision record — `idx_products_price`:**
1. *Query pattern it helps:* `GET /api/products?minPrice=…&maxPrice=…`, and
   the price component of combined-filter queries.
2. *Why it helps:* a single-column B-tree on `price` turns the range
   predicate into a contiguous index range scan; selective ranges avoid
   scanning the table.
3. *Trade-off accepted:* every INSERT/UPDATE of `price` maintains the index
   (~cheap here: products are written rarely, read constantly); a few MB of
   storage per ~1M rows; the optimizer may ignore it when the range is
   non-selective (fine — then a scan was cheaper anyway).

**Deliberately NOT indexed:** `name`/`description` (see §5 — `%term%` cannot
use a B-tree), `currency` (never filtered), `createdAt` (no query sorts by it
yet; `id DESC` ordering uses the clustered PK).

General rule this project follows: **indexes follow demonstrated query
patterns**, each with a written justification — reads get faster, but every
index taxes writes and storage.

## 7. Authorization: authentication vs authorization

- **Authentication (401)** — *who are you?* `requireAuth` verifies the JWT
  signature/expiry and loads the user. Missing/invalid/expired token → 401.
- **Authorization (403)** — *what may you do?* `requireRole('ADMIN')` checks
  the loaded identity. Authenticated but wrong role → 403.

```
Request
  ↓
requireAuth            → 401 if unauthenticated
  ↓ identify user (fresh DB row via JWT sub)
  ↓
requireRole('ADMIN')   → 403 if authenticated but not ADMIN
  ↓
Controller → Service → Prisma → MySQL
```

**The role always comes from the authenticated identity** — never from the
request body, never re-trusted from the JWT payload alone. `requireAuth`
re-reads the user row identified by the verified token's `sub`, so a role
change (e.g. an operator promoting a user to ADMIN via SQL) takes effect
immediately, even for tokens issued before the change. `requireRole` is a
7-line reusable factory in `middleware/requireRole.ts`; it composes after
`requireAuth` and will be reused by every future admin surface (orders,
payments, inventory).

## 8. Response & error design

- Money is serialized as a fixed-point **string** with 2 decimals
  (`"79999.00"`) — matching `DECIMAL(10,2)`, never a float.
- Responses expose only catalog fields (`id, name, description, price,
  currency, sku, category, isActive, createdAt, updatedAt`) via an explicit
  allowlist in the service. No internal fields, no auth data.
- Error mapping (all through the Day-1 global handler, one contract):
  400 invalid params/fields · 401 unauthenticated · 403 wrong role ·
  404 missing product · 409 duplicate SKU / referenced product ·
  500 unknown (logged server-side, generic message to client).
- Raw Prisma errors (P2002 duplicate SKU, FK restrict on delete) are mapped
  to clean 409s; stack traces and driver messages never reach clients.

## 9. Deleting a product that appeared in orders — why it is dangerous

An order item is an immutable financial record: a receipt must forever be
able to say *what* was bought and *at what price*. If deleting a product
cascaded into `order_items`, order totals would stop adding up and history
would be silently falsified. The schema therefore uses `ON DELETE RESTRICT`
on `order_items.product_id` (and `cart_items.product_id`), making the
database the final safety net — and the service checks the same references
first so the client gets an honest, actionable 409 instead of a driver
exception. The correct long-term deactivation path is `isActive: false`
(soft removal), which hides the product from discovery while history stays
intact.

## 10. System-design evolution notes (identified, not solved)

| Growth / scenario                     | Expected pressure                              | Evolution path (later stages)                   |
| ------------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| 1,000 → 1,000,000 products            | `COUNT(*)` per list call gets slower; deep offsets O(n) | cursor pagination (§4); cached counts |
| `?page=50000`                          | MySQL scans/skips ~1M index entries            | cursor pagination; reject absurd pages         |
| `%term%` search at scale               | full scans on every keystroke                  | MySQL FULLTEXT, then search engine (§5)         |
| Hot catalog reads (homepage, PDP)      | same queries repeated constantly               | Redis cache / CDN for product pages (Day 6+)    |
| Category as free text                  | typos split buckets (`smartphone` vs `phones`) | normalized `categories` table + FK              |
| Admin writes while users read          | momentary inconsistency, fine today            | isolation is already handled by InnoDB MVCC     |

Explicitly deferred today: Redis, Kafka, Elasticsearch, Docker, product
images/variants/reviews/ratings/coupons/discounts, inventory reservation,
orders, payments, frontend UI.

## 11. Known limitations (Day 3)

- Offset pagination only (§4); no cursor/keyset yet.
- Search is substring `LIKE` only (§5); no relevance ranking, no FULLTEXT.
- `category` is a free-text string; no normalized category table.
- No product images/variants/reviews (out of scope by design).
- Admin bootstrap is operational (SQL role update); there is no admin-management API.