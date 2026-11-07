-- AgentRun.worktree (Json?) — git worktree-per-run isolation metadata
-- (column was previously added to the dev database via `prisma db push`;
-- recorded here so the migration history replays to the exact schema).

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN "worktree" JSONB;
