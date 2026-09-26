import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth';
import { loginRateLimit } from './auth.rateLimit';
import { login, me, register } from './auth.controller';

export const authRouter: Router = Router();

/** Public: creates a User + Cart atomically. */
authRouter.post('/register', register);

/**
 * Public: exchanges credentials for a JWT.
 *
 * Rate limited (Day 6): the limiter runs BEFORE validation/hashing so a
 * guessing loop cannot burn bcrypt CPU or database time - it is rejected with
 * 429 the moment Redis says the window is exhausted.
 */
authRouter.post('/login', loginRateLimit, login);

/** Protected: returns the currently authenticated user. */
authRouter.get('/me', requireAuth, me);