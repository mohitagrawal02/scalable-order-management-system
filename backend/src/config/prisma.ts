import { PrismaClient } from '@prisma/client';

/**
 * Prisma client singleton.
 *
 * A single shared instance is created per process. In development, ts-node-dev
 * keeps some modules alive across restarts, so we attach the instance to the
 * Node `global` object to avoid exhausting database connections with unlinked
 * duplicate clients.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;