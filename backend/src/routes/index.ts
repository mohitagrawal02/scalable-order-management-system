import { Router } from 'express';
import { authRouter } from '../modules/auth/auth.router';
import { cartRouter } from '../modules/cart/cart.router';
import { healthRouter } from '../modules/health/health.router';
import { orderRouter } from '../modules/orders/order.router';
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
apiRouter.use('/auth', authRouter);
apiRouter.use('/products', productRouter);
apiRouter.use('/cart', cartRouter);
apiRouter.use('/orders', orderRouter);