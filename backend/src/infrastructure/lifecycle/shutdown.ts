import { Server } from 'node:http';
import { config } from '../../config';
import { getLogger } from '../logging';
import { getHttpMetrics } from '../metrics';

/**
 * Graceful shutdown (Day 8).
 *
 * WHAT "GRACEFUL" MEANS HERE
 * --------------------------
 * A process dies in three ways, and only one of them is a bug:
 *
 *   1. the platform stops it for a deploy / scale-down  → SIGTERM, EXPECTED
 *   2. you stop it locally                              → SIGINT, EXPECTED
 *   3. it crashes                                       → nothing runs
 *
 * This module handles 1 and 2, and the goal is that neither is visible to a
 * client: finish what is in flight, stop accepting anything new, then close
 * dependencies in the order that makes each remaining close safe.
 *
 * WHY A STEP LIST INSTEAD OF ONE BIG `server.close()` CALLBACK
 * ------------------------------------------------------------
 * The Day-7 version nested every close inside the HTTP server's close callback
 * with a single 10s `setTimeout(() => process.exit(1))` bolted on. Three
 * problems with that, all found by testing it:
 *
 *   - If `server.close()` never called back (a hung handler, or an idle
 *     keep-alive connection), the timeout killed the process mid-flight with no
 *     record of which step was stuck.
 *   - One throwing step (say Redis refuses to close) skipped every step after
 *     it, so Prisma stayed connected and the exit code was still 0 - the
 *     shutdown LOOKED successful.
 *   - Nothing was observable: no per-step timing, no record of what failed.
 *
 * So shutdown is now an ordered list of named steps. Each is timed, each failure
 * is logged and RECORDED (exit code 1) without stopping the rest - a dependency
 * that will not close is exactly the situation where you still want to try
 * closing the others. A single watchdog covers the whole budget: it is `unref`'d
 * so a clean shutdown exits immediately, and if a step hangs, the watchdog names
 * the step that hung instead of failing silently.
 *
 * WHY THE STEPS ARE IN THIS ORDER
 * -------------------------------
 *   background work first → traffic second → dependencies last.
 *
 * Stop the dispatcher before the producer socket closes, or a tick can try to
 * publish into a closed client. Stop consuming before disconnecting anything it
 * uses, or a handler runs against a closed Prisma pool. Close the HTTP server
 * before the database, or a request that arrived in the last millisecond fails.
 */
const lifecycleLogger = getLogger({ module: 'lifecycle' });

/** One named unit of shutdown work. */
export interface ShutdownStep {
  /** Stable, human-readable name - appears in logs and in test assertions. */
  name: string;
  run(): Promise<void> | void;
}

export interface ShutdownResult {
  /** Names of the steps that completed, in the order they ran. */
  completed: string[];
  /** Steps that threw. Shutdown continued past each of them. */
  failed: { name: string; error: string }[];
  /** 0 when every step succeeded, 1 otherwise. */
  exitCode: number;
  /** Total wall time of the sequence, in ms. */
  durationMs: number;
}

export interface ShutdownSequenceOptions {
  /** Which process role is shutting down - `api` or `worker`. */
  role: string;
  steps: ShutdownStep[];
  /** Whole-sequence budget. Defaults to SHUTDOWN_TIMEOUT_MS. */
  timeoutMs?: number;
  /** What to do when the budget is exceeded. Injectable for tests. */
  onTimeout?: (info: { role: string; pendingStep: string; elapsedMs: number }) => void;
}

function elapsedMs(since: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - since) / 1e6);
}

/**
 * Runs the steps sequentially under one watchdog. Never throws, never rejects.
 *
 * Exported separately from the signal wiring so the whole policy is testable
 * without sending real signals or owning a real process.
 */
export function runShutdownSteps(options: ShutdownSequenceOptions): Promise<ShutdownResult> {
  const { role, steps } = options;
  const timeoutMs = options.timeoutMs ?? config.http.shutdownTimeoutMs;
  const startedAt = process.hrtime.bigint();

  const result: ShutdownResult = { completed: [], failed: [], exitCode: 0, durationMs: 0 };

  // `unref` is what makes a CLEAN shutdown fast: once every handle is closed the
  // event loop has nothing left and Node exits by itself, watchdog included. The
  // timer therefore only ever fires when something is still holding the process
  // open - i.e. precisely when it is needed.
  let pendingStep = steps.length > 0 ? steps[0].name : '';
  const watchdog = setTimeout(() => {
    const info = { role, pendingStep, elapsedMs: elapsedMs(startedAt) };
    lifecycleLogger.error('shutdown exceeded its budget', {
      ...info,
      completed: result.completed,
    });
    (options.onTimeout ?? defaultOnTimeout)(info);
  }, timeoutMs);
  watchdog.unref?.();

  return (async () => {
    for (const step of steps) {
      pendingStep = step.name;
      const stepStartedAt = process.hrtime.bigint();
      try {
        await step.run();
        result.completed.push(step.name);
        lifecycleLogger.info('shutdown step completed', {
          role,
          step: step.name,
          durationMs: elapsedMs(stepStartedAt),
        });
      } catch (err) {
        result.failed.push({
          name: step.name,
          error: err instanceof Error ? err.message : String(err),
        });
        // A step that will not close is a real failure, but NOT a reason to skip
        // the remaining closes - that is when they matter most.
        result.exitCode = 1;
        lifecycleLogger.error('shutdown step failed; continuing', {
          role,
          step: step.name,
          durationMs: elapsedMs(stepStartedAt),
          error: err,
        });
      }
    }

    clearTimeout(watchdog);
    pendingStep = '';
    result.durationMs = elapsedMs(startedAt);
    lifecycleLogger.info('shutdown complete', {
      role,
      durationMs: result.durationMs,
      failed: result.failed.length,
      exitCode: result.exitCode,
    });
    return result;
  })();
}

