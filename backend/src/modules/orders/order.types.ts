import { OrderStatus } from '@prisma/client';

/**
 * Order module types.
 *
 * Two shapes exist for orders on purpose:
 *  - summary   -> cheap list rows for "my orders" (no item join)
 *  - detail    -> order + order items + minimal product identity
 *
 * Money is always serialized as a *string* (`Decimal.toFixed(2)`), never a
 * JavaScript number, so precision cannot be lost between MySQL and the client.
 */

export interface OrderItemProductSummary {
  id: number;
  name: string;
  sku: string;
  category: string;
  /** Informational only - the historical purchase price is `unitPrice`. */
  currentPrice: string;
  isActive: boolean;
}

export interface OrderItemResponse {
  productId: number;
  quantity: number;
  /**
   * Price captured at checkout time (OrderItem.unitPrice), NOT Product.price.
   * This is what makes historical orders immune to later price changes.
   */
  unitPrice: string;
  /** unitPrice x quantity. */
  lineTotal: string;
  product: OrderItemProductSummary;
}

export interface OrderSummaryResponse {
  id: number;
  orderNumber: string;
  status: OrderStatus;
  totalAmount: string;
  itemCount: number;
  createdAt: Date;
}

export interface OrderDetailResponse {
  id: number;
  orderNumber: string;
  status: OrderStatus;
  totalAmount: string;
  shippingAddress: string;
  items: OrderItemResponse[];
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedOrders {
  data: OrderSummaryResponse[];
  pagination: PaginationMeta;
}

/** Validated request body for POST /api/orders. */
export interface CreateOrderInput {
  shippingAddress: string;
}

/** Validated query string for GET /api/orders. */
export interface ListOrdersParams {
  page: number;
  limit: number;
}