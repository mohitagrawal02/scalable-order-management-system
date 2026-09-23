/**
 * Augments Express's Request type with an `auth` property that the
 * `requireAuth` middleware attaches after verifying the JWT.
 *
 * Downstream handlers (controllers) read `req.auth.user` and never need to
 * parse the token themselves.
 */
declare global {
  namespace Express {
    interface Request {
      auth?: {
        /** The authenticated user, freshly loaded from the database. */
        user: {
          id: number;
          email: string;
          name: string;
          role: string;
        };
        /** The JWT payload (sub/role + standard claims). Never contains hashes. */
        tokenPayload: {
          sub: number;
          role: string;
          iat: number;
          exp: number;
        };
        /** The raw token received in the Authorization header. */
        token: string;
        [key: string]: unknown;
      };
    }
  }
}

/** Safe user shape returned by authentication endpoints. */
export interface SafeUser {
  id: number;
  name: string;
  email: string;
  role: string;
}

/** Shape of the JWT payload we create and verify (claims added by jwt.sign). */
export interface JwtPayload {
  sub: number;
  role: string;
  iat?: number;
  exp?: number;
}