-- CreateTable
CREATE TABLE "AppUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Workspace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProviderSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "displayName" TEXT,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT,
    "autoSwitchApiKey" BOOLEAN NOT NULL DEFAULT false,
    "models" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProviderSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProviderApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerSettingId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProviderApiKey_providerSettingId_fkey" FOREIGN KEY ("providerSettingId") REFERENCES "ProviderSetting" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "title" TEXT NOT NULL,
    "memorySummary" TEXT,
    "memorySummaryUpdatedAt" DATETIME,
    "memorySummaryMessageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "mode" TEXT,
    "content" TEXT NOT NULL,
    "memoryText" TEXT,
    "metadata" JSONB,
    "model" TEXT,
    "provider" TEXT,
    "reasoningEffort" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "triggerMessageId" TEXT,
    "assistantMessageId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'agent',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider" TEXT,
    "model" TEXT,
    "reasoningEffort" TEXT,
    "title" TEXT,
    "promptPreview" TEXT,
    "responsePreview" TEXT,
    "runSummary" TEXT,
    "errorMessage" TEXT,
    "capabilitySnapshot" JSONB,
    "approvalSummary" JSONB,
    "verificationStatus" TEXT,
    "verificationSummary" JSONB,
    "tokenUsage" JSONB,
    "iterationCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_triggerMessageId_fkey" FOREIGN KEY ("triggerMessageId") REFERENCES "Message" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_assistantMessageId_fkey" FOREIGN KEY ("assistantMessageId") REFERENCES "Message" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentRunStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL,
    "reasoning" TEXT,
    "response" TEXT,
    "responsePreview" TEXT,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "toolFailureCount" INTEGER NOT NULL DEFAULT 0,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentRunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentToolCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "stepId" TEXT,
    "externalCallId" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "parameters" JSONB,
    "resultData" JSONB,
    "outputPreview" TEXT,
    "errorMessage" TEXT,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvedByUser" BOOLEAN,
    "approvalId" TEXT,
    "riskLevel" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentToolCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentToolCall_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "AgentRunStep" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentCheckpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "stepId" TEXT,
    "toolCallId" TEXT,
    "workspaceId" TEXT,
    "path" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "diffPreview" TEXT,
    "beforeContent" TEXT,
    "afterContent" TEXT,
    "restoreNote" TEXT,
    "restoredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentCheckpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentCheckpoint_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "AgentRunStep" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentCheckpoint_toolCallId_fkey" FOREIGN KEY ("toolCallId") REFERENCES "AgentToolCall" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentCheckpoint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentProcessSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "toolCallId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'command',
    "status" TEXT NOT NULL DEFAULT 'running',
    "command" TEXT NOT NULL,
    "cwd" TEXT NOT NULL,
    "pid" INTEGER,
    "exitCode" INTEGER,
    "stdoutPreview" TEXT,
    "stderrPreview" TEXT,
    "outputSummary" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentProcessSession_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentProcessSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentProcessSession_toolCallId_fkey" FOREIGN KEY ("toolCallId") REFERENCES "AgentToolCall" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "conversationId" TEXT,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'workspace',
    "priority" INTEGER NOT NULL DEFAULT 50,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentRule_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentSkill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT,
    "version" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentSkill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentIntegration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'database',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentIntegration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentMcpServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'http',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "authType" TEXT NOT NULL DEFAULT 'none',
    "config" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentMcpServer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'chat',
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ServiceApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "autoSwitch" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ServiceApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AutoApprovePattern" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "conversationId" TEXT,
    "name" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "matchType" TEXT NOT NULL DEFAULT 'exact',
    "toolName" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'workspace',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutoApprovePattern_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AutoApprovePattern_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AutoApprovePattern_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AppUser_email_key" ON "AppUser"("email");

-- CreateIndex
CREATE INDEX "Workspace_userId_idx" ON "Workspace"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderSetting_userId_provider_key" ON "ProviderSetting"("userId", "provider");

-- CreateIndex
CREATE INDEX "ProviderApiKey_providerSettingId_isActive_idx" ON "ProviderApiKey"("providerSettingId", "isActive");

