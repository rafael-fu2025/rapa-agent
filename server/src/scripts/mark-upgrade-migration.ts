// Mark the upgrade-plan migration as applied.
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { PrismaClient } from "@prisma/client";

function loadEnvFile(path: string): void {
  try {
    const raw = readFileSync(path, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch { /* ignore */ }
}
loadEnvFile(resolvePath(process.cwd(), ".env"));

const MIGRATION_NAME = "20260704230000_add_upgrade_plan_tables";
const prisma = new PrismaClient();

async function main() {
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
