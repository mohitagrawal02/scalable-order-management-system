# Kafka Architecture & Integration (Day 7)

This document describes the Day 7 event-driven layer: a transactional outbox in MySQL, at-least-once delivery over Kafka, consumer idempotency, dead-letter queues, and the health surface. The system remains a **modular monolith** — one codebase, one deployable — with Kafka used for asynchronous side effects only.

---

## 1. Overview & Motivation

Day 5 had a straightforward flow: the payment transaction wrote the payment, the order state, **and** the notification. It was correct, and it had a hard ceiling:

1. **Every side effect joins the critical path.** A notification (later: email, webhooks, analytics, search indexing, fraud scoring) means more work inside the transaction that the customer is waiting for. Slow side effects become slow payments.
2. **Two writes, no coordination.** The naive event-driven fix — commit, then publish — writes to two independent systems with nothing tying them together. The gap fails in both directions: money is taken but the event is lost (nobody is ever told), or the event is published and the transaction then rolls back (consumers react to work that never happened). Reordering the two lines only moves the window; it cannot close it.
3. **Adding a consumer means editing the producer.** Notifications, emails and analytics all lived in the payment service, so every new reaction was a change to the module that owns money.

Kafka solves (1) and (3): side effects become separate processes reacting to an append-only log. The **transactional outbox** solves (2).

What Kafka deliberately does **not** do here:

- It is **never on the request path.** Handlers write an outbox row; publishing is fire-and-forget.
- It does **not** make this a microservices architecture. Same repo, same process for the API; the worker is a second entrypoint into the same modules.
- Its status **never** changes `GET /api/health`'s overall `status` (same rule as Redis in Day 6). An event broker outage degrades asynchronous work, not request serving.

### The shape of the flow

```
POST /api/orders/:id/payments
        │
        ▼
┌───────────────────────────────────────────┐
│ ONE MySQL TRANSACTION                     │
│   payment  → SUCCEEDED / FAILED            │
│   order    → PAID / PENDING                │
│   outbox_events → INSERT (status PENDING)  │  ← the event, committed with the change
└───────────────────────────────────────────┘
        │ commit
        ▼
  scheduleOutboxDispatch()   ← fire-and-forget, never awaited by the request
        │
        ▼
   dispatcher ── publish (acks=-1) ──► MySQL: PENDING → PUBLISHED
        │                                    (or DEAD after maxAttempts)
        ▼
   Kafka topic: order.events / payment.events
        │
        ▼
   worker consumer group `notification-service`
        │  ONE transaction: INSERT processed_events + INSERT notification
        ▼
   notifications row  (duplicates are no-ops)
```

---

## 2. Setup

There is no Docker on this machine, so the broker is a portable local KRaft install (no ZooKeeper) under `%USERPROFILE%\kafka-local`, driven by a PowerShell wrapper:

```powershell
# from the repo root
.\infra\kafka\kafka.ps1 -Action start     # format once, launch broker, wait for :9092
.\infra\kafka\kafka.ps1 -Action status
.\infra\kafka\kafka.ps1 -Action topics     # list topics (needs a running broker)
.\infra\kafka\kafka.ps1 -Action consume    # tail a topic
.\infra\kafka\kafka.ps1 -Action stop
```

The same commands are exposed from `backend/` as `npm run kafka:start | kafka:status | kafka:topics | kafka:stop`.

Startup order for a full local run:

1. MySQL
2. `npm run kafka:start`
3. `npm run dev` (API)
4. `npm run worker` (consumer + its own outbox dispatcher)

### Windows gotchas worth remembering

- **Kafka's own `.bat` wrappers fail with "input line is too long."** They build a classpath of ~120 jars, which exceeds the Windows command-line limit. `kafka.ps1` sidesteps this by invoking `java -cp "libs\*"` directly with the main class (`kafka.Kafka`, `org.apache.kafka.tools.TopicCommand`, …).
- **log4j's `${kafka.logs.dir}` must be a plain path.** The stock `.sh` wrappers export it; the `.bat` ones assume it. Passing a `file:` URL instead of a directory path breaks the substitution and corrupts the log filename.
- **`auto.create.topics.enable=false`.** Topics are declared in code (`src/infrastructure/kafka/topics.ts`) and created by `ensureTopics()` on boot of the API and the worker, so a typo in a topic name is a bug rather than a silently-empty topic.

### Configuration

All variables, with comments, are in `backend/.env.example`. The important one:

```bash
KAFKA_ENABLED=true    # false = producer, dispatcher and consumers are off entirely
```

`KAFKA_ENABLED=false` is a real escape hatch, not a documentation-only flag: with it set, the dispatcher will not even open a socket, so the API runs with no broker at all and events simply accumulate in the outbox.

