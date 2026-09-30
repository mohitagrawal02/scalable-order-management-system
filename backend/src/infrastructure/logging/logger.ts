import { config } from '../../config';
import { getLogContext, type LogContext } from './context';

/**
 * Structured application logger (Day 8).
 *
 * WHY NOT PINO/WINSTON
 * --------------------
 * The requirement is "structured, correlatable logs from a Node service" - and
 * that is a JSON line with a level, a message and some fields. A dependency
 * would buy transports, sampling and file rotation, none of which this project
 * needs (it logs to stdout, which is the right answer for anything container-
 * or service-managed later). What it would NOT buy is the one thing that
 * matters here: a seam tests can capture deterministically. So the logger is
 * ~200 dependency-free lines, and `setLogSink()` is that seam.
 *
 * WHAT EVERY LINE CONTAINS
 * ------------------------
 *   time      ISO-8601 UTC - sortable, timezone-unambiguous
 *   level     debug | info | warn | error
 *   message   short, human-readable, stable enough to grep and alert on
 *   service   which deployable wrote it (api vs worker share this codebase)
 *   pid       which process, so two roles are distinguishable in one stream
 *   ...context  requestId / userId / route / eventId / correlationId, taken
 *               from the AsyncLocalStorage context so callers never pass them
 *   ...fields   call-site specifics (orderId, attempt, durationMs, ...)
 *   error     { name, message, code, stack? } - never a raw Error object
 *
 * WHAT IT REFUSES TO WRITE
 * ------------------------
 * Any field whose KEY looks sensitive (password, secret, token, authorization,
 * cookie, apiKey, card/cvc) is replaced with "[redacted]" at any depth before
 * the line is built. This is a backstop, not a licence to log request bodies:
 * the rule is still "log ids and outcomes, not payloads". Stack traces are only
 * included outside production.
 *
 * Levels are ordered, and a line below `LOG_LEVEL` is dropped before anything is
 * serialized, so a disabled debug call costs one comparison.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFields = Record<string, unknown>;

export interface LogEntry {
  time: string;
  level: Exclude<LogLevel, 'silent'>;
  message: string;
  service: string;
  pid: number;
  [field: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Same logger with extra permanent fields (e.g. `{ module: 'cache' }`). */
  child(bindings: LogFields): Logger;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

export function isLogLevel(value: string): value is LogLevel {
  return (LEVELS as readonly string[]).includes(value);
}

const REDACTED = '[redacted]';
const MAX_STRING_LENGTH = 512;
const MAX_DEPTH = 4;

/**
 * Key names that must never reach a log sink. Matched case-insensitively as a
 * substring, so `passwordHash`, `jwtSecret` and `set-cookie` are all caught.
 */
const SENSITIVE_KEY = /(pass|secret|token|auth|cookie|api[-_]?key|jwt|card|cvc|cvv|iban|ssn)/i;

let currentLevel: LogLevel = isLogLevel(config.log.level)
  ? (config.log.level as LogLevel)
  : 'info';

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Used by `LOG_LEVEL` and by tests; takes effect for every later line. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function truncate(value: string): string {
  return value.length <= MAX_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_STRING_LENGTH)}...[+${value.length - MAX_STRING_LENGTH} chars]`;
}

/**
 * Makes a value safe to serialize: redacts sensitive keys, bounds depth, bounds
 * string length, handles circular references and Errors.
 */
function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? truncate(value) : value;
  }

  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();

  if (seen.has(value as object)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    // Bound arrays too: a 10k-row result must not become a 10k-line log entry.
    const capped = value.slice(0, 20).map((item) => sanitize(item, depth + 1, seen));
    if (value.length > 20) capped.push(`[+${value.length - 20} more]`);
    return capped;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(item, depth + 1, seen);
  }
  return out;
}

/**
 * Error → plain object. `stack` is dropped in production: it is the single most
 * useful debugging field AND the single most likely to leak internals (file
 * paths, dependency versions, sometimes parameters) into a log store with a
 * wider audience. Outside production it is kept, because that is where it is
 * read.
 */
export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { name: 'NonError', message: String(err) };

  const serialized: Record<string, unknown> = {
    name: err.name,
    message: err.message,
  };

  const code = (err as { code?: unknown }).code;
  if (code !== undefined && code !== null) serialized.code = code;

  if (config.env !== 'production' && err.stack) {
    serialized.stack = truncate(err.stack);
  }
  return serialized;
}

/** Where formatted lines go. Swapped by tests to capture instead of print. */
export type LogSink = (entry: LogEntry, line: string) => void;

function defaultSink(entry: LogEntry, line: string): void {
  // Warnings and errors go to stderr so a log pipeline can route them
  // separately; everything else is normal output.
  if (entry.level === 'error' || entry.level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

let sink: LogSink = defaultSink;

/** Installs a capture sink (tests) or restores the default with `null`. */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? defaultSink;
}

/** Restores level + sink - called between test files so state cannot leak. */
export function resetLogger(): void {
  currentLevel = isLogLevel(config.log.level) ? (config.log.level as LogLevel) : 'info';
  sink = defaultSink;
}

function emit(
  level: Exclude<LogLevel, 'silent'>,
  bindings: LogFields,
  context: LogContext,
  message: string,
  fields?: LogFields
): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) return;

  const entry: LogEntry = {
    time: new Date().toISOString(),
    level,
    message,
    service: config.log.service,
    pid: process.pid,
    ...(sanitize(context) as LogFields),
    ...(sanitize(bindings) as LogFields),
    ...(fields === undefined ? {} : (sanitize(fields) as LogFields)),
  };

  try {
    sink(entry, JSON.stringify(entry));
  } catch {
    // A logger must never be the reason a request fails. Last resort only.
    defaultSink(entry, JSON.stringify({ ...entry, sinkError: true }));
  }
}

function createLogger(bindings: LogFields): Logger {
  return {
    debug: (message, fields) => emit('debug', bindings, getLogContext(), message, fields),
    info: (message, fields) => emit('info', bindings, getLogContext(), message, fields),
    warn: (message, fields) => emit('warn', bindings, getLogContext(), message, fields),
    error: (message, fields) => emit('error', bindings, getLogContext(), message, fields),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

/**
 * Process-wide logger. Prefer `getLogger({ module: 'cache' })` in infrastructure
 * modules so every line says where it came from.
 */
export const logger: Logger = createLogger({});

export function getLogger(bindings: LogFields = {}): Logger {
  return createLogger(bindings);
}

