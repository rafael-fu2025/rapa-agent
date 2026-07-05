// Mark a migration as applied. Used when we apply SQL directly because
// the dev server is holding the DB lock.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const MIGRATION_NAME = "20260704150509_add_agent_task_persistence";

async function main() {
  // Prisma stores applied migrations in _prisma_migrations. Insert a row
  // matching what `prisma migrate dev` would have written.
  await prisma.$executeRawUnsafe(
    `INSERT OR IGNORE INTO "_prisma_migrations" ("id", "checksum", "migration_name", "finished_at", "applied_steps_count", "started_at", "logs") VALUES (?, ?, ?, ?, ?, ?, ?)`,
    `${MIGRATION_NAME}_manual`,
    "manual",
    MIGRATION_NAME,
    new Date().toISOString(),
    1,
    new Date().toISOString(),
    ""
  );
  console.log(`Migration ${MIGRATION_NAME} marked as applied`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