function defaultOnTimeout(info: { role: string; pendingStep: string; elapsedMs: number }): void {
  // The budget is gone and something is still holding the loop open: staying up
  // is worse than leaking a socket, because the orchestrator's own kill timer is
  // next and it will not report which step hung.
  lifecycleLogger.error('forcing process exit', info);
  process.exit(1);
}

export interface ShutdownHandlersOptions extends ShutdownSequenceOptions {
  /** How the process ends. Injectable so tests never kill the test runner. */
  exit?: (code: number) => void;
}

export interface ShutdownHandle {
  /**
   * Runs the sequence at most once. Additional calls (a second signal, or a
   * signal plus a manual call) are logged and ignored: two overlapping
   * shutdowns close the same socket twice and the second one throws, which
   * looks like a new failure in the log while the real shutdown finishes.
   */
  shutdown(reason: string): Promise<ShutdownResult | undefined>;
  /** Detaches the signal listeners (used by tests). */
  removeListeners(): void;
}

/**
 * Wires SIGTERM / SIGINT to a shutdown sequence, then ends the process with the
 * code the sequence deserved.
 *
 * SIGTERM is what Kubernetes / Render / `docker stop` send; SIGINT is Ctrl+C.
 * Both get the same treatment, because the correct behaviour is identical.
 */
export function installShutdownHandlers(
  options: ShutdownHandlersOptions
): ShutdownHandle {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;

  const shutdown = async (reason: string): Promise<ShutdownResult | undefined> => {
    if (started) {
      lifecycleLogger.warn('shutdown already in progress; ignoring signal', {
        role: options.role,
        reason,
      });
      return undefined;
    }
    started = true;
    lifecycleLogger.info('shutdown started', {
      role: options.role,
      reason,
      timeoutMs: options.timeoutMs ?? config.http.shutdownTimeoutMs,
      steps: options.steps.map((step) => step.name),
    });

    const result = await runShutdownSteps(options);
    exit(result.exitCode);
    return result;
  };

  const onSigint = (): void => void shutdown('SIGINT');
  const onSigterm = (): void => void shutdown('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  return {
    shutdown,
    removeListeners: () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    },
  };
}

/**
 * Stops the HTTP server: no new connections, in-flight requests get `drainMs`.
 *
 * THE TRAP THIS HANDLES: `server.close()` does NOT close existing connections,
 * and its callback only fires when they are ALL gone. With HTTP keep-alive -
 * which every browser and every HTTP client library uses - an idle connection
 * sits open indefinitely, so a naive `close()` hangs forever and the process
 * never exits. So:
 *
 *   1. `closeIdleConnections()` immediately: these are connections between
 *      requests, so nothing is lost by dropping them - the client will reconnect.
 *   2. Everything still mid-request gets the drain window to finish naturally.
 *   3. If the window elapses, `closeAllConnections()` destroys what is left.
 *      Those requests die with the connection instead of being answered, which
 *      is the correct trade only AFTER waiting: waiting longer has already
 *      outlasted the caller's own timeout, and the orchestrator's kill timer is
 *      about to do the same thing with less information in the log.
 *
 * Always resolves; a server that was never listening is not an error here.
 */
export function closeHttpServer(server: Server, drainMs = config.http.drainTimeoutMs): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(sweeper);
      clearTimeout(timer);
      resolve();
    };

    /**
     * `close()` fires only once EVERY connection is gone, and a keep-alive
     * connection becomes idle only when its request finishes - possibly long
     * after we started closing. So idle sockets are swept on a short interval
     * for as long as the drain lasts. Without this sweep, one request that
     * completed 10ms into a 5s drain still held the process open for the whole
     * 5s (observed, then fixed: that is the difference between a deploy that
     * takes 200ms and one that takes the full termination budget).
     */
    const sweeper = setInterval(() => server.closeIdleConnections?.(), 25);
    sweeper.unref?.();

    const timer = setTimeout(() => {
      lifecycleLogger.warn('drain window elapsed; forcing remaining connections closed', {
        drainMs,
        inFlight: getHttpMetrics().inFlight,
      });
      server.closeAllConnections?.();
      finish();
    }, drainMs);
    timer.unref?.();

    server.close((err) => {
      if (err) {
        lifecycleLogger.debug('http server close reported an error', { error: err });
      }
      finish();
    });

    server.closeIdleConnections?.();
  });
}

/**
 * Last-resort logging for the two ways a process dies without running its
 * shutdown handlers.
 *
 * Before Day 8 these printed a raw stack to stderr with no service name, no pid
 * and no requestId - the one moment where that context is most valuable. They
 * now go through the same structured logger, and the process still exits,
 * because after an uncaught exception the process state is unknown: continuing
 * (the pre-Node-10 habit of swallowing it) means serving traffic from a process
 * that may have half-applied a transaction.
 *
 * `onFatal` exists so tests can observe the report instead of being killed.
 */
export function installFatalErrorHandlers(
  role: string,
  onFatal: (info: { event: string; error: unknown }) => void = () => process.exit(1)
): void {
  const report = (event: string) => (error: unknown): void => {
    lifecycleLogger.error('fatal error', { role, event, error });
    onFatal({ event, error });
  };

  process.on('uncaughtException', report('uncaughtException'));
  process.on('unhandledRejection', report('unhandledRejection'));
}