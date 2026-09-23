import 'dotenv/config';

/**
 * Centralised application configuration.
 *
 * Environment variables are read ONCE at startup and validated here so the
 * server fails fast (with a clear message) instead of crashing in the middle
 * of a request with an obscure TypeError.
 */

const requiredEnvVars = ['DATABASE_URL', 'PORT', 'JWT_SECRET'] as const;

for (const name of requiredEnvVars) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function toPositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer. Got: "${value}"`);
  }
  return parsed;
}

/**
 * JWT secrets below 32 chars are weak. Failing here (instead of at the first
 * login request) forces a proper secret into .env.
 */
const jwtSecret = process.env.JWT_SECRET as string;
if (jwtSecret.length < 32) {
  throw new Error(
    'JWT_SECRET must be at least 32 characters long. Generate one, e.g.:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"'
  );
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: toPositiveInt(process.env.PORT as string, 'PORT'),
  databaseUrl: process.env.DATABASE_URL as string,
  jwt: {
    secret: jwtSecret,
    expiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
    issuer: 'ecommerce-platform',
  },
} as const;

export type Config = typeof config;