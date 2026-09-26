import { createHash } from 'node:crypto';
import { config } from '../../config';
import { cache, type CacheLookup } from '../../infrastructure/redis';
import { ListProductsParams, PaginationMeta, ProductResponse } from './product.types';

/**
 * Product catalog caching (Day 6) - the cache-aside layer for the products
 * module. All cache-key knowledge for products lives HERE, so the service
 * stays readable and the strategy is documented in one place.
 *
 * ── Cache keys ──────────────────────────────────────────────────────────────
 *
 *   product:<id>                      → one product detail
 *   product:list:v<version>:<hash>    → one page of one filtered list query
 *   catalog:list:version              → the current list-namespace version
 *
 * ── Why the list key is VERSIONED ───────────────────────────────────────────
 *
 * A list response depends on every filter, on the page, and on the whole
 * catalog content. Invalidating "all list entries" naively means either
 * `KEYS product:list:*` (blocks Redis, O(keyspace) - never do this) or
 * `SCAN`+`DEL` (safe but still proportional to the key count, and racy while
 * paging).
 *
 * Instead, every list key embeds the value of `catalog:list:version`. A write
 * to the catalog does `INCR catalog:list:version` - an O(1), atomic operation
 * that instantly makes EVERY previously cached list unreachable. The orphaned
 * keys are simply left to expire on their TTL (60s), so the garbage is bounded
 * and self-cleaning. No scan, no race, and the same logic works with many API
 * instances because the version lives in Redis, not in process memory.
 *
 * Trade-off (documented in docs/REDIS.md): an unreachable-but-not-deleted key
 * costs a little memory for up to one TTL, and the version counter itself must
 * not be evicted (see "Known limitations").
 *
 * ── Failure policy ──────────────────────────────────────────────────────────
 *
 * Fail open, always:
 *   read error  → treat as MISS and query MySQL (never a 500)
 *   write error → return the MySQL result anyway (never a 500)
 *   bump error  → list entries stay stale for at most one TTL
 */

const DETAIL_KEY_PREFIX = 'product';
const LIST_KEY_PREFIX = 'product:list';
const LIST_VERSION_KEY = 'catalog:list:version';

/** Version used when Redis cannot tell us one (start of the namespace). */
const LIST_VERSION_FALLBACK = 1;

/** Truncated SHA-256 of the normalized query: compact, fixed-width, safe key. */
const LIST_HASH_LENGTH = 16;

export const PRODUCT_CACHE_TTL_SECONDS = config.cache.productTtlSeconds;

export interface ProductListPayload {
  data: ProductResponse[];
  pagination: PaginationMeta;
}


/** `product:<id>` */
export function productDetailCacheKey(id: number): string {
  return `${DETAIL_KEY_PREFIX}:${id}`;
}

/**
 * Normalizes a list query into a canonical shape.
 *
 * Ordering of the properties is FIXED (and explicit `null`s are kept) so the
 * hash depends only on the *meaning* of the query, not on how the client
 * happened to order its query string:
 *
 *   ?category=phones&page=1&limit=10   ==   ?limit=10&page=1&category=phones
 *
 * Values are already normalized upstream by `parseListProductsQuery` (trimmed
 * strings, integer page/limit, applied defaults), so `?limit=20` and "no limit
 * parameter" also collapse onto the same key.
 */
export function normalizeListQuery(params: ListProductsParams): Record<string, unknown> {
  return {
    category: params.category ?? null,
    limit: params.limit,
    maxPrice: params.maxPrice ?? null,
    minPrice: params.minPrice ?? null,
    page: params.page,
    search: params.search ?? null,
  };
}

/** `product:list:v<version>:<hash>` */
export function productListCacheKey(version: number, params: ListProductsParams): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(normalizeListQuery(params)))
    .digest('hex')
    .slice(0, LIST_HASH_LENGTH);
  return `${LIST_KEY_PREFIX}:v${version}:${hash}`;
}

/**
 * Current list-namespace version. Returns the fallback when Redis is
 * unreachable: the resulting key simply misses, and MySQL answers.
 */
export async function getListCacheVersion(): Promise<number> {
  const lookup = await cache.getJson<number>(LIST_VERSION_KEY);
  if (lookup.outcome === 'hit' && typeof lookup.value === 'number') {
    return lookup.value;
  }
  return LIST_VERSION_FALLBACK;
}

/** Cache-aside read of one product detail. */
export async function getCachedProduct(id: number): Promise<CacheLookup<ProductResponse>> {
  return cache.getJson<ProductResponse>(productDetailCacheKey(id));
}

/** Cache-aside write of one product detail (TTL-bounded, best effort). */
export async function setCachedProduct(id: number, product: ProductResponse): Promise<void> {
  await cache.setJson(productDetailCacheKey(id), product, PRODUCT_CACHE_TTL_SECONDS);
}

/** Cache-aside read of one list page. */
export async function getCachedProductList(
  params: ListProductsParams
): Promise<CacheLookup<ProductListPayload>> {
  const version = await getListCacheVersion();
  return cache.getJson<ProductListPayload>(productListCacheKey(version, params));
}

/** Cache-aside write of one list page (TTL-bounded, best effort). */
export async function setCachedProductList(
  params: ListProductsParams,
  payload: ProductListPayload
): Promise<void> {
  const version = await getListCacheVersion();
  await cache.setJson(productListCacheKey(version, params), payload, PRODUCT_CACHE_TTL_SECONDS);
}

/**
 * Invalidation, called after every successful catalog write
 * (POST / PATCH / DELETE /api/products).
 *
 * Two steps, both best effort and both idempotent:
 *
 *   1. `DEL product:<id>`          - precise: removes the directly affected
 *                                    detail entry.
 *   2. `INCR catalog:list:version` - coarse: retires ALL list pages at once,
 *                                    because any list that contained (or
 *                                    omitted) this product may now be wrong:
 *                                    its contents, its totals and therefore
 *                                    every later page shifted.
 *
 * A create has no previously cached detail, so it only bumps the version.
 */
export async function invalidateProductCaches(productId?: number): Promise<void> {
  if (productId !== undefined) {
    await cache.deleteKeys([productDetailCacheKey(productId)]);
  }
  await cache.increment(LIST_VERSION_KEY);
}