---


## 3. Why these topics (and only these three)

A topic is not "a queue per operation". It is a partitioned, retained, replayable log, and the useful axis to split it on is **who consumes it and how** — not one topic per event name.

| Topic | Partitions | Retention | Consumed by | Why |
|---|---|---|---|---|
| `order.events` | 3 | 7 days | `notification-service` | Order lifecycle facts (`OrderPaid`). |
| `payment.events` | 3 | 7 days | `notification-service` | Payment lifecycle facts (`PaymentFailed`). |
| `notification-service.dlq` | 1 | 30 days | *nobody* | Everything that consumer gave up on. |

- **Three partitions, not more.** Enough to show that ordering is *per key*, not global (§3.1), without pretending there is parallelism this workload needs.
- **One partition for the DLQ.** Dead letters are low volume and must stay in the order they failed so they can be replayed by hand in sequence.
- **Retention on the DLQ is longer than the source.** A poison message is a bug report; bug reports are useless if they expire before anyone looks.
- **The DLQ is named after the consumer group, not the source topic.** "This consumer gave up" is different information from "this topic is bad" — two consumer groups reading `order.events` can have completely different failure modes.
- **Exactly two domain events** (`OrderPaid`, `PaymentFailed`). Adding `OrderCreated`, `CartAbandoned` and friends before anything consumes them would be speculative plumbing.

### 3.1 The partition key is the ORDER, not the payment

Kafka only guarantees order within a partition, and the partition is derived from the message key. So the key must be *the thing whose events must never be reordered relative to each other* — which, for notifications, is the order.

```
key = `order-<orderId>`            for BOTH OrderPaid and PaymentFailed
```

One order can produce `PaymentFailed` (attempt 1) and later `OrderPaid` (attempt 2). If those landed on different partitions a user could be told "payment succeeded" before "payment failed".

Note that `key ≠ aggregateId`:

| | `OrderPaid` | `PaymentFailed` |
|---|---|---|
| `aggregateType` / `aggregateId` | `Order` / `42` | `Payment` / `1043` |
| `partitionKey` (the Kafka key) | `order-42` | `order-42` |

The aggregate describes *what the event is about*; the key describes *what must be ordered*. Conflating the two is a classic Kafka bug.

---

## 4. What must never go in an event

Kafka messages are bytes in a log that several consumer groups can read, that survives for days, and that can be replayed by anyone with broker access. **A topic is not a secure channel**, and "we deleted it" is a promise, not a click.

Therefore every payload carries **internal numeric ids only**:

| Never in an event | Why | What goes instead |
|---|---|---|
| Email addresses | Identity leak for the whole retention window | `userId` |
| Names, phone numbers, addresses | Same — and useless for machine consumers | `userId` |
| Passwords or password hashes | Catastrophic, and never needed by a consumer | — |
| JWTs / session tokens | Live credentials in an append-only log | — |
| API keys, card numbers, CVC | Regulatory + security exposure | `paymentId` |

The consumer that needs the email already has MySQL: it looks up `userId` when it actually writes the notification. Events are *facts about what happened*, addressed by id — they are not a data export.

The same rule governs the **envelope** (`src/infrastructure/kafka/envelope.ts`). It carries routing and tracing metadata only:

```
eventId        unique id of this fact — tracing AND consumer deduplication
eventType      what happened, in domain language ("OrderPaid")
eventVersion   schema version: additive = stay at v1, breaking = ship v2
occurredAt     when the FACT happened (ISO-8601 UTC) — not the broker's append time
aggregateType  which kind of thing this is about (Order / Payment)
aggregateId    which instance
partitionKey   what must stay ordered (NOT the same as aggregateId)
correlationId  ties together everything caused by one user action
producer       which module emitted it
payload        the domain fact itself
```

`occurredAt` matters on replay: re-reading a log months later must not make old events look new, and late arrival must be detectable.

The envelope is duplicated into Kafka **headers** as well as the message body. Headers let an operator triage a DLQ at 3am with tooling that never deserializes the payload.

---
## 5. Consumer idempotency

Kafka gives **at-least-once** delivery. Not at-most-once (that loses events), not exactly-once (that is a much larger promise than most systems can honestly make). At-least-once means this consumer *will* be called twice for some events: after a rebalance, after a crash between "handler succeeded" and "offset committed", or because the outbox republished a row whose ack was lost.

The handler therefore has to make the second delivery a no-op. `handleDomainEvent` does it with a **dedup marker in the same transaction as the work**:

```
BEGIN;
  INSERT INTO processed_events (consumer_group, event_id, ...)   ← may fail
  INSERT INTO notifications (...)                                 ← only if it didn't
COMMIT;
```

