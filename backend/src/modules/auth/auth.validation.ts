/**
 * Simple, dependency-free request validation for the auth module.
 *
 * Returns an array of human-readable problems (empty = valid). Keeping this
 * here instead of inside controllers/services means validation rules are easy
 * to read, test and reuse, without pulling in a validation framework.
 */

export interface AuthValidationResult {
  valid: boolean;
  problems: string[];
}

const EMAIL_MAX_LENGTH = 255;
const NAME_MIN_LENGTH = 1;
const NAME_MAX_LENGTH = 100;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 72; // bcrypt truncates input at 72 bytes

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function collectProblems(
  problems: string[],
  condition: boolean,
  message: string
): void {
  if (condition) {
    problems.push(message);
  }
}

/** Normalizes an email for storage and comparison. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateRegisterInput(body: {
  name?: unknown;
  email?: unknown;
  password?: unknown;
}): AuthValidationResult {
  const problems: string[] = [];

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  const password = typeof body.password === 'string' ? body.password : '';

  collectProblems(problems, name.length < NAME_MIN_LENGTH, 'name is required');
  collectProblems(
    problems,
    name.length > NAME_MAX_LENGTH,
    `name must be at most ${NAME_MAX_LENGTH} characters`
  );
  collectProblems(problems, email.length === 0, 'email is required');
  collectProblems(
    problems,
    email.length > 0 && !EMAIL_REGEX.test(email),
    'email must be a valid email address'
  );
  collectProblems(
    problems,
    email.length > EMAIL_MAX_LENGTH,
    `email must be at most ${EMAIL_MAX_LENGTH} characters`
  );
  collectProblems(problems, password.length === 0, 'password is required');
  collectProblems(
    problems,
    password.length > 0 && password.length < PASSWORD_MIN_LENGTH,
    `password must be at least ${PASSWORD_MIN_LENGTH} characters`
  );
  collectProblems(
    problems,
    password.length > PASSWORD_MAX_LENGTH,
    `password must be at most ${PASSWORD_MAX_LENGTH} characters`
  );

  return { valid: problems.length === 0, problems };
}

export function validateLoginInput(body: {
  email?: unknown;
  password?: unknown;
}): AuthValidationResult {
  const problems: string[] = [];

  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  const password = typeof body.password === 'string' ? body.password : '';

  collectProblems(problems, email.length === 0, 'email is required');
  collectProblems(problems, password.length === 0, 'password is required');

  return { valid: problems.length === 0, problems };
}