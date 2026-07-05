-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentTask_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AgentTask" ("content", "conversationId", "createdAt", "id", "order", "status", "taskId", "updatedAt", "userId") SELECT "content", "conversationId", "createdAt", "id", "order", "status", "taskId", "updatedAt", "userId" FROM "AgentTask";
DROP TABLE "AgentTask";
ALTER TABLE "new_AgentTask" RENAME TO "AgentTask";
CREATE INDEX "AgentTask_conversationId_status_idx" ON "AgentTask"("conversationId", "status");
CREATE INDEX "AgentTask_userId_idx" ON "AgentTask"("userId");
CREATE UNIQUE INDEX "AgentTask_conversationId_taskId_key" ON "AgentTask"("conversationId", "taskId");
CREATE TABLE "new_IntegrationCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "credentialEncrypted" TEXT NOT NULL,
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IntegrationCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_IntegrationCredential" ("accountName", "createdAt", "credentialEncrypted", "id", "isActive", "lastUsedAt", "metadata", "provider", "updatedAt", "userId") SELECT "accountName", "createdAt", "credentialEncrypted", "id", "isActive", "lastUsedAt", "metadata", "provider", "updatedAt", "userId" FROM "IntegrationCredential";
DROP TABLE "IntegrationCredential";
ALTER TABLE "new_IntegrationCredential" RENAME TO "IntegrationCredential";
CREATE INDEX "IntegrationCredential_userId_provider_isActive_idx" ON "IntegrationCredential"("userId", "provider", "isActive");
CREATE UNIQUE INDEX "IntegrationCredential_userId_provider_accountName_key" ON "IntegrationCredential"("userId", "provider", "accountName");
CREATE TABLE "new_NotificationChannel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'generic',
    "webhookUrlEncrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NotificationChannel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_NotificationChannel" ("createdAt", "enabled", "id", "kind", "lastUsedAt", "name", "updatedAt", "useCount", "userId", "webhookUrlEncrypted") SELECT "createdAt", "enabled", "id", "kind", "lastUsedAt", "name", "updatedAt", "useCount", "userId", "webhookUrlEncrypted" FROM "NotificationChannel";
DROP TABLE "NotificationChannel";
ALTER TABLE "new_NotificationChannel" RENAME TO "NotificationChannel";
CREATE INDEX "NotificationChannel_userId_enabled_idx" ON "NotificationChannel"("userId", "enabled");
CREATE UNIQUE INDEX "NotificationChannel_userId_name_key" ON "NotificationChannel"("userId", "name");
CREATE TABLE "new_ScheduledTask" (
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
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ScheduledTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ScheduledTask_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ScheduledTask" ("conversationId", "createdAt", "enabled", "id", "lastError", "lastRunAt", "lastRunStatus", "name", "nextRunAt", "payload", "runCount", "scheduleExpr", "scheduleKind", "scheduleTz", "updatedAt", "userId") SELECT "conversationId", "createdAt", "enabled", "id", "lastError", "lastRunAt", "lastRunStatus", "name", "nextRunAt", "payload", "runCount", "scheduleExpr", "scheduleKind", "scheduleTz", "updatedAt", "userId" FROM "ScheduledTask";
DROP TABLE "ScheduledTask";
ALTER TABLE "new_ScheduledTask" RENAME TO "ScheduledTask";
CREATE INDEX "ScheduledTask_userId_enabled_idx" ON "ScheduledTask"("userId", "enabled");
CREATE INDEX "ScheduledTask_nextRunAt_enabled_idx" ON "ScheduledTask"("nextRunAt", "enabled");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

