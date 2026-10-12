/**
 * Database integration smoke check.
 *
 * Run after `pnpm prisma generate`, `pnpm db:migrate` and `pnpm db:seed` against
 * a reachable Postgres. It asserts that the migration applied and the seed ran by
 * confirming the bootstrap admin user and at least the seeded catalog entries
 * exist. Exits non-zero on failure so CI fails loudly.
 *
 *   DATABASE_URL=... node scripts/db-smoke.mjs
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const admin = await prisma.user.findFirst({ where: { isAdmin: true } });
if (!admin) {
  console.error("db-smoke: FAIL - no admin user found after seed");
  process.exitCode = 1;
} else {
  console.log(`db-smoke: ok - admin user present (${admin.email})`);
}

const catalogCount = await prisma.catalogDefinition.count();
if (catalogCount < 2) {
  console.error(`db-smoke: FAIL - expected >= 2 catalog entries, got ${catalogCount}`);
  process.exitCode = 1;
} else {
  console.log(`db-smoke: ok - ${catalogCount} catalog entries present`);
}

await prisma.$disconnect();
