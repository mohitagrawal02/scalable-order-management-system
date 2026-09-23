/**
 * Shared cart module types.
 *
 * A cart is a record of *intent*, not a reservation: it says what the user
 * wants to buy, never how much stock they have secured. Stock is only ever
 * reserved/decremented inside the checkout transaction (see orders module).
 */

/** Denormalized product view embedded in a cart item (safe fields only). */
export interface CartProductSummary {
  id: number;
  name: string;
  /** Current catalog price, informational - checkout re-reads the price. */
  price: string;
  currency: string;
  sku: string;
  category: string;
  isActive: boolean;
  /**
   * Current stock, shown for information only. `null` when the product has no
   * inventory row yet. Cart contents are NEVER validated against this value -
   * it can be stale the moment another customer buys the last unit.
   */
  availableQuantity: number | null;
}

export interface CartItemResponse {
  productId: number;
  quantity: number;
  /** quantity x current catalog price (informational, recalculated at checkout). */
  lineTotal: string;
  product: CartProductSummary;
}

/** Public shape of a cart as returned by the API. */
export interface CartResponse {
  id: number;
  items: CartItemResponse[];
  /** Number of distinct product lines. */
  itemCount: number;
  /** Total number of units across all lines. */
  totalQuantity: number;
  /** Sum of line totals, using current catalog prices. */
  totalAmount: string;
}

/** Validated request body for adding an item to the cart. */
export interface AddCartItemInput {
  productId: number;
  quantity: number;
}

/** Validated request body for updating an existing cart line. */
export interface UpdateCartItemInput {
  quantity: number;
}
