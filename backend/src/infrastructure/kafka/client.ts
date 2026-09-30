import { Admin, Kafka, logLevel } from 'kafkajs';
import { config } from '../../config';
import { getLogger } from '../logging';
import { ALL_TOPICS, TOPIC_DEFINITIONS, type TopicName } from './topics';

/** Structured logger for this module (Day 8). */
const kafkaLogger = getLogger({ module: 'kafka' });

/**
 * Kafka client + lifecycle (Day 7).
 *
 * Same design rules as the Redis layer (docs/REDIS.md §2), for the same reason:
 * the broker is infrastructure that can be down, and it is NEVER allowed to
 * take the API down with it.
 *
 * 1. **MySQL is the system of record; Kafka is a delivery channel.** Business
 *    state is committed to MySQL first, always. Events are a consequence of
 *    that commit, never a precondition for it.
 * 2. **Nothing on the request path awaits Kafka.** Events go to the MySQL
 *    outbox inside the business transaction; a background dispatcher publishes
 *    them. So "Kafka is slow/down" delays a notification, never a payment.
 * 3. **Fail visibly, degrade quietly.** Every failure is logged with the topic
 *    and event id, and surfaces as outbox backlog on /api/health. Nothing
 *    throws into a request handler.
 *
 * KafkaJS itself is stateless with respect to connections: the `Kafka` object
 * is a factory, and each producer/consumer/admin holds its own socket. This
 * module owns the shared ADMIN client (topic provisioning + health probe) and
 * is the single place that knows the broker list.
 */

export const kafka = new Kafka({
  clientId: config.kafka.clientId,
  brokers: config.kafka.brokers,
  connectionTimeout: config.kafka.connectionTimeoutMs,
  requestTimeout: config.kafka.requestTimeoutMs,
  /**
   * KafkaJS's own logger is kept at ERROR: connection errors from a stopped
   * broker are genuinely useful in development, while INFO/DEBUG would drown
   * the application log in protocol chatter. Everything we care about
   * operationally is logged by our own infrastructure modules with a stable
   * `[kafka] ...` prefix instead.
   */
  logLevel: logLevel.ERROR,
});

/** Broker list, redacted for logs. Brokers are not secrets, but be consistent. */
export function brokerSummary(): string {
  return config.kafka.brokers.join(',');
}

let adminClient: Admin | undefined;
let adminConnect: Promise<Admin> | undefined;

/**
 * Lazily connects the shared admin client.
 *
 * Lazy + cache-a-reset-on-failure means a broker that starts later is picked up
 * without restarting the API, and a failed connect does not poison every future
 * call.
 */
async function getAdmin(): Promise<Admin> {
  if (adminClient) return adminClient;
  if (!adminConnect) {
    const admin = kafka.admin();
    adminConnect = admin
      .connect()
      .then(() => {
        adminClient = admin;
        return admin;
      })
      .catch((err: unknown) => {
        // Reset so the NEXT call tries again instead of reusing the failure.
        adminConnect = undefined;
        void admin.disconnect().catch(() => undefined);
        throw err;
      });
  }
  return adminConnect;
}

export interface TopicProvisionResult {
  created: string[];
  existing: string[];
}

/**
 * Creates any missing topic from TOPIC_DEFINITIONS. Idempotent, so it is safe
 * to call on every boot of both the API and the worker.
 *
 * WHY NOT RELY ON AUTO-CREATE
 * ---------------------------
 * `auto.create.topics.enable` would silently create a topic on first publish
 * with broker-default partitions and retention - a typo in a topic name would
 * quietly become a real topic that nobody reads. Declaring topics in code means
 * partitions/retention are reviewed, greet a fresh environment correctly, and
 * an unknown topic name is a bug (see TOPIC_DEFINITIONS).
 */
export async function ensureTopics(): Promise<TopicProvisionResult> {
  const admin = await getAdmin();
  const existing = await admin.listTopics();
  const missing = TOPIC_DEFINITIONS.filter((topic) => !existing.includes(topic.name));

  if (missing.length > 0) {
    await admin.createTopics({
      waitForLeaders: true,
      topics: missing.map((topic) => ({
        topic: topic.name,
        numPartitions: topic.partitions,
        replicationFactor: topic.replicationFactor,
        configEntries: [{ name: 'retention.ms', value: String(topic.retentionMs) }],
      })),
    });
  }

  const created = missing.map((m) => m.name);
  const present = ALL_TOPICS.filter((name) => !created.includes(name));
  kafkaLogger.info('topics ready', {
    brokers: brokerSummary(),
    created,
    existing: present,
  });
  return { created, existing: present };
}

/**
 * Health probe: one real round trip to the cluster.
 *
 * Never throws - health reporting must not fail because Kafka did.
 */
export async function pingKafka(): Promise<boolean> {
  try {
    const admin = await getAdmin();
    const cluster = await admin.describeCluster();
    return cluster.brokers.length > 0;
  } catch {
    return false;
  }
}

/** Number of partitions of one topic, or null when the topic is missing. */
export async function describeTopicPartitions(topic: TopicName): Promise<number | null> {
  try {
    const admin = await getAdmin();
    const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
    return metadata.topics[0]?.partitions.length ?? null;
  } catch {
    return null;
  }
}

/**
 * Graceful shutdown of the shared admin connection. Producers and consumers own
 * their own sockets and are closed by their own modules (disconnectProducer,
 * running consumer's stop()).
 */
export async function closeKafkaAdmin(): Promise<void> {
  const admin = adminClient;
  adminClient = undefined;
  adminConnect = undefined;
  if (!admin) return;
  try {
    await admin.disconnect();
  } catch {
    // Already gone - nothing to release.
  }
}
