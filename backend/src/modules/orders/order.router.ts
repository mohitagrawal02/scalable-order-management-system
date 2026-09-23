import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth';
import * as orderController from './order.controller';

/**
 * Order routes - always scoped to the authenticated user, so `requireAuth` is
 * applied once for the whole router.
 *
 * Mounted at /api/orders by the api router. Admin order management is a later
 * milestone and deliberately absent here.
 */
export const orderRouter = Router();

orderRouter.use(requireAuth);

orderRouter.post('/', orderController.createOrder);
orderRouter.get('/', orderController.listOrders);
orderRouter.get('/:id', orderController.getOrder);