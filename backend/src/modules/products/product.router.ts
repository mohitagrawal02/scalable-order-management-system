import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth';
import { requireRole } from '../../middleware/requireRole';
import {
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  updateProduct,
} from './product.controller';

export const productRouter: Router = Router();

// Public catalog endpoints (no authentication).
productRouter.get('/', listProducts);
productRouter.get('/:id', getProduct);

// Admin product management.
productRouter.post('/', requireAuth, requireRole('ADMIN'), createProduct);
productRouter.patch('/:id', requireAuth, requireRole('ADMIN'), updateProduct);
productRouter.delete('/:id', requireAuth, requireRole('ADMIN'), deleteProduct);