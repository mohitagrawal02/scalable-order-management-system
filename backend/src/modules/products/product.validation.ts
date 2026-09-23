import { AppError } from '../../errors/AppError';
import { CreateProductInput, ListProductsParams, UpdateProductInput } from './product.types';

/**
 * Request validation for the products module.
 *
 * Follows the auth module convention: dependency-free, returns problems,
 * throws AppError(400) for query parameter mistakes.
 */

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_STRING_LENGTH = 255;
const MAX_PRICE = 1_000_000_000; // sanity ceiling, far above any real product

export const PRODUCT_LIST_CONSTANTS = { DEFAULT_PAGE, DEFAULT_LIMIT, MAX_LIMIT };

function requireNonEmptyString(value: unknown, field: string, max = MAX_STRING_LENGTH): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(`${field} is required`, 400);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new AppError(`${field} must be at most ${max} characters`, 400);
  }
  return trimmed;
}

function parsePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppError(`${field} must be a number`, 400);
  }
  if (value <= 0) {
    throw new AppError(`${field} must be greater than 0`, 400);
  }
  if (value > MAX_PRICE) {
    throw new AppError(`${field} is unreasonably large`, 400);
  }
  return value;
}

/** Validates and normalizes a create-product request body. */
export function validateCreateProductInput(body: Record<string, unknown>): CreateProductInput {
  return {
    name: requireNonEmptyString(body.name, 'name'),
    description: requireNonEmptyString(body.description, 'description'),
    price: parsePositiveNumber(body.price, 'price'),
    sku: requireNonEmptyString(body.sku, 'sku', 64),
    category: requireNonEmptyString(body.category, 'category', 100),
  };
}

/** Strips whitespace and enforces field limits early, before Prisma sees it. */
function normalizeOptionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, field, max);
}

/** Validates an update request body; requires at least one known field. */
export function validateUpdateProductInput(body: Record<string, unknown>): UpdateProductInput {
  const input: UpdateProductInput = {};

  if (body.name !== undefined) input.name = normalizeOptionalString(body.name, 'name', MAX_STRING_LENGTH);
  if (body.description !== undefined) {
    input.description = normalizeOptionalString(body.description, 'description', MAX_STRING_LENGTH);
  }
  if (body.price !== undefined) input.price = parsePositiveNumber(body.price, 'price');
  if (body.sku !== undefined) input.sku = normalizeOptionalString(body.sku, 'sku', 64);
  if (body.category !== undefined) input.category = normalizeOptionalString(body.category, 'category', 100);
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') {
      throw new AppError('isActive must be a boolean', 400);
    }
    input.isActive = body.isActive;
  }

  if (Object.keys(input).length === 0) {
    throw new AppError('No valid fields supplied for update', 400);
  }
  return input;
}

/** Reads a query string token; handles Express 5 array-parameter edge cases. */
function readQueryValue(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.trim();
}

function parsePage(value: string | undefined, name: string): number {
  if (value === undefined) return DEFAULT_PAGE;
  const int = Number.parseInt(value, 10);
  if (String(int) !== value || !Number.isInteger(int) || int < 1) {
    throw new AppError(`${name} must be a positive integer`, 400);
  }
  return int;
}

/** Validates + normalizes the list/product query string into service params. */
export function parseListProductsQuery(
  query: Record<string, unknown>
): ListProductsParams {
  const page = parsePage(readQueryValue(query.page), 'page');
  const rawLimit = readQueryValue(query.limit);
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    limit = parsePage(rawLimit, 'limit');
    if (limit > MAX_LIMIT) {
      throw new AppError(`limit must not exceed ${MAX_LIMIT}`, 400);
    }
  }

  const search = readQueryValue(query.search);
  if (search !== undefined && search.length > 100) {
    throw new AppError('search must be at most 100 characters', 400);
  }

  const category = readQueryValue(query.category);
  if (category !== undefined && category.length > 100) {
    throw new AppError('category must be at most 100 characters', 400);
  }

  let minPrice: number | undefined;
  let maxPrice: number | undefined;
  const rawMin = readQueryValue(query.minPrice);
  const rawMax = readQueryValue(query.maxPrice);

  if (rawMin !== undefined) {
    const parsed = Number(rawMin);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new AppError('minPrice must be a number >= 0', 400);
    }
    minPrice = parsed;
  }
  if (rawMax !== undefined) {
    const parsed = Number(rawMax);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new AppError('maxPrice must be a number >= 0', 400);
    }
    maxPrice = parsed;
  }
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    throw new AppError('minPrice must be less than or equal to maxPrice', 400);
  }

  return { page, limit, search, category, minPrice, maxPrice };
}