# database/

This folder documents the **database design** of the project.

## Source of truth

The authoritative schema lives with the codebase that owns it, in Prisma format:

- **Schema (source of truth):** [`../backend/prisma/schema.prisma`](../backend/prisma/schema.prisma)
- **Migrations (applied history):** [`../backend/prisma/migrations/`](../backend/prisma/migrations/)

Each migration is a plain SQL file reviewed before it is applied to any
database. The full generated DDL for the initial migration is shown in
[`init-migration.sql`](./init-migration.sql) for quick reference.

## Why migrations live in the backend folder

Prisma (`prisma migrate dev`) requires the schema and the migrations folder to
be co-located with the code that consumes the generated client. Keeping them
in `backend/prisma/` means one workflow and one version for code + schema +
migrations. This folder exists so the schema can also be documented and
reviewed independently (e.g. by interviewers or in code review).

## Managed vs. unmanaged approaches

- While the schema is young and fast-moving, **Prisma Migrate** is the workflow:
  edit `schema.prisma` -> `prisma migrate dev` -> review the generated SQL.
- At the point the schema stabilises (or when multiple services must share it),
  we can freeze deployments and hand ownership of `migrations/` to a dedicated
  migration runtime (e.g. `prisma migrate deploy`) or a tool like Flyway.