-- AgentHook lifecycle hooks (table was previously created via `prisma db push`
-- during development; this migration records that shape in the migration
-- history so baseline and schema stay in sync).

-- CreateTable
CREATE TABLE "AgentHook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "matchTool" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "timeoutMs" INTEGER NOT NULL DEFAULT 5000,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentHook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AgentHook_userId_event_enabled_idx" ON "AgentHook"("userId", "event", "enabled");
