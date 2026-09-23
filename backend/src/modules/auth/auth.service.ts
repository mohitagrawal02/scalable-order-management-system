import bcrypt from 'bcryptjs';
import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import { signToken, toSafeUser } from './auth.utils';
import { normalizeEmail } from './auth.validation';

/**
 * Business logic for the auth module.
 *
 * Controllers stay thin: they validate the request (via auth.validation),
 * call one of these service functions, and shape the HTTP response. Services
 * own all business rules and database interactions.
 */

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

const BCRYPT_ROUNDS = 12;

/**
 * Creates a new user AND its shopping cart as one atomic operation.
 *
 * Both rows must exist together: every registered user has exactly one cart,
 * and a cart without its owner is meaningless. Prisma's interactive
 * transaction runs the callback inside a single database transaction:
 *
 *   BEGIN; INSERT user; INSERT cart; COMMIT;   -- or ROLLBACK on any error
 */
export async function register(input: RegisterInput) {
  const email = normalizeEmail(input.email);
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  // Pre-check purely to give a friendly, fast "email already registered"
  // error in the common case. The unique constraint is the real guard: if two
  // requests race, the second one fails the constraint and is handled below.
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError('Email is already registered', 409);
  }

  try {
    const user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email,
          name: input.name.trim(),
          passwordHash,
          role: 'CUSTOMER',
        },
      });

      // Every user gets a cart on signup. If this insert fails, the whole
      // transaction rolls back and the user above is NOT persisted.
      await tx.cart.create({
        data: { userId: createdUser.id },
      });

      return createdUser;
    });

    return { user: toSafeUser(user) };
  } catch (err) {
    // P2002 = unique constraint violation. Under race conditions (two
    // simultaneous registrations with the same email) this is how the
    // duplicate is caught at the database layer.
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === 'P2002'
    ) {
      throw new AppError('Email is already registered', 409);
    }
    throw err;
  }
}

const LOGIN_FAILED_MESSAGE = 'Invalid email or password';

/** Authenticates a user and returns a signed JWT + safe user info. */
export async function login(input: LoginInput) {
  const email = normalizeEmail(input.email);

  // One SELECT covers both paths (no separate existence probe), so the
  // response time and message are identical whether the email exists or not.
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, role: true, passwordHash: true },
  });

  if (!user) {
    throw new AppError(LOGIN_FAILED_MESSAGE, 401);
  }

  const passwordMatches = await bcrypt.compare(input.password, user.passwordHash);
  if (!passwordMatches) {
    throw new AppError(LOGIN_FAILED_MESSAGE, 401);
  }

  const token = signToken(user.id, user.role);
  return { token, user: toSafeUser(user) };
}

/** Loads a fresh copy of the authenticated user. */
export async function getProfile(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true },
  });

  if (!user) {
    throw new AppError('User not found', 404);
  }

  return toSafeUser(user);
}