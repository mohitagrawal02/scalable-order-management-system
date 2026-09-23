# Authentication â€” design & flows (Day 2)

> Status: Day 2 complete. Covers registration, login, JWT verification and the
> User+Cart transactional invariant.

## 1. Endpoints

| Method | Path            | Auth required | Purpose                                        |
| ------ | --------------- | ------------- | ---------------------------------------------- |
| POST   | `/api/auth/register` | no      | Create a user + their cart atomically (201)    |
| POST   | `/api/auth/login`    | no      | Verify credentials, issue a JWT (200)          |
| GET    | `/api/auth/me`       | **yes** | Return the authenticated user's safe profile   |

## 2. Registration flow

```
Client
  â†’ POST /api/auth/register { name, email, password }
  â†’ auth.router â†’ auth.controller.register
      â†’ auth.validation      validate name/email/password                (400 on failure)
      â†’ pre-check user exists â†’ 409 "Email is already registered" (friendly fast path)
      â†’ auth.service.register
          â†’ bcrypt.hash(password, 12)                password NEVER stored in plaintext
          â†’ prisma.$transaction(async (tx) => {
              tx.user.create({ email, name, passwordHash })
              tx.cart.create({ userId })
            })                                      atomic: both or neither
      â†’ 201 { user: { id, name, email, role } }      passwordHash is excluded by toSafeUser
```

Email is normalized to lowercase/trimmed before any comparison or storage, so
`User@Example.COM ` registers as `user@example.com` and a second attempt with
different casing is rejected by the **same** unique constraint.

Race condition note: two simultaneous requests with the same email both pass
the app-level pre-check, but only one wins the database unique constraint. The
loser hits Prisma error `P2002`, which we map to the same 409 â€” the app-level
check is an optimisation, the database constraint is the guarantee.

## 3. Login flow

```
Client
  â†’ POST /api/auth/login { email, password }
  â†’ auth.router â†’ auth.controller.login
      â†’ auth.validation        (400 on missing fields)
      â†’ auth.service.login
          â†’ find user by email (single query, no existence probe)
          â†’ bcrypt.compare(password, passwordHash)   constant work either way
          â†’ sign JWT { sub: userId, role }           HS256, 15m expiry, iss=ecommerce-platform
      â†’ 200 { token, user: { id, name, email, role } }
```

**One deliberate anti-enumeration decision:** both "no such user" and "wrong
password" return the identical `401 Invalid email or password`. The response
body and timing are the same, so a scraper cannot use the API to probe which
emails are registered.

## 4. Request flow through the layers

Public requests (e.g. register / login):

```
Client
  â†’ Route (auth.router: path + HTTP method match)
  â†’ Validation (auth.validation: shape & rules on the body)
  â†’ Controller (auth.controller: reads body, calls service, shapes response)
  â†’ Service (auth.service: business rules, hashing, transactions)
  â†’ Prisma Client (typed queries)
  â†’ MySQL (stores / reads rows)
```

Protected requests (e.g. GET /api/auth/me):

```
Client
  â†’ Authentication middleware (requireAuth: verifies JWT, attaches req.auth)
  â†’ Controller (auth.controller: uses req.auth.user)
  â†’ Service (auth.service: business logic)
  â†’ Database (fresh user row)
```

Why separate them? Each layer is independently testable and replaceable; the
codebase shows a consistent seam (e.g. a future email service or an API-layer
rate limit slots in without touching business rules).

## 5. JWT (stateless) authentication flow

```
Client                                   Server
  â”‚  Authorization: Bearer <token>
  â–¼
  requireAuth middleware (src/middleware/requireAuth.ts)
  â”‚  1. header present & starts with "Bearer "?        else 401
  â”‚  2. jwt.verify(token, SECRET, { issuer })          else 401 (invalid/expired/tampered)
  â”‚  3. load user by payload.sub (fresh row)           else 401 (deleted user)
  â–¼
  req.auth = { user, tokenPayload, token }  â†’ controller â†’ service
```

Everything downstream reads `req.auth.user` â€” no controller ever parses a
token. The token is verified for **signature**, **expiry** and **issuer**;
role from the token is treated as advisory, the fresh database row is what the
controller trusts.

Why load the user on every request? Fresh role/name, immediate reaction to
deleted users, and the database remains the single source of truth. Trade-off:
one indexed `SELECT` per request â€” negligible at this scale, and it is exactly
the cost we would avoid later by caching user lookups (Redis is a *later*
stage, when this query actually shows up in profiling).

