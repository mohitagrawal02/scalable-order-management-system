import { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/AppError';

/**
 * Role authorization - MUST run AFTER requireAuth (which guarantees
 * `req.auth.user` exists and comes from a freshly verified identity).
 *
 *   requireAuth  → 401 when unauthenticated
 *   requireRole  → 403 when authenticated but lacking the role
 *
 * The role is read from req.auth.user.role, which requireAuth loaded from the
 * database row identified by the verified JWT's `sub` — never from the client
 * and never trusted from the token alone.
 */
export function requireRole(role: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      // Should be unreachable when used after requireAuth, but never assume.
      next(new AppError('Not authenticated', 401));
      return;
    }
    if (req.auth.user.role !== role) {
      next(new AppError(`Requires ${role} role`, 403));
      return;
    }
    next();
  };
}