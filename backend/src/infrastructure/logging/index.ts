/**
 * Logging + observability barrel (Day 8).
 *
 *   - `logger`  → structured JSON lines with redaction and level filtering
 *   - `context` → AsyncLocalStorage carrier for requestId / eventId, so any
 *                 module can correlate its logs without a parameter
 */
export {
  getLogger,
  getLogLevel,
  isLogLevel,
  logger,
  resetLogger,
  serializeError,
  setLogLevel,
  setLogSink,
  type LogEntry,
  type LogFields,
  type LogLevel,
  type LogSink,
  type Logger,
} from './logger';
export { getLogContext, runWithLogContext, updateLogContext, type LogContext } from './context';