- `processed_events` has `UNIQUE (consumer_group, event_id)`.
- The second delivery fails on the first INSERT → the transaction touches nothing → the whole thing is a no-op, logged at info level as `duplicate ignored`.
- The **marker lives in MySQL, not in memory**, so it survives a worker restart and works when several workers share the group.
- The **marker is inside the same transaction**, so a crash between "marked done" and "notified" cannot happen: the transaction rolls back and the event is redelivered — correct, since nothing was actually done.

Why not "check if it exists, then insert"? Because that is a check-then-act race two concurrent consumers can both win. The unique constraint cannot be raced.

The marker is keyed by `(consumer_group, event_id)` rather than `event_id` alone: two different consumers are *supposed* to both react to the same event once each.

### Retries, poison messages and the DLQ

`consumer.ts` retries a failing message `KAFKA_CONSUMER_MAX_ATTEMPTS` times (default 3) with a short backoff, then publishes it to the DLQ and commits the offset.

Two failure classes are handled differently:

- **Transient** (database blip, lock timeout) → retry, then DLQ. Retrying is the right thing; the budget stops it running forever.
- **Permanent** (`PermanentEventError`) → **immediate DLQ, no retries**. A payload missing a required field, or an event type no handler knows about, is a producer/consumer schema disagreement. Retrying cannot fix it, and spending three attempts to discover that wastes the budget while a poison message holds up its partition.

The DLQ record keeps everything needed to replay after a fix: the original bytes (`rawValue`), the parsed envelope when there was one, the original topic/partition/offset/key, the consumer group, the attempt count, the error, and a timestamp. A DLQ without diagnostics is a graveyard; with them it is a work queue.

---

## 6. The transactional outbox

### The dual-write problem

```
await prisma.$transaction(...)   // payment SUCCEEDED, order PAID
await producer.send(...)         // publish OrderPaid
```

Two independent systems, nothing coordinating them:

- **(a) commit succeeds, publish fails** (broker down, pod killed, network) → money is taken and the user is never told. The event is lost forever, because nothing recorded the intent to send it.
- **(b) publish first, then the transaction rolls back** → consumers react to an order that was never paid. The "fix" is to un-consume an event, which Kafka cannot do.

A `try/catch` with retries does not help: there is no state to retry *from*. Reordering the lines only moves the window.

### The fix: the event is just another row

```
await prisma.$transaction(async (tx) => {
  ...payment → SUCCEEDED, order → PAID...
  await enqueueOutboxEvent(tx, buildOrderPaidEvent(...));
});
// only now, best-effort, does anything talk to Kafka
```

One transaction = one atomic unit. There is no state in which "the payment happened but no event exists": either both are committed or neither. MySQL and Kafka are then eventually consistent, and `outbox_events` is the durable log of the gap between them.

`enqueueOutboxEvent(tx, …)` takes the transaction client as a **required** argument on purpose — an outbox row written on a different connection would not be atomic with the business change, which is the entire point.

### The dispatcher: publish first, mark second

```
publish  →  broker acks (acks=-1)  →  UPDATE status = PUBLISHED
```

The order matters. Marking first would make "published" a claim rather than a fact, and a crash in between would lose the event silently — the exact failure the outbox exists to prevent.

