import { Router } from 'express';
import { authRouter } from '../modules/auth/auth.router';
import { cartRouter } from '../modules/cart/cart.router';
import { metricsRouter } from '../modules/metrics/metrics.router';
import { notificationRouter } from '../modules/notifications/notification.router';
import { orderRouter } from '../modules/orders/order.router';
import { paymentRouter } from '../modules/payments/payment.router';
import { healthRouter } from '../modules/health/health.router';
import { productRouter } from '../modules/products/product.router';

/**
 * Root API router.
 *
 * Feature modules are mounted as sub-routers here. As modules are added
 * (cart, orders, ...), they get mounted under their own path:
 *   app.use('/api', apiRouter).  The apiRouter below simply delegates.
 */
export const apiRouter: Router = Router();

apiRouter.use('/health', healthRouter);
// Operational counters (Day 8). Mounted here rather than in app.ts so the
// metrics route shares the /api prefix, the request-id middleware and the
// error envelope with every other endpoint.
apiRouter.use('/metrics', metricsRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/products', productRouter);
apiRouter.use('/cart', cartRouter);
apiRouter.use('/notifications', notificationRouter);

// Payment is a sub-resource of an order: /api/orders/:orderId/payments.
// mergeParams on the child router makes :orderId visible to its handlers,
// and this mount must come BEFORE the plain /orders router so the more
// specific path wins.
apiRouter.use('/orders/:orderId/payments', paymentRouter);
apiRouter.use('/orders', orderRouter);