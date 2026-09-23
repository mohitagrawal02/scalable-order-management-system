import { NextFunction, Request, Response } from 'express';
import { AppError } from '../../errors/AppError';
import * as authService from './auth.service';
import { validateLoginInput, validateRegisterInput } from './auth.validation';

/**
 * HTTP layer for /api/auth/*.
 *
 * Each handler: (1) validates via auth.validation, (2) calls one service
 * function, (3) converts the service result into an HTTP response. No
 * business rules or database calls live here.
 */

function validationProblem(message: string) {
  return new AppError(message, 400);
}

export async function register(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const body = req.body ?? {};
    const validation = validateRegisterInput({
      name: body.name,
      email: body.email,
      password: body.password,
    });

    if (!validation.valid) {
      throw validationProblem(validation.problems.join('; '));
    }

    const result = await authService.register({
      name: body.name,
      email: body.email,
      password: body.password,
    });

    res.status(201).json({ user: result.user });
  } catch (err) {
    next(err);
  }
}

export async function login(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const body = req.body ?? {};
    const validation = validateLoginInput({ email: body.email, password: body.password });

    if (!validation.valid) {
      throw validationProblem(validation.problems.join('; '));
    }

    const result = await authService.login({
      email: body.email,
      password: body.password,
    });

    res.status(200).json({ token: result.token, user: result.user });
  } catch (err) {
    next(err);
  }
}

/** Protected: requires a valid JWT (requireAuth middleware ran first). */
export async function me(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.auth) {
      throw new AppError('Not authenticated', 401);
    }
    const user = await authService.getProfile(req.auth.user.id);
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}