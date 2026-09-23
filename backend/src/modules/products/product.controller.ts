import { NextFunction, Request, Response } from 'express';
import { AppError } from '../../errors/AppError';
import * as productService from './product.service';
import {
  parseListProductsQuery,
  validateCreateProductInput,
  validateUpdateProductInput,
} from './product.validation';

/**
 * HTTP layer for /api/products.
 *
 * Each handler: (1) validates via product.validation, (2) calls one service
 * function, (3) converts the result into an HTTP response. Authorization
 * (requireAuth + requireRole) is applied in the router, not here.
 */

function parseIdParam(rawParam: unknown): number {
  // Express 5 route params are `string | string[] | undefined`; take the
  // first entry of any array form, then require a clean positive integer.
  const raw = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  if (typeof raw !== 'string') {
    throw new AppError('Invalid product id', 400);
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('Invalid product id', 400);
  }
  return id;
}

/** GET /api/products (public) - paginated, filterable listing. */
export async function listProducts(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Express 5 exposes query as: req.query.pg, or req.query['page'], or array.
    const query = req.query as Record<string, unknown>;
    const params = parseListProductsQuery(query);
    const result = await productService.listProducts(params);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/** GET /api/products/:id (public) - single product detail. */
export async function getProduct(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = parseIdParam(req.params.id);
    const product = await productService.getProductById(id);
    res.status(200).json({ product });
  } catch (err) {
    next(err);
  }
}

/** POST /api/products (ADMIN) - create a product. */
export async function createProduct(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const input = validateCreateProductInput(req.body ?? {});
    const product = await productService.createProduct(input);
    res.status(201).json({ product });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/products/:id (ADMIN) - update product fields. */
export async function updateProduct(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = parseIdParam(req.params.id);
    const input = validateUpdateProductInput(req.body ?? {});
    const product = await productService.updateProduct(id, input);
    res.status(200).json({ product });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/products/:id (ADMIN) - delete a product. */
export async function deleteProduct(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = parseIdParam(req.params.id);
    await productService.deleteProduct(id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}