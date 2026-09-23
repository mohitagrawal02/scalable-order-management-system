import { AppError } from '../../errors/AppError';
import { CreateOrderInput, ListOrdersParams } from './order.types';

/**
 * Request validation for the orders module.
 *
 * Mirrors the products module conventions (dependency-free helpers, AppError(400)).
 *
 * Note what is deliberately absent: there is no `totalAmount`, no `userId` and
 * no `status` field. The server computes the total from the cart, takes the
 * owner from the JWT, and decides the initial status. Anything the client sends
 * for those is ignored, so a malicious body cannot influence pricing or ownership.
 */

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Matches Order.shippingAddress @db.VarChar(500). */
const MAX_ADDRESS_LENGTH = 500;
const MIN_ADDRESS_LENGTH = 5;

export const ORDER_LIST_CONSTANTS = { DEFAULT_PAGE, DEFAULT_LIMIT, MAX_LIMIT };

/** Validates and normalizes a create-order request body. */
export function validateCreateOrderInput(
  body: Record<string, unknown>
): CreateOrderInput {
  const raw = body.shippingAddress;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new AppError('shippingAddress is required', 400);
  }

  const shippingAddress = raw.trim().replace(/\s+/g, ' ');
  if (shippingAddress.length < MIN_ADDRESS_LENGTH) {
    throw new AppError(
      `shippingAddress must be at least ${MIN_ADDRESS_LENGTH} characters`,
      400
    );
  }
  // Enforced here so an over-long address fails as 400, not as a MySQL
  // "data too long" error surfacing as a 500.
  if (shippingAddress.length > MAX_ADDRESS_LENGTH) {
    throw new AppError(
      `shippingAddress must be at most ${MAX_ADDRESS_LENGTH} characters`,
      400
    );
  }

  return { shippingAddress };
}

/** Reads a query string token; tolerates Express 5 array-parameter forms. */
function readQueryValue(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.trim();
}

function parsePage(value: string | undefined, name: string): number {
  if (value === undefined) return DEFAULT_PAGE;
  const int = Number.parseInt(value, 10);
  // `String(int) !== value` rejects "2.5", "1e3", " 2 " and "-100".
  if (String(int) !== value || !Number.isInteger(int) || int < 1) {
    throw new AppError(`${name} must be a positive integer`, 400);
  }
  return int;
}

/** Validates + normalizes the list-orders query string. */
export function parseListOrdersQuery(
  query: Record<string, unknown>
): ListOrdersParams {
  const page = parsePage(readQueryValue(query.page), 'page');

  let limit = DEFAULT_LIMIT;
  const rawLimit = readQueryValue(query.limit);
  if (rawLimit !== undefined) {
    limit = parsePage(rawLimit, 'limit');
    if (limit > MAX_LIMIT) {
      throw new AppError(`limit must not exceed ${MAX_LIMIT}`, 400);
    }
  }

  return { page, limit };
}

/** Reads a positive-integer :id path parameter. */
export function parseOrderIdParam(rawParam: unknown): number {
  const raw = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  if (typeof raw !== 'string') {
    throw new AppError('Invalid order id', 400);
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('Invalid order id', 400);
  }
  return id;
}