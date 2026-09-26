import { createHash } from 'node:crypto';
import { Request } from 'express';
import { config } from '../../config';
import { rateLimit } from '../../middleware/rateLimit';
import { normalizeEmail } from './auth.validation';

/**
 * Login rate-limiting policy (Day 6).
 *
 * ── What is limited ─────────────────────────────────────────────────────────
 *
 * `RATE_LIMIT_LOGIN_MAX` attempts (default 5) per `RATE_LIMIT_LOGIN_WINDOW_SECONDS`
 * (default 60) for one **(client IP + targeted account)** pair.
 *
 * ── Why that identifier and not IP alone ────────────────────────────────────
 *
 * A per-IP-only bucket is the textbook first guess, but it has two properties
 * this project does not want:
 *
 * 1. **Collateral damage.** Students/offices/NAT users and CI runners share one
 *    public IP. One careless client would lock out everyone behind it.
 * 2. **It cannot see the attack.** Credential guessing is per *account*: the
 *    interesting signal is "many attempts against the same login", which an
 *    IP-only counter cannot distinguish from "many users logging in".
 *
 * Pairing the IP with the targeted account keeps the protection where the
 * risk is, and still bounds a single attacker's guesses against any account.
 *
 * Known gap (documented, not hidden): an attacker who sprays *one* guess
 * across many accounts from many IPs is not slowed by this bucket. The
 * production hardening path - a coarse per-IP bucket, progressive delays and
 * account lockout - is listed in docs/REDIS.md § "Future improvements".
 *
 * ── Key shape ──────────────────────────────────────────────────────────────
 *
 *   rate-limit:login:<sha256(ip|email) truncated>
 *
 * The identifier is a hash on purpose: Redis ends up with no raw email
 * addresses or IP addresses in its key space (GDPR-friendly, and safe to dump
 * with `redis-cli KEYS` while debugging).
 */
const LOGIN_NAMESPACE = 'rate-limit:login';
const IDENTIFIER_HASH_LENGTH = 32;

/** Best-effort client IP. Never trusts spoofable forwarding headers. */
function clientIp(req: Request): string {
  // `req.ip` honours Express' `trust proxy` setting. It is deliberately NOT
  // read from X-Forwarded-For here: without a trusted reverse proxy in front,
  // that header is attacker-controlled and would make the limit trivially
  // bypassable (send a new fake IP per request).
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

/** Normalized email from the request body, if the body carries one. */
function attemptedAccount(req: Request): string {
  const body = req.body as { email?: unknown } | undefined;
  if (!body || typeof body.email !== 'string') return '';
  return normalizeEmail(body.email);
}

/**
 * `rate-limit:login:<hash>` - the key a login request is counted against.
 * Also used by tests to inspect the counter directly (see rateLimit.test.ts).
 */
export function loginRateLimitKey(ip: string, email: string): string {
  const digest = createHash('sha256')
    .update(`${ip}|${normalizeEmail(email)}`)
    .digest('hex')
    .slice(0, IDENTIFIER_HASH_LENGTH);
  return `${LOGIN_NAMESPACE}:${digest}`;
}

export const loginRateLimit = rateLimit({
  key: (req) => loginRateLimitKey(clientIp(req), attemptedAccount(req)),
  limit: config.rateLimit.login.maxAttempts,
  windowSeconds: config.rateLimit.login.windowSeconds,
  message: 'Too many login attempts for this account, please try again later',
});
