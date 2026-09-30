/**
 * Process lifecycle barrel (Day 8).
 *
 *   - `shutdown` → ordered, observable, watchdog-guarded shutdown steps and the
 *                  signal wiring every entrypoint uses.
 */
export {
  closeHttpServer,
  installFatalErrorHandlers,
  installShutdownHandlers,
  runShutdownSteps,
  type ShutdownHandle,
  type ShutdownHandlersOptions,
  type ShutdownResult,
  type ShutdownSequenceOptions,
  type ShutdownStep,
} from './shutdown';