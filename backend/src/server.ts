import { createApp } from './app';
import { config } from './config';
import { prisma } from './config/prisma';

/**
 * HTTP server entrypoint. Binds the Express app to a port and owns the
 * process lifecycle (graceful shutdown on SIGINT / SIGTERM).
 */
async function main(): Promise<void> {
  const app = createApp();

  const server = app.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port} (${config.env})`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[server] received ${signal}, shutting down gracefully...`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    // Safety net: force-exit if shutdown hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});