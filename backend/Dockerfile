# syntax=docker/dockerfile:1
# ============================================================================
# Backend image - the API and the worker from ONE build artifact
# ============================================================================
# Built by ../docker-compose.yml (the local stack) and by
# .github/workflows/ci.yml, which builds it AND boots it: a Dockerfile that no
# pipeline ever runs is a Dockerfile that is broken and does not know it yet.
#
# ONE IMAGE, TWO ROLES
#   Day 7 split the system into two processes (src/server.ts, src/worker.ts) but
#   deliberately kept ONE codebase. So there is one image, and the role is a
#   startup decision rather than a build decision: the API runs the default CMD,
#   the worker overrides `command:` in Compose. Same bytes, same build, same CVE
#   surface - which makes "works in the API image, breaks in the worker image"
#   unrepresentable.
#
# WHY THERE ARE FIVE STAGES
#   Building needs devDependencies (typescript, the prisma CLI, @types/*) that
#   must never ship: they are most of the image's weight and most of its
#   supply-chain surface. Each stage answers one question - "what has to exist
#   for this layer to be produced?" - and only the last two leave anything
#   behind in the image you deploy:
#     deps       full `npm ci`                   -> feeds build + migrate
#     build      `prisma generate` + `tsc`       -> dist/, node_modules/.prisma
#     prod-deps  `npm ci --omit=dev` + Prisma CLI removed -> the only node_modules
#                that ships
#     runtime    dist/ + prod node_modules       -> what gets deployed
#     migrate    prisma CLI + prisma/migrations  -> one-shot ops container
#
# TWO THINGS THAT ARE EASY TO GET WRONG, HENCE THE LENGTH OF THIS FILE
#   1. `prisma generate` runs INSIDE the image, never on a laptop. The query
#      engine is a NATIVE binary chosen per platform (linux-glibc vs musl vs
#      windows), so a client generated on Windows and copied into a Debian
#      container fails on the first query. Generating in `build` - which is FROM
#      the same base image as `runtime` - makes that class of bug unshippable.
#   2. The two `npm ci` calls live in DIFFERENT stages, therefore in different
#      layers. Installing everything and then `npm prune --omit=dev` in a later
#      RUN does NOT shrink the image: layers are additive, so pruning in its own
#      layer hides the dev tree instead of removing it.
# ============================================================================

# Overridable so CI can build the same file against a different Node, and so a
# base-image security patch is a one-line change.
ARG BASE_IMAGE=node:22-bookworm-slim

# ----------------------------------------------------------------------------
# base: the shared OS layer (bookworm-slim, not alpine)
# ----------------------------------------------------------------------------
# Debian slim rather than alpine on purpose: Prisma's query engine is a native
# .so, and the musl/glibc split is the most common "works on my machine"
# container failure with Prisma. Trading a few MB for not shipping that bug is
# the right direction for a project whose whole point is deliberate choices.
FROM ${BASE_IMAGE} AS base

# openssl          the Prisma query engine links against OpenSSL 3
# ca-certificates  TLS to managed MySQL, plus the engine download at build time
# tini             PID 1 that FORWARDS SIGTERM - see the ENTRYPOINT note below
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------------------------
# deps: every dependency, for building
# ----------------------------------------------------------------------------
# Only the two package manifests are copied first, so this layer is reused
# whenever source changes: `npm ci` is by far the slowest step in this file, and
# making it cacheable is what keeps CI minutes cheap.
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ----------------------------------------------------------------------------
# build: schema validation, codegen, compile
# ----------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY prisma ./prisma

# `prisma generate` also validates schema.prisma: a schema that cannot generate
# fails the BUILD, which is where a mistake belongs, instead of surfacing as a
# 500 on the first request of a deploy.
RUN npx prisma generate

# Source is copied AFTER the install + codegen layers, so editing a handler
# re-runs `tsc` and nothing else.
COPY src ./src
# `tsc` IS the type check: there is no ESLint config in this repo yet, so the
# compiler is the only gate between a type error and an image.
RUN npm run build