-- CreateIndex
CREATE INDEX "Conversation_userId_updatedAt_idx" ON "Conversation"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_idx" ON "Conversation"("workspaceId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_conversationId_createdAt_idx" ON "AgentRun"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_workspaceId_createdAt_idx" ON "AgentRun"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_status_updatedAt_idx" ON "AgentRun"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentRun_provider_model_idx" ON "AgentRun"("provider", "model");

-- CreateIndex
CREATE INDEX "AgentRun_triggerMessageId_idx" ON "AgentRun"("triggerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_assistantMessageId_key" ON "AgentRun"("assistantMessageId");

-- CreateIndex
CREATE INDEX "AgentRunStep_runId_timestamp_idx" ON "AgentRunStep"("runId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRunStep_runId_iteration_key" ON "AgentRunStep"("runId", "iteration");

-- CreateIndex
CREATE INDEX "AgentToolCall_runId_createdAt_idx" ON "AgentToolCall"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentToolCall_stepId_createdAt_idx" ON "AgentToolCall"("stepId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentToolCall_externalCallId_idx" ON "AgentToolCall"("externalCallId");

-- CreateIndex
CREATE INDEX "AgentToolCall_status_updatedAt_idx" ON "AgentToolCall"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentToolCall_approvalId_idx" ON "AgentToolCall"("approvalId");

-- CreateIndex
CREATE INDEX "AgentCheckpoint_runId_createdAt_idx" ON "AgentCheckpoint"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentCheckpoint_stepId_createdAt_idx" ON "AgentCheckpoint"("stepId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentCheckpoint_toolCallId_createdAt_idx" ON "AgentCheckpoint"("toolCallId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentCheckpoint_workspaceId_createdAt_idx" ON "AgentCheckpoint"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentCheckpoint_status_updatedAt_idx" ON "AgentCheckpoint"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProcessSession_toolCallId_key" ON "AgentProcessSession"("toolCallId");

-- CreateIndex
CREATE INDEX "AgentProcessSession_runId_createdAt_idx" ON "AgentProcessSession"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentProcessSession_workspaceId_createdAt_idx" ON "AgentProcessSession"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentProcessSession_status_updatedAt_idx" ON "AgentProcessSession"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentRule_userId_scope_enabled_idx" ON "AgentRule"("userId", "scope", "enabled");

-- CreateIndex
CREATE INDEX "AgentRule_workspaceId_idx" ON "AgentRule"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentRule_conversationId_idx" ON "AgentRule"("conversationId");

-- CreateIndex
CREATE INDEX "AgentSkill_userId_enabled_idx" ON "AgentSkill"("userId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSkill_userId_name_key" ON "AgentSkill"("userId", "name");

-- CreateIndex
CREATE INDEX "AgentIntegration_userId_type_enabled_idx" ON "AgentIntegration"("userId", "type", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AgentIntegration_userId_provider_name_key" ON "AgentIntegration"("userId", "provider", "name");

-- CreateIndex
CREATE INDEX "AgentMcpServer_userId_enabled_idx" ON "AgentMcpServer"("userId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AgentMcpServer_userId_name_key" ON "AgentMcpServer"("userId", "name");

-- CreateIndex
CREATE INDEX "UsageRecord_userId_recordedAt_idx" ON "UsageRecord"("userId", "recordedAt");

-- CreateIndex
CREATE INDEX "UsageRecord_userId_provider_idx" ON "UsageRecord"("userId", "provider");

-- CreateIndex
CREATE INDEX "UsageRecord_userId_model_idx" ON "UsageRecord"("userId", "model");

-- CreateIndex
CREATE INDEX "ServiceApiKey_userId_service_isActive_idx" ON "ServiceApiKey"("userId", "service", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceApiKey_userId_service_name_key" ON "ServiceApiKey"("userId", "service", "name");

-- CreateIndex
CREATE INDEX "AutoApprovePattern_userId_scope_enabled_idx" ON "AutoApprovePattern"("userId", "scope", "enabled");

-- CreateIndex
CREATE INDEX "AutoApprovePattern_workspaceId_idx" ON "AutoApprovePattern"("workspaceId");

-- CreateIndex
CREATE INDEX "AutoApprovePattern_conversationId_idx" ON "AutoApprovePattern"("conversationId");

-- CreateIndex
CREATE INDEX "AutoApprovePattern_toolName_enabled_idx" ON "AutoApprovePattern"("toolName", "enabled");
