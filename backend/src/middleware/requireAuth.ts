import { NextFunction, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { AppError } from '../errors/AppError';
import { verifyToken } from '../modules/auth/auth.utils';

/**
 * Verifies the `Authorization: Bearer <token>` header and loads the
 * authenticated user into `req.auth`.
 *
 * Reusable for ANY future protected route: mount it before the route, e.g.
 *   router.get('/me', requireAuth, controller)
 *
 * Why load the user in middleware? The JWT only carries the user id (sub).
 * Re-reading the row per request gives us the current role/name, handles
 * deleted users, and keeps a single source of truth for user data.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      throw new AppError('Missing or malformed Authorization header', 401);
    }

    const token = header.slice('Bearer '.length).trim();
    if (token.length === 0) {
      throw new AppError('Missing or malformed Authorization header', 401);
    }

    // Throws (→ 401) for invalid signature, expired token, wrong issuer.
    const payload = verifyToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true, role: true },
    });

    if (!user) {
      throw new AppError('User no longer exists', 401);
    }

    req.auth = {
      user,
      tokenPayload: {
        sub: payload.sub,
        role: payload.role,
        iat: payload.iat ?? 0,
        exp: payload.exp ?? 0,
      },
      token,
    };

    next();
  } catch (err) {
    next(err);
  }
}