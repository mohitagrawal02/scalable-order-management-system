# backend/

Node.js + Express + TypeScript API for the e-commerce platform.

See the root [`../README.md`](../README.md) for the full project overview and
setup instructions. This file covers backend-specific details.

## What is here

```
backend/
├── prisma/
│   ├── schema.prisma         # source of truth for the database schema
│   └── migrations/           # applied SQL migrations (review before applying)
├── src/
│   ├── config/               # index.ts (env config) + prisma.ts (client singleton)
│   ├── errors/AppError.ts    # operational error with an HTTP status code
│   ├── middleware/           # 404 handler + global JSON error handler
│   ├── modules/              # feature modules; each owns route + controllers
│   │   └── health/           # GET /api/health (server liveness + DB ping)
│   ├── routes/index.ts       # apiRouter - mounts all feature modules
│   ├── app.ts                # createApp() express factory (no port binding)
│   └── server.ts             # entrypoint: listen + graceful shutdown
├── .env.example              # copy to .env and fill in
├── tsconfig.json             # strict settings, CommonJS output
└── package.json
```

## Module conventions

- A module = folder under `src/modules/<name>` containing a `*.router.ts`
  (creates an Express `Router`, wires controllers) and `*.controller.ts`
  (HTTP request handling).
- Routers are mounted on the api root router in `src/routes/index.ts`.
  For example, `apiRouter.use('/products', productsRouter)` will expose
  `GET /api/products/...`.

## Error handling contract

All handlers should throw or `next()` errors; Shape is:

```json
{ "error": { "status": 404, "message": "..." } }
```

- `AppError(message, statusCode)` — expected/operational errors.
- Anything else reaches the global handler and is logged as an internal error;
  clients only ever see `500 Internal server error`.

## Commands

```bash
npm run dev                # hot-reload development server (ts-node-dev)
npm run build              # tsc -> dist/
npm run start              # run the compiled build
npm run typecheck          # tsc --noEmit
npm run prisma:generate    # regenerate the Prisma client
npm run prisma:migrate     # prisma migrate dev (create + apply next migration)
npm run prisma:studio      # open Prisma Studio in the browser
```