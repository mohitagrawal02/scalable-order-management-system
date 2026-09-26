import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth';
import {
  createPaymentHandler,
  getPaymentHandler,
} from './payment.controller';

/**
 * Payment routes are mounted under /api/orders/:orderId/payments so payment
 * reads like a sub-resource of the order it pays for.
 */
export const paymentRouter: Router = Router({ mergeParams: true });

paymentRouter.post('/', requireAuth, createPaymentHandler);
paymentRouter.get('/', requireAuth, getPaymentHandler);