## 6. Why the password is hashed (not encrypted)

- **Encryption is reversible** â€” with the key you can decrypt the password.
- **Hashing is one-way** â€” there is no key, no decryption, no way to recover
  the original password from the hash.
- bcrypt is a *slow, salted* hash: it is deliberately expensive (~10â€“100ms) so
  brute-forcing one recovered hash is impractical. The `$2b$12$` prefix means
  cost factor 12 (2Â¹Â² rounds). Each hash embeds a random salt, so identical
  passwords produce different hashes.
- If the users table ever leaks, what leaks is useless against bcrypt at this
  cost â€” the industry's standard outcome for the same incident.

## 7. Why User + Cart creation is a single transaction

Invariant: **every registered user has exactly one cart, and every cart has
exactly one owner.**

```
prisma.$transaction(async (tx) => {
  const user = await tx.user.create(...)    -- BEGIN
  await tx.cart.create(...)                  -- INSERT user
  return user;                               -- INSERT cart
})                                           -- COMMIT
```

What a database transaction guarantees (ACID):

- **Atomicity** â€” the set of statements is all-or-nothing.
- **Consistency** â€” the database is never observed in the "half-done" state.
- **Isolation** â€” concurrent transactions cannot see another transaction's
  uncommitted rows.
- **Durability** â€” once committed, the data survives a crash.

What happens when the cart insert fails after the user insert succeeded:

```
BEGIN
INSERT users ...            -- okay so far
INSERT carts ...            -- ERROR (e.g. FK violation)
ROLLBACK                    -- the INSERT users is undone as well
END
COMMIT is never reached, so NO user row and NO cart row exist.
```

Prisma translates this into `BEGIN` / `COMMIT` / `ROLLBACK` on MySQL
(InnoDB). We verified this during Day 2: a forced failure between the two
inserts left zero rows behind.

Simpler alternative considered: two separate inserts (user, then cart). It
works "most of the time" but can leave orphan users if the second insert
fails or the process dies between them, and it would silently violate the
one-user-one-cart invariant. The transaction removes the entire class of bugs
for the cost of one block of code â€” this is the *first* of several places the
project will rely on transactions (notably order creation in a later stage).

## 8. Key security decisions (and their trade-offs)

| Decision                                    | Why                                                        | Trade-off                                   |
| ------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| bcrypt (bcryptjs) with cost factor 12       | slow+salted one-way hashing; pure-JS (no native compile)   | ~100ms per hash: fine for login/register   |
| JWT (HS256) instead of server sessions      | stateless auth â€” no session table, works across instances  | a compromised secret compromises all tokens (mitigated by short expiry) |
| JWT payload kept minimal (sub, role)        | no email/hash/PII in tokens (tokens are base64, not secret)| role decisions still re-read from DB       |
| Short token lifetime (15m default)          | limits window for stolen-token abuse                        | client must re-login for long sessions (refresh tokens are a *later* decision) |
| requireAuth loads the user row per request  | fresh data, deleted users rejected immediately              | one indexed query per protected request     |
| Same 401 for unknown-email vs wrong-password | prevents account enumeration through the API              | operator debugging is slightly harder      |
| Secrets via env, never in code, `.env` git-ignored | no creds in repos                                  | requires a real secret in every environment |
| Fail-fast config (missing/short JWT_SECRET) | misconfiguration surfaces at boot, not at first login      | none                                      |

## 9. What we intentionally have NOT implemented yet

- âŒ Refresh tokens / token rotation â€” not needed until long-lived sessions.
- âŒ OAuth / third-party login (Google, GitHub, ...) â€” not in project scope.
- âŒ Password reset ("forgot password") â€” needs email delivery; not in scope.
- âŒ Email verification on registration â€” not in scope.
- âŒ Rate limiting on `/login` (brute-force protection) â€” planned for the
  infrastructure stage (it is a *Redis* problem, but Redis is not introduced
  until it earns its place).
- âŒ Session revocation / token blacklist â€” a stateless-JWT trade-off we
  accept; refresh tokens/blacklists revisit this later.
- âŒ Account lockout / security-question flows â€” out of scope for a portfolio
  monolith.
- âŒ HTTPS enforcement, cookie settings â€” these are deployment concerns, handled
  when we introduce Docker/CI.