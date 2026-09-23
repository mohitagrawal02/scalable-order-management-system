import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth';
import * as cartController from './cart.controller';

/**
 * Cart routes - every endpoint is user-scoped, so `requireAuth` is applied to
 * the whole router once rather than repeated per route.
 *
 * Mounted at /api/cart by the api router.
 */
export const cartRouter = Router();

cartRouter.use(requireAuth);

cartRouter.get('/', cartController.getCart);
cartRouter.post('/items', cartController.addCartItem);
cartRouter.patch('/items/:productId', cartController.updateCartItem);
cartRouter.delete('/items/:productId', cartController.removeCartItem);
