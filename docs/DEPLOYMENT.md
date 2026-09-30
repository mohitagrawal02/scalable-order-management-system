# Deployment: containers, the local stack, and CI

*Added on Day 9. Companion files: [`../backend/Dockerfile`](../backend/Dockerfile),
[`../docker-compose.yml`](../docker-compose.yml),
[`../.github/workflows/ci.yml`](../.github/workflows/ci.yml).*

## 1. What this day added

| File | What it is |
| --- | --- |
| `backend/Dockerfile` | One multi-stage build with two output targets: `runtime` (the deployed image) and `migrate` (a one-shot schema container) |
| `backend/.dockerignore` | Keeps `node_modules` and `.env` out of the build context - both are correctness issues, not tidiness |
| `docker-compose.yml` | MySQL + Redis + Kafka + a `migrate` step + `api` + `worker`, with healthchecks and startup ordering |
| `.env.example` | Compose's variable template. Only `JWT_SECRET` is mandatory |
| `.github/workflows/ci.yml` | Three jobs: type-check, the integration suite against real MySQL/Redis/Kafka, and an image build that boots the whole stack |

Nothing in the application code changed. That is the point: an image is a
packaging decision, and if packaging forces a code change, the packaging was
wrong.

## 2. The one mental model this whole day rests on

A container is **not** a lightweight VM. It is a normal Linux process with its
filesystem replaced - which means:

- **Signals still have to reach it.** Day 8 built a shutdown sequence that runs on
  `SIGTERM`. If PID 1 is `node`, `SIGTERM` is *ignored by default*, and every
  deploy, restart and scale-down ends in `SIGKILL` 10 seconds later. Hence `tini`.
- **The shutdown budget is a race with the platform.** `SHUTDOWN_TIMEOUT_MS=10000`
  must be smaller than `stop_grace_period: 15s` (and in Kubernetes, smaller than
  `terminationGracePeriodSeconds`). When the platform wins, the process dies
  without running the steps *and without writing the log line that would have
  told you*, so the failure looks like "the logs just stopped".
- **`localhost` is not your laptop.** Inside a container it is the container.
  Every connection string uses service names (`mysql`, `redis`, `kafka`), which is
  why the `DATABASE_URL` in `backend/.env` (127.0.0.1:3307) and the one inside
  Compose are different strings on purpose.
- **The filesystem is an artifact, not a folder.** Anything not copied in does not
  exist at runtime - and anything copied in can never be deleted afterwards
  (layers are additive), so deletion must happen *inside the layer that created
  the files*.

## 3. Decisions and what they cost

| Decision | Why | What it costs |
| --- | --- | --- |
| Debian `bookworm-slim`, not alpine | Prisma's query engine is a native `.so`; the musl/glibc split is the most common Prisma-in-Docker failure | A few MB of base image |
| `prisma generate` inside the image | The engine binary is chosen per platform; a Windows-generated client in a Linux container fails on first query | The build needs network access to fetch engines |
| One image, two roles (`command:` in Compose) | Day 7's "one codebase, two process roles". The worker cannot drift from the API | The API's probe cannot live in the image (see §5) |
| `npm ci --omit=dev --ignore-scripts`, then delete the Prisma CLI | npm installs `@prisma/client`'s optional **peer** `prisma` even with `--omit=dev` (and `--omit=peer` does not remove it - both checked against this lockfile), so a "prod" install drags ~50 MB of CLI into every container | A `rm -rf` line that must be justified - CI booting the image is the justification |
| Migrations in their own container | Two app services racing to migrate is a failed deploy with extra steps | A service that exists only to exit |
| `NODE_ENV=production` in the dev stack | `config/index.ts` only switches its guard rails on in production, so the container boot is the only local test of them | You must supply a real `JWT_SECRET` and `CORS_ORIGINS` even to poke at it locally |
## 4. The image

```
deps ──► build ──► runtime   (deployed)
  │        │
  └────────┴─────► migrate    (one-shot, `docker compose` runs it for you)
              ▲
prod-deps ────┘              (prod-only node_modules, copied into runtime)
```

Ordering inside the file is a cache decision, not a style one: the two package
manifests are copied and installed **first**, so editing a handler re-runs `tsc`
and nothing else. `npm ci` is by far the slowest step in the build.

Two assertions run at build time, because a broken image should fail a build and
not a deploy:

- `ls node_modules/.prisma/client` - the generated client and the platform's
  engine binary must exist (and the build log names them, so it is evidence and
  not hope);
- `node --check dist/server.js && node --check dist/worker.js` - both entrypoints
  parse.

The container runs as the `node` user (uid 1000) with root-owned, therefore
read-only, files. There is no `curl` in the image: the healthcheck uses Node's own
`fetch`, because a debug tool that every deployed byte carries is a bad trade.

