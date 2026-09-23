import jwt from 'jsonwebtoken';
import { config } from '../../config';
import { JwtPayload, SafeUser } from './auth.types';

/**
 * Signs a JWT for an authenticated user.
 *
 * The payload contains ONLY what the server is willing to trust without a
 * database lookup: the user id (`sub`) and role. No password hash, no email,
 * no personal data. Everything else is re-read from the database per request.
 */
export function signToken(userId: number, role: string): string {
  const payload: JwtPayload = { sub: userId, role };
  // expiresIn comes from .env as a plain string; jsonwebtoken accepts its own
  // StringValue literal union or a number, so we coerce at this boundary.
  const expiresIn = config.jwt.expiresIn as jwt.SignOptions['expiresIn'];
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn,
    issuer: config.jwt.issuer,
  });
}

/** Verifies a token and returns its decoded payload (throws on failure). */
export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwt.secret, {
    issuer: config.jwt.issuer,
  }) as unknown as JwtPayload;
}

/**
 * Projects a database User row onto the safe shape returned by the API.
 *
 * This is the SINGLE place that decides what authentication endpoints may
 * return. It is an explicit allowlist, so adding a sensitive column to the
 * User model can never silently leak into responses.
 */
export function toSafeUser(user: {
  id: number;
  name: string;
  email: string;
  role: string;
}): SafeUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}