import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import {
  getCachedProduct,
  getCachedProductList,
  invalidateProductCaches,
  setCachedProduct,
  setCachedProductList,
} from './product.cache';
import {
  CreateProductInput,
  ListProductsParams,
  PaginationMeta,
  ProductResponse,
  UpdateProductInput,
} from './product.types';

/**
 * Business logic for the products module.
 *
 * Controllers validate the request, hand over a typed input, and shape the
 * response. Services own all business rules and Prisma interactions.
 *
 * Day 6 added the cache-aside read path for the two public read endpoints and
 * invalidation on every admin write. MySQL stays the source of truth: the
 * cache is consulted first, but every miss/error path ends in the same Prisma
 * query as before (see product.cache.ts).
 */

/** Maps a Prisma Product row to the public response shape (money as string). */
export function formatProduct(product: {
  id: number;
  name: string;
  description: string;
  price: Prisma.Decimal;
  currency: string;
  sku: string;
  category: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): ProductResponse {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    // Canonical money serialization: always 2 decimal places, matching the
    // DECIMAL(10,2) column (Decimal.toString() would strip trailing zeros).
    price: product.price.toFixed(2),
    currency: product.currency,
    sku: product.sku,
    category: product.category,
    isActive: product.isActive,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

const PRODUCT_SAFE_SELECT = {
  id: true,
  name: true,
  description: true,
  price: true,
  currency: true,
  sku: true,
  category: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Detects Prisma unique-key violation (P2002) to map it to a clean 409. */
function isUniqueConstraintError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}

/** Detects Prisma "record not found" (P2025) to map it to a clean 404. */
function isNotFoundError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025'
  );
}

function toDecimal(value: number): Prisma.Decimal {
  // Trim float noise before storing (e.g. 19.99 -> "19.99").
  return new Prisma.Decimal(value.toFixed(2));
}

/** Creates a product (ADMIN only - enforced in the route layer). */
export async function createProduct(input: CreateProductInput): Promise<ProductResponse> {
  try {
    const product = await prisma.product.create({
      data: {
        name: input.name,
        description: input.description,
        price: toDecimal(input.price),
        sku: input.sku,
        category: input.category,
      },
    });

    // A new product can appear in existing list results (every filter/page),
    // so the whole list namespace is retired. No detail entry can exist yet.
    await invalidateProductCaches();

    return formatProduct(product);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new AppError('A product with this SKU already exists', 409);
    }
    throw err;
  }
}

/** Updates an existing product (ADMIN only). */
export async function updateProduct(
  id: number,
  input: UpdateProductInput
): Promise<ProductResponse> {
  const data: Prisma.ProductUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.price !== undefined) data.price = toDecimal(input.price);
  if (input.sku !== undefined) data.sku = input.sku;
  if (input.category !== undefined) data.category = input.category;
  if (input.isActive !== undefined) data.isActive = input.isActive;

  try {
    const product = await prisma.product.update({ where: { id }, data });

    // Commit first, invalidate second: if invalidation fails, the API already
    // succeeded and the cache self-corrects within one TTL.
    await invalidateProductCaches(id);

    return formatProduct(product);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new AppError('A product with this SKU already exists', 409);
    }
    if (isNotFoundError(err)) {
      throw new AppError('Product not found', 404);
    }
    throw err;
  }
}

/**
 * Lists active products with offset pagination + composable filters.
 *
 * The where clause is assembled from exactly the parameters the caller
 * supplied: no param present -> no filter applied. Search uses a relational
 * `contains` (LIKE %...%) against name/description - deliberately basic for
 * this stage (see docs/PRODUCTS.md for the trade-off analysis).
 */
async function buildListWhere(params: ListProductsParams): Promise<Prisma.ProductWhereInput> {
  const where: Prisma.ProductWhereInput = { isActive: true };

  if (params.search !== undefined) {
    where.OR = [
      { name: { contains: params.search } },
      { description: { contains: params.search } },
    ];
  }

  if (params.category !== undefined) {
    where.category = params.category;
  }

  // MySQL utf8mb4_unicode_ci collation already makes `contains` case-insensitive.
  if (params.minPrice !== undefined || params.maxPrice !== undefined) {
    where.price = {
      ...(params.minPrice !== undefined ? { gte: toDecimal(params.minPrice) } : {}),
      ...(params.maxPrice !== undefined ? { lte: toDecimal(params.maxPrice) } : {}),
    };
  }

  return where;
}

/**
 * Lists one page of products + pagination metadata.
 *
 * Cache-aside (Day 6):
 *   GET product:list:v<version>:<hash(normalized query)>
 *     hit  → return the stored payload (no MySQL round trip at all)
 *     miss → run the two queries below, store the payload with a TTL, return it
 *
 * Two queries run in a transaction for consistency: COUNT(*) for metadata
 * and the LIMIT/OFFSET page. We never pull the whole table into memory.
 */
export async function listProducts(
  params: ListProductsParams
): Promise<{ data: ProductResponse[]; pagination: PaginationMeta }> {
  const cached = await getCachedProductList(params);
  if (cached.outcome === 'hit') {
    return cached.value;
  }

  const { page, limit } = params;
  const where = await buildListWhere(params);

  const [total, products] = await prisma.$transaction([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      select: PRODUCT_SAFE_SELECT,
      orderBy: { id: 'desc' }, // newest first, stable across pages
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  const payload = {
    data: products.map(formatProduct),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };

  await setCachedProductList(params, payload);
  return payload;
}

/** Returns one active product; 404 when missing or inactive. */
export async function getProductById(id: number): Promise<ProductResponse> {
  const cached = await getCachedProduct(id);
  if (cached.outcome === 'hit') {
    return cached.value;
  }

  const product = await prisma.product.findFirst({
    where: { id, isActive: true },
    select: PRODUCT_SAFE_SELECT,
  });
  if (!product) {
    // Deliberately NOT cached: negative entries would need their own
    // invalidation on create/update to avoid serving 404 for a live product.
    throw new AppError('Product not found', 404);
  }

  const formatted = formatProduct(product);
  await setCachedProduct(id, formatted);
  return formatted;
}

/**
 * Deletes a product (ADMIN only).
 *
 * Why guard delete-by-references *in code* and not just rely on the DB?
 * Order items are immutable financial records: a receipt must always be able
 * to say what was bought, at what price. The schema enforces this with
 * `ON DELETE RESTRICT` (order_items, cart_items) - the database is the final
 * safety net. But a raw Prisma FK exception is meaningless to a client;
 * checking the same references first lets us return an honest 409 with a
 * useful message.
 */
export async function deleteProduct(id: number): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id },
    select: {
      id: true,
      _count: { select: { orderItems: true, cartItems: true } },
    },
  });

  if (!product) {
    throw new AppError('Product not found', 404);
  }
  if (product._count.orderItems > 0) {
    throw new AppError(
      'Product cannot be deleted: it appears in existing order records',
      409
    );
  }
  if (product._count.cartItems > 0) {
    throw new AppError(
      'Product cannot be deleted: it is currently in at least one shopping cart',
      409
    );
  }

  await prisma.product.delete({ where: { id } });

  // Deleted: the detail entry must disappear immediately, and every list page
  // must be rebuilt without this product.
  await invalidateProductCaches(id);
}