**No `HEALTHCHECK` instruction.** The same bytes are also the worker, which opens
no port, so an image-level check would report every healthy worker as unhealthy.

## 5. The Compose file's interesting parts

`depends_on` alone means *"the container was created"*, which is worthless: a
MySQL container is "started" roughly two seconds before it can authenticate
anyone. So every edge uses a condition:

| Edge | Meaning |
| --- | --- |
| `mysql: service_healthy` | The TCP ping only goes green once the *real* server is up - the image's first-boot init server has networking disabled |
| `redis: service_healthy` | `redis-cli ping` fails until the socket answers and while an RDB loads |
| `kafka: service_healthy` | `kafka-broker-api-versions.sh` must get metadata back: listener bound, controller elected, advertised address resolvable |
| `migrate: service_completed_successfully` | The migrations applied with exit code 0, or nothing else is allowed to boot |

Two things worth remembering from this file:

1. **Kafka's advertised listeners.** A broker hands the client the *advertised*
   address, not the one the client dialled. It must therefore be reachable from
   the client's network: `kafka:9092` for containers on this network,
   `localhost:29092` for a host-run process. This is the failure that produces no
   error message at all - the connection succeeds, the metadata request is
   answered, and then everything hangs.
2. **`stop_grace_period: 15s` vs `SHUTDOWN_TIMEOUT_MS=10000`.** Read together or
   not at all. Our budget is what runs; Docker's timer is what kills.

The `worker` intentionally has **no healthcheck**. It opens nothing to probe, and
"the node process exists" would be false comfort. Its failure mode is already
loud: `src/worker.ts` exits 1 when the broker is unreachable, and
`restart: unless-stopped` turns that into a visible crash loop instead of a
silently idle consumer.

## 6. Where migrations belong

In Compose, `migrate` is a service that exists to exit. It is there because
"the migrations that ship with the code are applied by the code" is a property
worth having, and because the alternative - both app services migrating on boot -
is a race.

In a real deployment this moves out of the runtime stack and into the pipeline:
one step between "image pushed" and "pods rolled", so a failed migration stops
the release instead of corrupting a rolling update. When more than one service
shares this schema, that step becomes the only correct place for it.

## 7. CI

| Job | Question it answers | Notable |
| --- | --- | --- |
| `static` | Is it typed, is the schema valid? | There is **no ESLint config in this repo**, so `tsc --noEmit` *is* the lint step. It is named in the job rather than pretended away |
| `integration-tests` | Do the tests pass against real MySQL, Redis and Kafka? | Kafka is a `docker run`, not a `services:` entry, because the address it advertises must be the client's address - and here the client runs on the runner host |
| `docker` | Does the image build, does the stack boot, does it serve traffic, does it stop politely? | `docker compose up --wait` blocks on the Compose healthchecks; a smoke test registers a user, logs in and reads the catalog |

The `docker` job is not decoration. **This project is developed on a machine with
no Docker installed**, so nothing between writing the Dockerfile and a deployment
would ever execute it. An untested Dockerfile is a broken Dockerfile that has not
been caught yet.

Two assertions in it are worth calling out:

- **Kafka readiness is proven before `npm test` runs.** `helpers.ts` *skips* the
  Kafka suite when no broker answers - correct behaviour on a laptop, and in CI it
  would turn a broken broker into a green checkmark.
- **`SIGTERM` must produce exit code 0.** `docker compose stop api` then
  `docker inspect` on the exit code. `0` means tini forwarded the signal, the named
  steps ran and the process chose to leave. `137` means Docker escalated to
  `SIGKILL`, i.e. the shutdown budget and the grace period fell out of agreement -
## 8. Running it yourself

```bash
copy .env.example .env        # then set JWT_SECRET (Windows) / cp on bash
docker compose up -d --build
docker compose ps             # api+worker healthy, kafka/mysql/redis healthy,
                              # migrate shown as exited (0) - that is success
curl http://localhost:4000/api/health/live
curl http://localhost:4000/api/health/ready
curl http://localhost:4000/api/metrics
docker compose logs -f worker # "ready" with the topic list, after connecting
docker compose stop api       # watch the named shutdown steps, then exit 0
docker compose down           # add -v to drop the MySQL and Kafka volumes too
```

Mixing a host-run process with the stack is supported and often the fastest way
to work on Day 10 code: leave `npm run dev` on the host and point it at the
containers -

```
DATABASE_URL=mysql://ecommerce_app:ecommerce_dev_only@127.0.0.1:3308/ecommerce_platform
REDIS_URL=redis://127.0.0.1:6380
KAFKA_BROKERS=localhost:29092
```

## 9. What was verified, and where

