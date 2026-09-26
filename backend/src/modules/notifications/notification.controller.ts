import { Request, Response } from 'express';
import { AppError } from '../../errors/AppError';
import { listNotifications } from './notification.service';

/** Notification HTTP layer. Identity ALWAYS comes from req.auth (JWT). */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * GET /api/notifications?page=&limit=
 *
 * The userId is read exclusively from the authenticated identity - there is
 * no code path that accepts a client-supplied userId.
 */
/** Reads the authenticated user id, or fails loudly if the guard is missing. */
function requireUserId(req: Request): number {
  const user = req.auth?.user;
  if (!user) {
    // Defensive only: requireAuth guarantees this on every mounted route.
    throw new AppError('Authentication required', 401);
  }
  return user.id;
}

export async function listNotificationsHandler(
  req: Request,
  res: Response
): Promise<void> {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit);
  const result = await listNotifications(requireUserId(req), page, limit);
  res.status(200).json(result);
}

function parsePage(raw: unknown): number {
  if (raw === undefined) return 1;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new AppError('page must be a positive integer', 400);
  }
  return n;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new AppError(`limit must be an integer between 1 and ${MAX_LIMIT}`, 400);
  }
  return n;
}