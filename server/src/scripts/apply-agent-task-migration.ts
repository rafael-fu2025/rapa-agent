// One-shot migration applier. Used when the dev server holds the DB lock
// and prisma migrate dev can't open the file. Safe to run multiple times —
// uses IF NOT EXISTS everywhere.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AgentTask" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "conversationId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "taskId" TEXT NOT NULL,
      "content" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "order" INTEGER NOT NULL DEFAULT 0,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE,
      FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "AgentTask_conversationId_taskId_key" ON "AgentTask"("conversationId","taskId")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "AgentTask_conversationId_status_idx" ON "AgentTask"("conversationId","status")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "AgentTask_userId_idx" ON "AgentTask"("userId")`
  );
  console.log("AgentTask table ready");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