Being exact here matters more than looking complete.

| Claim | Evidence |
| --- | --- |
| Both YAML files parse, contain no tabs, and describe the services/dependencies/env intended | Parsed locally with PyYAML: 6 services, 2 volumes, merged env keys, identical `build:` blocks for api/worker, `depends_on` conditions as designed |
| The prod-only install does what the Dockerfile says, and the deleted CLI is not needed | Reproduced `npm ci --omit=dev --ignore-scripts` against this exact lockfile: `prisma` and `@prisma/engines` **were** installed by npm's peer resolution (and `--omit=peer` did not remove them), so they are deleted in-layer; after deletion `express, cors, helmet, ioredis, jsonwebtoken, kafkajs, bcryptjs, dotenv, @prisma/client` all load and `new PrismaClient()` constructs from the copied `.prisma` tree |
| The query engine lives inside the generated client | Found on disk at `node_modules/.prisma/client/query_engine-*.node` - which is why the runtime stage copies `.prisma` and not the CLI |
| `mysql:8.4`, `redis:7-alpine`, `apache/kafka:4.0.2` exist | Docker Hub tag API; the KRaft variable names come from Apache's own single-node example |
| `npm run build` produces both entrypoints | Ran it: `dist/server.js`, `dist/worker.js` |
| **The image builds, the stack boots, the probes pass, `SIGTERM` exits 0** | **Not verified on this machine - it has no Docker.** That is exactly what CI's `docker` job does on the first push; treat the first run of that job as the real acceptance test |

## 10. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `JWT_SECRET is required` before anything starts | No `.env` in this folder | `cp .env.example .env`, set a real secret |
| api exits with `CORS_ORIGINS must be set explicitly in production` | Production guard rail (`NODE_ENV=production` is deliberate here) | Set `CORS_ORIGINS` to the real origin list |
| api exits with `JWT_SECRET is still a placeholder value` | Same guard rails | Generate a secret; do not reuse `.env.example`'s |
| `port is already allocated` | Something local owns 3308/6380/4000/29092 | `MYSQL_HOST_PORT`, `REDIS_HOST_PORT`, `API_HOST_PORT`, `KAFKA_HOST_PORT` |
| mysql stays `starting` forever | First boot on a fresh volume is slow, or the retained volume was written by a newer server | `docker compose logs mysql`; if the volume is from a newer server, `docker compose down -v` |
| kafkajs connects, prints nothing, hangs | Advertised listener not reachable from the client's network | Containers use `kafka:9092`; host processes use `localhost:29092` |
| worker crash-loops with `cannot reach Kafka` | Broker unhealthy, or `kafka-data` holds a cluster formatted with different KRaft settings | `docker compose down -v` (delete the volume; do not hand-edit the metadata dir) |
| `Unknown query engine` / engine-not-found at runtime | A `node_modules` built for another platform got into the image | The `.dockerignore` prevents it; rebuild with `docker build --no-cache` if you edited it |
| `docker compose stop` ends in exit code 137 | `SHUTDOWN_TIMEOUT_MS` no longer fits inside `stop_grace_period` | Keep the budget < grace period, and let CI's exit-code assertion catch it first |

## 11. Next steps, in the order they would be worth doing

1. **Push the image** to a registry, tagged with the git SHA (never `latest`),
   from CI - and make the deploy reference that digest.
2. **Scan it**: `hadolint` on the Dockerfile in the `static` job, and a CVE scan
   (`docker scout` / `trivy`) in the `docker` job, failing on fixable highs.
3. **Cache the build** with `docker/build-push-action` + a layer cache in CI, so
   the `docker` job stays cheap as the repo grows.
4. **Give the worker a real liveness signal** - last consumer heartbeat and
   outbox backlog are already in `/api/metrics`; exposing a worker-scoped probe
   would let it have a healthcheck, and CI could assert on it as it does for the
   API.
5. **Day 10 adds a `frontend` service** here: build target, `depends_on: api`, and
   its origin added to `CORS_ORIGINS`.
6. **When a real platform appears** the translation is mechanical:
   `readinessProbe` → `/api/health/ready`, `livenessProbe` → `/api/health/live`, a
   `startupProbe` for slow boots, `preStop: sleep` +
   `terminationGracePeriodSeconds > SHUTDOWN_TIMEOUT_MS`, migrations as a Job or
   initContainer, and `JWT_SECRET`/`METRICS_TOKEN` from Secrets rather than env
   literals.
7. **Optional size work** with a real risk trade-off: `@prisma/client` ships ~40 MB
   of query-engine WASM for databases this project does not use. Deleting whole
   packages that the app provably cannot require (as done above) is one class of
   decision; deleting files *inside* a package is another, so it is left alone
   until image size is actually a problem.


