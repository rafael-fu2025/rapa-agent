-- CreateTable
CREATE TABLE "NotificationChannel" (
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

-- CreateTable
CREATE TABLE "ScheduledTask" (
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

-- CreateTable
CREATE TABLE "IntegrationCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "credentialEncrypted" TEXT NOT NULL,
    "metadata" JSON,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IntegrationCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationChannel_userId_name_key" ON "NotificationChannel"("userId", "name");

-- CreateIndex
CREATE INDEX "NotificationChannel_userId_enabled_idx" ON "NotificationChannel"("userId", "enabled");

-- CreateIndex
CREATE INDEX "ScheduledTask_userId_enabled_idx" ON "ScheduledTask"("userId", "enabled");

-- CreateIndex
CREATE INDEX "ScheduledTask_nextRunAt_enabled_idx" ON "ScheduledTask"("nextRunAt", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationCredential_userId_provider_accountName_key" ON "IntegrationCredential"("userId", "provider", "accountName");

-- CreateIndex
CREATE INDEX "IntegrationCredential_userId_provider_isActive_idx" ON "IntegrationCredential"("userId", "provider", "isActive");