- On failure the row stays `PENDING`, with `attempts` and `last_error` recorded, and the next round retries it.
- After `KAFKA_OUTBOX_MAX_ATTEMPTS` (default **10**, much larger than the consumer's 3 because a broker outage is expected and recoverable) the row is parked as **`DEAD`**. Parked, not deleted: a DEAD row is evidence, it is surfaced on `/api/health`, and it is never retried automatically — that is what makes it visible.
- A crash between "broker accepted it" and "we marked it published" **republishes** on the next round. That duplicate is expected and absorbed by consumer idempotency (§5). The alternative (mark first) loses events.

**No claim/lock is taken before publishing.** A row is only marked PUBLISHED after the ack, so two dispatchers — the API and the worker both run one — can publish the same row concurrently, producing exactly the duplicate that idempotent consumers already have to handle. Claiming rows first would need lease expiry and a recovery path for crashed claimants, and would *still* not remove the duplicate risk. The simple, obviously-correct version wins.

### Dispatch is not awaited

```ts
scheduleOutboxDispatch()   // void — fire and forget
```

The HTTP response must never wait on the broker. If this round is skipped or fails, the background dispatcher (one timer per process, `KAFKA_OUTBOX_DISPATCH_INTERVAL_MS`, default 2s) still delivers the event — **that timer, not the fire-and-forget call, is what makes delivery reliable.**

Running two dispatchers (API + worker) is safe by design for the reason above; no coordination is required.

---

## 7. What happens when Kafka is down

Same rule as Day 6's Redis, for the same structural reason: the API only *produces*, and a producer that cannot reach the broker still serves every request.

| Layer | Behaviour when the broker is unreachable |
|---|---|
| **Producer** | Never throws into the caller. Returns `{ published: false, error }`. Configured `acks:-1`, `idempotent:true`, `maxInFlightRequests:1`, `allowAutoTopicCreation:false`. |
| **Payment request** | Unaffected. The outbox row was committed before anything touched Kafka. `scheduleOutboxDispatch()` is fire-and-forget. |
| **Outbox** | Rows stay `PENDING`, `attempts`/`last_error` grow, the dispatcher retries every 2s. The backlog is the broker's problem, stored durably. |
| **Consumers** | Nothing to consume. They reconnect with backoff. |
| **`GET /api/health`** | `kafka.status: "down"`, `impact: "..."` — and overall `status` stays `"ok"`. |
| **Recovery** | The moment the broker returns, the next dispatch round drains the backlog. `pendingEvents` on the health endpoint is the honest measure of how far behind things are. |

Kafka is therefore **optional infrastructure with working defaults**, exactly like Redis: `KAFKA_BROKERS` has a local default, and Kafka is never part of the "required variables" check.

Two numbers on `/api/health` are worth watching:

```
kafka.pendingEvents   committed events not yet accepted by the broker
                      flat near 0 = healthy, growing = broker/consumer struggling
kafka.deadEvents      rows that exhausted their retry budget — should be 0
```

`kafka.status` itself is reported but never decides the overall status.

---

## 8. Test strategy

The Day-7 suites are split so that the default `npm test` needs **no broker**:

| Suite | Needs a broker | What it proves |
|---|---|---|
| `outbox.test.ts` | No | Atomicity (rollback discards the row), PENDING→PUBLISHED, failure→PENDING+`last_error`, DEAD after budget, consumer idempotency, `PermanentEventError`, envelope round-trip, key/aggregate separation, health backlog. |
| `payments.test.ts` | No | Day-5 flows, updated: the payment enqueues an outbox event and **does not** notify synchronously; the worker's two stages are then driven in-process. |
| `kafka.test.ts` | **Yes** | Real topic metadata, producer→consumer round trip, DLQ of a malformed message, outbox→real broker→`PUBLISHED`, health reports `up`. |

Two seams in the production code make the broker-free suites possible, and they are real seams rather than mocks:

- `dispatchOutbox({ publisher })` accepts an injected transport (`Publisher` is a one-method interface declared in `producer.ts` for exactly this). `RecordingPublisher` in `tests/integration/helpers.ts` records what would have been sent, and can be told to fail.
- `handleDomainEvent` is exported from `notification.consumer.ts` so tests exercise the identical code path the worker uses.

`kafka.test.ts` calls `requireKafka()` in `before()` — a broker outage **fails** those tests loudly instead of skipping them, the same contract as `requireRedis()` in the Day-6 suites.

One deliberate detail: the live round-trip test publishes to `notification-service.dlq` rather than `order.events`. That topic is declared `consumedBy: null`, so no real consumer is reading it and the test cannot race (or be corrupted by) a running notification worker.

---

---

## 9. Code map

```
infra/kafka/
  kraft-server.properties          # KRaft (no ZooKeeper) broker template
  kafka.ps1                        # setup | start | stop | status | topics | consume | reset

backend/src/infrastructure/kafka/
  topics.ts                        # the published topic catalogue + partitions/retention
  envelope.ts                      # EventEnvelope: shape, runtime guard, parsing, headers
  events.ts                        # OrderPaid / PaymentFailed payloads + partition key rule
  client.ts                        # broker connection, ensureTopics(), pingKafka()
  producer.ts                      # Publisher interface + kafkaPublisher (never throws)
  consumer.ts                      # at-least-once loop: manual commits, retries, DLQ
  outbox.ts                        # enqueueOutboxEvent(tx, ...) + the dispatcher
  index.ts                         # barrel - consumers import from here only

backend/src/modules/notifications/
  notification.consumer.ts         # handleDomainEvent: idempotent notification write
  notification.service.ts          # the (unchanged) row writers, still tx-scoped

backend/src/worker.ts              # second entrypoint: dispatcher + consumer + shutdown
```

Two processes, one codebase:

| | API (`src/server.ts`) | Worker (`src/worker.ts`) |
|---|---|---|
| Serves HTTP | yes | no |
| Outbox dispatcher | yes (interval timer) | yes (interval timer) |
| Kafka consumers | no | yes |
| Required for correctness | yes | **no** - events wait if it is not running |

Both start their own dispatcher on purpose: duplicates between them are absorbed
by consumer idempotency, which is cheaper than the coordination it would take to
prevent them.