# ----------------------------------------------------------------------------
# prod-deps: the dependency tree that actually ships
# ----------------------------------------------------------------------------
FROM base AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=dev        no toolchain in a deployed image (see the header).
# --ignore-scripts  no install-time code from the dependency tree. Safe here
#                   because nothing in the production set compiles (express,
#                   ioredis, kafkajs, bcryptjs, jsonwebtoken are pure JS), and the
#                   one script that WOULD have run - @prisma/client's postinstall -
#                   does exactly what `build` does on purpose, whose output is
#                   copied in below. It also keeps the engine download out of this
#                   stage: the engine belongs to the generated client, not here.
#
# Then two whole packages are deleted, IN THE SAME LAYER, and that needs a
# paragraph, because it looks like a bug and is really an npm behaviour:
# @prisma/client declares the `prisma` CLI as an OPTIONAL PEER dependency, and
# npm 7+ installs peers even under --omit=dev - --omit=peer does not remove it
# either (both were verified against this exact lockfile). So the ~50MB CLI and
# its engine downloader survive a "production" install by default and ship to
# every container. The runtime image needs neither: `prisma generate` has already
# run in `build`, and the query engine binary lives inside the generated
# node_modules/.prisma/client that the runtime stage copies. CI's docker job boots
# this image and serves real traffic, which is what makes the deletion a checked
# claim instead of an assumption.
RUN npm ci --omit=dev --ignore-scripts \
 && rm -rf node_modules/prisma \
           node_modules/@prisma/engines \
           node_modules/@prisma/fetch-engine


# ----------------------------------------------------------------------------
# runtime: the deployed image
# ----------------------------------------------------------------------------
FROM base AS runtime

# NODE_ENV=production is not decoration here: config/index.ts reads it and turns
# on the production guard rails (explicit CORS allowlist required, placeholder
# JWT secrets refused, TRUST_PROXY=true refused). Booting the container is
# therefore also a test of those rails - see docs/RELIABILITY.md §4.
ENV NODE_ENV=production \
    PORT=4000

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
# The generated client AND the Linux query engine, produced in `build`, dropped
# into the production-only tree. This is why the runtime image never needs the
# prisma CLI - and why it can never receive a client generated for a platform
# other than the one it runs on.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Assert the artifact is what we think it is, at BUILD time:
#   - the generated client directory exists and is listed in the build log, so
#     the engine binary (libquery_engine-<platform>.so.node) is visible evidence
#     rather than a hope;
#   - the client module actually loads;
#   - BOTH entrypoints parse, so a truncated build fails here, not in prod.
RUN ls -1 node_modules/.prisma/client \
 && node -e "require('@prisma/client'); console.log('[build] prisma client resolves: ok')" \
 && node --check dist/server.js \
 && node --check dist/worker.js

# Run as the unprivileged user the official node image already provides (uid
# 1000). Files stay root-owned and therefore read-only to the process: a
# compromised app cannot rewrite its own code. The app writes nothing at runtime
# - Prisma connects over TCP, it does not need a writable schema file.
USER node

EXPOSE 4000

# tini as PID 1. This is not a hardening nicety, it is what makes Day 8 work:
# Node as PID 1 does not reap children and does not default-handle SIGTERM, so
# `docker stop` would skip the entire named-step shutdown sequence and end in
# SIGKILL 10s later. With tini the signal is forwarded, the steps run, and the
# process leaves with code 0 (CI asserts exactly that). Baked into the image so
# it is correct on Compose, on plain `docker run`, and on any orchestrator that
# is not configured with an equivalent init.
ENTRYPOINT ["tini", "--"]

# The API is the default role. The worker service in Compose overrides this with
# `command: ["node", "dist/worker.js"]` - same image, different job.
CMD ["node", "dist/server.js"]

# NO HEALTHCHECK IN THIS IMAGE, deliberately: the same bytes are also the
# worker, which opens no port at all, so an image-level check would report every
# healthy worker as unhealthy. Probes belong next to the thing they probe, so
# they live in docker-compose.yml (and in Kubernetes, on the api Deployment).

# ----------------------------------------------------------------------------
# migrate: the one-shot "make the schema match the code" container
# ----------------------------------------------------------------------------
# A separate target because migrations must run ONCE, before anything serves
# traffic - and the only way to guarantee "once" is to stop letting api and
# worker race each other to do it. It reuses `deps`' node_modules (the prisma
# CLI is a devDependency, so this target costs nothing extra to build), and
# Compose gates both app services on its exit code.
#
# `migrate deploy` replays the reviewed SQL in prisma/migrations in order. Never
# `migrate dev` in a container: it wants a shadow database, and its failure mode
# is asking to reset the schema.
FROM deps AS migrate
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY prisma ./prisma
USER node
ENTRYPOINT ["tini", "--"]
CMD ["npx", "prisma", "migrate", "deploy"]

