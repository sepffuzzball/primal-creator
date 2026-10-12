/**
 * Prisma client singleton.
 *
 * In development the client is cached on globalThis to avoid exhausting database
 * connections during Next.js hot reload. Query engines are lazy: constructing the
 * client does not open a connection until the first query, so importing this in a
 * test without a running database is safe.
 */

import { PrismaClient } from "@prisma/client"

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}

export default prisma
