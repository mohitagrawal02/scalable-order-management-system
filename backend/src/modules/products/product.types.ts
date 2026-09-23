/**
 * Shared product module types.
 */

/** Public, safe shape of a product as returned by the API. */
export interface ProductResponse {
  id: number;
  name: string;
  description: string;
  price: string; // serialized Decimal - money stays exact, never float
  currency: string;
  sku: string;
  category: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Normalized query parameters for listing products. */
export interface ListProductsParams {
  page: number;
  limit: number;
  search?: string;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
}

/** Pagination metadata returned with every list response. */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Request body shape for creating a product. */
export interface CreateProductInput {
  name: string;
  description: string;
  price: number;
  sku: string;
  category: string;
}

/** Request body shape for updating a product (all fields optional). */
export interface UpdateProductInput {
  name?: string;
  description?: string;
  price?: number;
  sku?: string;
  category?: string;
  isActive?: boolean;
}