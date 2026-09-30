# Reliability & observability (Day 8)

Days 1-7 built a system that *behaves* correctly. Day 8 is about whether anyone
could tell: whether it is up, why it is not, what it is doing right now, and
whether stopping it for a deploy costs anybody a request.

Everything here came out of inspecting Day 7 for defects first. Four were real
and are documented in [§7](#7-defects-found-while-inspecting-day-7), because
"we added logging" is a much less useful note than "the retry budget was being
burned by the poll interval".

| Concern | Where | Why it exists |
| ------- | ----- | ------------- |
| Structured logs | `src/infrastructure/logging/` | a line you can query beats a line you can only read |
| Request ids | `src/middleware/requestContext.ts` | one id ties a client's bug report to every log line about it |
| HTTP metrics | `src/infrastructure/metrics/` | "is it slow / erroring / still draining?" without a debugger |
| Liveness / readiness | `/api/health/live`, `/api/health/ready` | restart-vs-route are different questions; conflating them causes outages |
| Operational counters | `GET /api/metrics` | cache, rate limiter, producer, outbox, consumer in one document |
| Graceful shutdown | `src/infrastructure/lifecycle/` | a deploy must be invisible to a client |

---

## 1. The three questions observability has to answer

1. **"Is it working?"** — for a machine, in a fixed format, cheaply. That is
   `/api/health/live` and `/api/health/ready` and nothing else, because a probe
   that needs a parser is a probe nobody wires up.
2. **"What is it doing?"** — `/api/metrics`: request counts, latency buckets per
   route, cache hit rate, outbox backlog, and the number that only a system with
   fail-open components needs: `security.rateLimit.degraded`.
3. **"What happened to *this* request?"** — the log, tied together by one
   `requestId` that the client is handed in `X-Request-ID`.

The ordering is deliberate: the first two prevent paging a human; the third is
what the human does once paged.

## 2. Structured logs

`src/infrastructure/logging/logger.ts` — ~200 lines, no dependencies.

**Why not pino/winston?** The requirement is "structured, correlatable logs",
which is a JSON line with a level, a message and some fields. A library would
buy transports, sampling and file rotation — none of which this project uses
(it writes to stdout, which is correct for anything container-managed later).
What it would *not* buy is the thing that mattered most here: a seam the test
suite could capture deterministically. `setLogSink()` is that seam, and it is
why `tests/integration/observability.test.ts` can assert on log *content*
instead of scraping stdout.

Every line:

```json
{"time":"2026-09-29T23:51:01.767Z","level":"error","message":"unhandled error",
 "service":"ecommerce-platform-backend","pid":31568,
 "requestId":"37c27b84-...","userId":383,"module":"http-error",
 "method":"POST","route":"/api/orders","path":"/api/orders","status":500,
 "error":{"name":"PrismaClientUnknownRequestError","message":"Check constraint ...",
          "code":"P2002","stack":"..."}}
```

- `time` is ISO-8601 UTC: sortable, no timezone arithmetic.
- `service` + `pid` tell the API's lines from the worker's in one stream.
- `error` is a *serialized* object (`name`/`message`/`code`, plus `stack` only
  outside production), never a raw Error interpolated into a string.
- Levels are ordered and filtered **before** anything is serialized, so a
  disabled `debug` call costs one comparison.
- Any field whose *key* looks sensitive (`pass`, `secret`, `token`, `auth`,
  `cookie`, `api_key`, `jwt`, `card`, `cvc`, `iban`, `ssn`) becomes
  `"[redacted]"` at any depth. This is a backstop, not a licence to log request
  bodies: the rule is still *log ids and outcomes, not payloads*. Strings are
  truncated at 512 chars, arrays at 20 items, nesting at depth 4 — a 10k-row
  result must not become a 10k-line entry.

**Levels are chosen per outcome, not per call site.** The access log is `info`
for 2xx/3xx, `warn` for 4xx, `error` for 5xx. A 4xx is not an application error
— it is a user retyping a password — and logging it as one buries the failures
## 3. Request ids and correlation

`requestContext()` is the **first** middleware in `createApp()`: it mints the id,
opens the log context, starts the latency timer and registers the completion
handler. Placed later, the requests you most want to see — the 404, the 429 from
the rate limiter, the 500 from the error handler — are exactly the ones missing
from your logs and your counters.

```
client ──X-Request-ID: trace-abc-12345678──▶ API   (reused: it matches [A-Za-z0-9._-]{8,64})
                                              │
      ┌──── logger adds requestId to every line written below here ────┐
      │ controller → service → Prisma / cache → outbox dispatcher       │
      └─────────────────────────────────────────────────────────────────┘
client ◀──────────────X-Request-ID: trace-abc-12345678──────────────────┘
```

**Why validate the incoming header instead of trusting it?** It arrives from
outside the process. A 10 KB value, control characters, or a value that changes
per request would poison every log line and any aggregation built on them.
`[A-Za-z0-9._-]{8,64}` bounds length and charset, which is the whole defence a
correlation id needs — it is never an authorisation value or a data key.

**`AsyncLocalStorage`, and what it is not.** The id reaches every module through
`node:async_hooks` (built in, no dependency), so `cache.ts` and `outbox.ts` log
`requestId` **without a single extra parameter**. Threading an id through
controller → service → Prisma → cache fails the moment a log line is written
somewhere that is not "in a handler" — which is precisely where the interesting
lines come from. Two things it is *not*:

- **not distributed tracing** — no span tree, nothing crosses a process boundary.
  The `correlationId` already carried on every event envelope (Day 7) is what
  links an API request to the worker that handled its event.
- **not a cache** — it holds small, non-secret identifiers, and the context is
  copied per request so a mutation in one branch cannot leak into a sibling.

The worker installs the same context per message (`eventId`, `correlationId`,
`consumerGroup`), so a notification's log lines are attributable to the event
that caused them — which is how "the worker created a duplicate" becomes a
two-minute query instead of an afternoon.

## 4. Metrics

`src/infrastructure/metrics/metrics.ts` + `GET /api/metrics`.

**Why in-process JSON and not Prometheus?** There is no scraper here, the rest of
the API speaks JSON, and the payload is meant to be read by a human or asserted
on by a test. The registry is a counter map plus a latency histogram, which
answers the questions actually asked. The shape is grouped by subsystem, so
converting it to an exposition format later is a translation, not a redesign.

**THE TRADE, STATED PLAINLY:** these numbers are **per process** and reset on
restart. Several API instances each keep their own; aggregating them across
instances is exactly the job Prometheus/Grafana would take on later. See
[§9](#9-known-limitations).

### Cardinality: the one way a metrics map becomes dangerous

`/api/products/1`, `/api/products/2`, … would allocate a series per product and
grow forever. Three defences, in order:

1. Labels are **route patterns** (`GET /api/products/:id`), from the route
   Express matched — never a raw URL.
2. Any remaining digit/UUID-looking segment is collapsed to `:id`. This is not
   belt-and-braces: Express reports `req.baseUrl` as the *concrete* prefix, so
   the payments router (mounted at `/api/orders/:orderId/payments`) arrives with
   `/api/orders/7/payments` in it. Without collapsing, one series per order.
3. A hard cap of 200 distinct route labels; past it everything folds into
   `other` and `routeCapReached` flips to true, so the leak is visible rather
   than silent.

Requests that match no route share one `unmatched` label, so URL-guessing shows
up as one fat series instead of thousands of thin ones.

**A second, uglier detail:** `req.baseUrl` is also *reset to `''`* while Express
5 unwinds the stack after an error — and the access log and the metric are
written after that, on `res.finish`. So the prefix is derived from the matched
pattern plus `originalUrl` when `baseUrl` is gone. Otherwise every error path
would be labelled `/`, i.e. exactly the requests worth labelling would be the
ones with no label. (Verified both ways in the tests.)

### What each counter is *for*

| Field | Question it answers |
| ----- | ------------------- |
| `http.requests.byStatusClass` | are we erroring, and since when? |
| `http.durationMs.buckets` | did the slow tail move? (cumulative, `le25` ⊇ `le10`) |
| `http.routes[]` | which endpoint, and is it 4xx-heavy (bad clients) or 5xx-heavy (us)? |
| `http.inFlight` | safe to restart now? nonzero mid-drain is normal, nonzero forever is not |
| `cache.hits/misses/errors` | is the cache paying for itself? `errors` climbing = Redis is sick |
| `security.rateLimit.degraded` | **security, not performance**: requests that were NOT limited because Redis was unreachable |
| `events.outbox.pending/dead` (via `/api/health`) | is the async side keeping up? `dead > 0` = a human must look |
| `events.consumer.retried/deadLettered` | is a consumer failing on real work? |

`degraded` deserves the emphasis: before Day 8 a Redis outage *silently* disabled
brute-force protection. The limiter failing open is a deliberate design choice
(§`REDIS.md`), but an intentional trade-off you cannot measure is the same as one
## 5. Liveness vs readiness

Three endpoints, three questions:

| Endpoint | Question | Fails when | Used by |
| -------- | -------- | ---------- | ------- |
| `GET /api/health` | "give me the full report a human would read" | MySQL is unreachable | humans, `curl`, the Day-1…7 tests |
| `GET /api/health/live` | "would **restarting** this process fix anything?" | never (it cannot fail while the loop runs) | orchestrator restart decisions |
| `GET /api/health/ready` | "can this instance serve a **correct** request right now?" | MySQL unreachable → `503` | load balancer / service routing |

### Liveness checks nothing, on purpose

This is the counter-intuitive part of Day 8, and getting it backwards is the
classic self-inflicted outage:

- If liveness probed MySQL, a 30-second failover would make **every** instance
  fail at once, the orchestrator would restart the whole fleet, and nothing
  could boot until the database came back. The health check would have become
  the outage.
- A process blocked on a slow dependency is not wedged: it is *waiting*. Readiness
  is what should stop traffic going to it; restarting it throws away in-flight
  work and changes nothing about the database.

What liveness *does* catch is the unrecoverable case — a wedged event loop stops
answering it too, and only a restart fixes that. So the handler is deliberately
the cheapest in the codebase: no `await`, no I/O, no allocations, and the test
asserts its response body contains **no** dependency fields, which is the
structural proof that it cannot be gated by one.

### Readiness: "without this, does a request fail?"

| Dependency | Gates readiness? | Why |
| ---------- | ---------------- | --- |
| MySQL | **yes** | the system of truth; every write and most reads need it, so the alternative is answering 500 |
| Redis | no | cache miss → read MySQL; rate limiter fails open. Removing instances turns a cache outage into an application outage |
| Kafka | no | producing never blocks a request, and unpublished events are durable in the outbox. Removing API instances would cascade a slow broker into an API outage **and** do nothing to drain the backlog |
| Outbox backlog | no (reported only) | a growing backlog calls for *consumer* capacity; removing API instances removes the processes still taking payments |

Same reasoning Day 6 and Day 7 already applied to `/api/health` — now expressed
in the one place a machine acts on it.

## 6. Graceful shutdown

`src/infrastructure/lifecycle/shutdown.ts`, wired by both `server.ts` and
`worker.ts`.

A process can die three ways and only one of them is a bug: SIGTERM (deploy /
scale-down), SIGINT (Ctrl+C), or a crash. This module handles the first two so
neither is visible to a client.

```
SIGTERM/SIGINT ─▶ installShutdownHandlers  (idempotent: a second signal is logged and ignored)
                    │
                    ├─ 1. stop-outbox-dispatcher      no NEW publishes started
                    ├─ 2. close-http-server           stop accepting; drain in-flight
                    ├─ 3. disconnect-producer         let publishes in flight finish
                    ├─ 4. close-kafka-admin
                    ├─ 5. close-redis                 cache/limiter stop; MySQL takes over
                    └─ 6. disconnect-prisma           LAST: everything above may need it
                    │
                 exit(exitCode)   ← 1 if any step failed
```

Three properties, each of which the Day-7 version lacked (see §7):

- **Ordered, named steps.** Background work first, traffic second, dependencies
  last. Stopping the dispatcher before the producer socket closes avoids a tick
  publishing into a closed client; closing the database last means nothing above
  still needs it.
- **A failure is recorded, not propagated.** If Redis refuses to close, every
  later close still runs and the process exits `1`. A dependency that will not
  close is exactly the moment you still want the others closed.
- **One watchdog, `unref`'d.** Because it holds nothing open, a clean shutdown
  exits the instant the last handle closes; the timer only fires when something
  is still holding the process open — and it logs **which step** was running.
  Silent `exit(1)` after a hard-coded 10 s is replaced by a named suspect.

### The keep-alive trap (found by testing, not by reading)

`server.close()` does not close existing connections, and its callback only fires
when *all* are gone. Every HTTP client keeps its connection open between
requests, so a bare `close()` waits for a socket that has no intention of
closing. `closeHttpServer()` therefore:

1. calls `closeIdleConnections()` immediately (idle = between requests, safe to
   drop — the client reconnects);
2. **keeps sweeping idle sockets every 25 ms during the drain** — a request that
   finishes 10 ms into a 5 s drain turns its connection idle *then*, and without
   the sweep the process still waits the full 5 s. This was observed in the test
   before it was fixed; it is the difference between a 200 ms deploy and one that
   consumes the whole termination budget;
3. after the drain window, `closeAllConnections()` destroys the rest. Those
   requests die rather than being answered — correct only *after* waiting, since
   the caller's own timeout has by then expired and the orchestrator's kill timer
   is next, and it will not leave a log line.

In-flight requests are answered, not cut off: the test starts a 80 ms request,
closes mid-flight, and asserts the client still gets its `200`.

### The worker's order, and why it is safe to stop mid-message

`stop-outbox-dispatcher → stop-notification-consumer → disconnect-producer →
sockets`. Offsets are **never committed in advance** (Day 7), so a shutdown — or
a SIGKILL that runs no handler at all — can lose *processing* but never an
event: the uncommitted message is redelivered, and `processed_events` makes the
redelivery a no-op.

## 7. Defects found while inspecting Day 7

Found by reading Day 7 looking for what would break in production, then confirmed
in the code before changing anything.

### 7.1 The outbox retry budget was burned by the poll interval (the real one)

Every dispatcher tick selected **all** PENDING rows and counted one attempt per
row per tick. With `KAFKA_OUTBOX_DISPATCH_INTERVAL_MS=2000` and
`KAFKA_OUTBOX_MAX_ATTEMPTS=10`, a row was parked as `DEAD` after **~20 seconds**
of broker unavailability — shorter than a broker restart. The setting read "wait
through an outage"; the code did the opposite: a routine 30 s blip dead-lettered
every queued event, i.e. every pending notification, permanently. `maxAttempts`
was a budget measured in *polls*, not in time.

Fix: a failed row now carries `next_attempt_at` and backs off
1 s → 2 s → 4 s … capped at 60 s (±25 % jitter), so the same 10-attempt budget
spans ~6 minutes of real backoff. Two details that matter:

- **the schedule lives in the database, not in memory.** A restart does not reset
  it, and the API and the worker sharing the table see the same one. (This is
  what the Day-8 migration adds: `next_attempt_at`.)
- **the dispatcher only selects eligible rows** (`next_attempt_at IS NULL OR <=
  NOW()`), so polling a deferred row costs nothing and changes nothing. The
  regression test runs three failing rounds and asserts `attempts` is still 1 —
  that assertion *is* the bug, written as a test.

Jitter is not decoration: without it, a broker that comes back is hit by the
entire backlog in the same tick.

### 7.2 Shutdown nested everything in one callback

Day 7's `server.ts` put every close inside `server.close()`'s callback with one
`setTimeout(() => process.exit(1), 10_000)` bolted on. Consequences, all real:

| Defect | Consequence | Now |
| ------ | ----------- | --- |
| one throwing step skipped all the rest | Prisma stayed connected **and the process exited 0** — an unclean shutdown reporting success | each step isolated; failure recorded, later steps still run, exit code 1 |
| `close()` may never call back (keep-alive, hung handler) | killed at 10 s with no idea which step was stuck | idle-socket sweep + drain window + watchdog that names the hung step |
| no drain budget for in-flight requests | whatever `close()` happened to wait for | explicit `SHUTDOWN_DRAIN_TIMEOUT_MS` |
| nothing observable | "did it shut down cleanly?" was guesswork | one timed log line per step, plus a summary |
| a second SIGTERM started a second shutdown | the same socket closed twice, the second throwing — looks like a new failure mid-deploy | idempotent: logged and ignored |

### 7.3 No fail-open counter

The rate limiter already failed open by design, but nothing recorded how often,
so a Redis outage silently switched brute-force protection off. Now
`security.rateLimit.degraded` counts it, with the timestamp of the last
occurrence.

### 7.4 `console.log` everywhere, with no correlation

Fourteen call sites interpolated fields into strings (`[cache] hit key="…"`),
which no log pipeline can group, and carried no request id, service name or
pid — including the fatal-error handlers, which printed a bare stack at the exact
moment context mattered most. All ~17 call sites across the cache, Redis client,
Kafka client, producer, consumer, outbox dispatcher, rate limiter, notification
consumer and both entrypoints now go through the structured logger, and
`installFatalErrorHandlers()` reports `uncaughtException` /
`unhandledRejection` as structured lines before exiting (continuing after an
uncaught exception means serving traffic from a process that may have
half-applied a transaction).

*(Verification, rather than a claim: `console.log|error|warn|info` across
`src/` now matches exactly two lines, both of which are text — a quoted
`node -e "console.log(...)"` example in the JWT error message inside
## 8. Running the failure drills

The suite is `npm test` (108 tests across 8 files, against real MySQL, Redis and
Kafka). Day 8's file is `tests/integration/observability.test.ts` — 20 tests,
most of which inject a failure rather than check a shape.

| Drill | What it asserts |
| ----- | --------------- |
| Redis disconnected under requests | `/live` and `/ready` both 200, `checks.redis.required = false`, login still answers `401` (not 500), `rateLimit.degraded` increments, probe recovers by itself |
| A shutdown step that throws | later steps still run, exit code 1, the failing step named |
| A step that never returns | the watchdog fires inside the budget and names it |
| Two SIGTERMs | one shutdown, one exit |
| A request in flight while closing | the client still gets its `200` |
| An idle keep-alive socket while closing | close returns in < 1 s, not after the drain |
| A request overrunning the drain | it is cut loose and the process still exits |
| A broker that will not accept publishes | the row stays PENDING with a *future* `next_attempt_at`; three more polls do not consume the budget |
| Two product ids measured | one metric series, and no label contains a raw id |
| A token in a query string | the key is logged, the value never is |

Manually, the same three failures are worth watching with your own eyes:

```powershell
# 1. Redis dies under live traffic: cache degrades, requests do not
npm run dev                # terminal 1
npm run worker             # terminal 2
while ($true) { curl -s http://localhost:4000/api/products | Out-Null; Start-Sleep -ms 300 }
# stop Redis → `cache ... error` lines appear, security.rateLimit.degraded > 0,
# /api/health/ready still says ready, /api/metrics counts the failures

# 2. Kafka dies under load: events queue, nothing is lost
.\infra\kafka\kafka.ps1 -Action stop      # pay for an order first
curl -s http://localhost:4000/api/health | ConvertFrom-Json | Select-Object -Expand kafka
# pendingEvents climbs, status stays "ok", deadEvents stays 0
.\infra\kafka\kafka.ps1 -Action start     # backlog drains by itself; the gaps between
                                          # attempts grow 1s, 2s, 4s apart

# 3. Shutdown under load: send a slow request, then Ctrl+C the API
# the response still completes; the log shows each named step and how long it took
```

## 9. Known limitations

Stated because an observability layer that oversells itself is worse than none.

- **Per-process, in-memory, reset on restart.** Two API instances report two
  sets of numbers, and a deploy erases history. Aggregating them means
  Prometheus or OpenTelemetry — deliberately not added here, since there is no
  scraper to feed and the Day-8 rule is observability without infrastructure
  complexity. The payload is grouped by subsystem so that migration is a
  translation, not a redesign.
- **No percentiles.** Buckets plus `avg` and `max` answer "did the tail move?"
  but cannot produce a real p99. A counted histogram with proper bucket
  boundaries is the first upgrade if this ever becomes Prometheus.
- **No distributed tracing.** `requestId` correlates everything inside one
  process; `correlationId` on the event envelope is the seam that crosses into
  the worker. There is no span tree, so nothing draws a latency waterfall.
- **Logs go to stdout only.** No rotation, sampling or shipping — correct while a
  supervisor owns that, insufficient on its own otherwise.
- **`/api/metrics` is open unless `METRICS_TOKEN` is set.** The comparison is
  constant-time (`timingSafeEqual`), which matters more here than it looks: the
  login limiter keys on a client-controlled `X-Forwarded-For`, so an attacker can
  buy time samples cheaply — a naive string compare would leak the token one byte
  at a time to anyone patient enough.
- **Metrics never gate anything.** Nothing here should flip a readiness decision
  by itself. A growing backlog or an elevated 4xx rate is a signal for a human,
  not an automated trigger.

## 10. Configuration reference (Day 8 additions)

| Variable | Default | Effect |
| -------- | ------- | ------ |
| `SERVICE_NAME` | `ecommerce-platform-backend` | `service` field on every log line |
| `LOG_LEVEL` | `debug` locally, `info` when deployed | `debug \| info \| warn \| error \| silent` |
| `METRICS_TOKEN` | unset (endpoint open) | requires `Authorization: Bearer …` on `/api/metrics` |
| `TRUST_PROXY` | `false` | proxy hops trusted for `req.ip`; `true` is **refused in production** |
| `CORS_ORIGINS` | `all` locally | allowlist elsewhere; `*` is refused in production |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | `5000` | how long in-flight requests get before connections are forced shut |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | whole-sequence budget; the watchdog names the step that blew it |
| `KAFKA_CONSUMER_RETRY_MAX_DELAY_MS` | `5000` | ceiling on consumer retry backoff |
| `KAFKA_OUTBOX_RETRY_BASE_DELAY_MS` | `1000` | first outbox retry delay (§7.1) |
| `KAFKA_OUTBOX_RETRY_MAX_DELAY_MS` | `60000` | outbox backoff ceiling |

Tests run at `LOG_LEVEL=error` (set in `tests/register.cjs`) because the access
log is one line per request and a suite that hits the API a hundred times would
otherwise print a hundred JSON lines per file. `LOG_LEVEL=debug npm test`
overrides it when you want to watch the cache and the outbox talk.