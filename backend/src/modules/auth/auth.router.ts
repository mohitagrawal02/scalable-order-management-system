import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth';
import { login, me, register } from './auth.controller';

export const authRouter: Router = Router();

/** Public: creates a User + Cart atomically. */
authRouter.post('/register', register);

/** Public: exchanges credentials for a JWT. */
authRouter.post('/login', login);

/** Protected: returns the currently authenticated user. */
authRouter.get('/me', requireAuth, me);