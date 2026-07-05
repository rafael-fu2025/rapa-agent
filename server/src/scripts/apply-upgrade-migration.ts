// One-shot migration applier for the upgrade plan's new tables.
// Used when the dev server holds the DB lock and prisma migrate dev
// can't open the file. Safe to run multiple times — every statement
// uses IF NOT EXISTS.

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { PrismaClient } from "@prisma/client";

// Inline .env loader — no dotenv dependency. Parses KEY=VALUE lines
// and applies them to process.env if not already set.
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
  } catch {
    // ignore — env may already be set
  }
}
loadEnvFile(resolvePath(process.cwd(), ".env"));

const prisma = new PrismaClient();

async function main() {
  // §3.3 — NotificationChannel
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "NotificationChannel" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "kind" TEXT NOT NULL DEFAULT 'generic',
      "webhookUrlEncrypted" TEXT NOT NULL,
      "enabled" BOOLEAN NOT NULL DEFAULT 1,
      "useCount" INTEGER NOT NULL DEFAULT 0,
      "lastUsedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "NotificationChannel_userId_name_key" ON "NotificationChannel"("userId","name")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "NotificationChannel_userId_enabled_idx" ON "NotificationChannel"("userId","enabled")`
  );

  // §2.4 — ScheduledTask
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ScheduledTask" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "conversationId" TEXT,
      "name" TEXT NOT NULL,
      "scheduleKind" TEXT NOT NULL,
      "scheduleExpr" TEXT,
      "scheduleTz" TEXT,
      "payload" TEXT NOT NULL,
      "nextRunAt" DATETIME,
      "lastRunAt" DATETIME,
      "lastRunStatus" TEXT,
      "lastError" TEXT,
      "enabled" BOOLEAN NOT NULL DEFAULT 1,
      "runCount" INTEGER NOT NULL DEFAULT 0,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE,
      FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "ScheduledTask_userId_enabled_idx" ON "ScheduledTask"("userId","enabled")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "ScheduledTask_nextRunAt_enabled_idx" ON "ScheduledTask"("nextRunAt","enabled")`
  );

  // §3.2 — IntegrationCredential
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "IntegrationCredential" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "provider" TEXT NOT NULL,
      "accountName" TEXT NOT NULL,
      "credentialEncrypted" TEXT NOT NULL,
      "metadata" JSON,
      "isActive" BOOLEAN NOT NULL DEFAULT 1,
      "lastUsedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationCredential_userId_provider_accountName_key" ON "IntegrationCredential"("userId","provider","accountName")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "IntegrationCredential_userId_provider_isActive_idx" ON "IntegrationCredential"("userId","provider","isActive")`
  );

  console.log("Upgrade plan tables ready (NotificationChannel, ScheduledTask, IntegrationCredential)");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
