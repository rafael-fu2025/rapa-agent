-- UsageRecord: add FK relation to AppUser (cascade delete — orphaned usage
-- rows previously survived user deletion).
-- ScheduledTask: add @@unique([userId, name]) for consistency with the other
-- name-bearing config models. Duplicate names (if any) are de-duplicated
-- first, keeping the earliest-created row.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- RedefineTables
CREATE TABLE "new_UsageRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'chat',
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_UsageRecord" ("completionTokens", "id", "mode", "model", "promptTokens", "provider", "recordedAt", "totalTokens", "userId") SELECT "completionTokens", "id", "mode", "model", "promptTokens", "provider", "recordedAt", "totalTokens", "userId" FROM "UsageRecord";
DROP TABLE "UsageRecord";
ALTER TABLE "new_UsageRecord" RENAME TO "UsageRecord";
CREATE INDEX "UsageRecord_userId_recordedAt_idx" ON "UsageRecord"("userId", "recordedAt");
CREATE INDEX "UsageRecord_userId_provider_idx" ON "UsageRecord"("userId", "provider");
CREATE INDEX "UsageRecord_userId_model_idx" ON "UsageRecord"("userId", "model");

-- De-duplicate ScheduledTask names per user (keep the earliest created),
-- then add the unique constraint.
DELETE FROM "ScheduledTask" WHERE "id" NOT IN (
    SELECT "id" FROM (
        SELECT "id", ROW_NUMBER() OVER (
            PARTITION BY "userId", "name"
            ORDER BY "createdAt" ASC, "id" ASC
        ) AS rn
        FROM "ScheduledTask"
    ) ranked WHERE ranked.rn = 1
);
CREATE UNIQUE INDEX "ScheduledTask_userId_name_key" ON "ScheduledTask"("userId", "name");

PRAGMA foreign_keys=ON;
