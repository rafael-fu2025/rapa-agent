import { PrismaClient } from "@prisma/client";
import { LOCAL_USER_EMAIL } from "./constants.js";

// Reuse the Prisma client across hot-reloads in dev (tsx watch reloads modules
// in-place; without this we'd leak connections on every file save).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// SQLite tuning — applied once per process at boot.
//
// Why these specific PRAGMAs:
//   journal_mode = WAL     — readers don't block writers and vice versa.
//                            Biggest single perf win for a long-running
//                            Fastify server that mixes reads + writes.
//   synchronous  = NORMAL  — fsync only on checkpoint, not every commit.
//                            ~2-3x faster writes, still crash-safe
//                            (a power loss can lose the last transaction
//                            but never corrupt the database).
//   busy_timeout = 5000    — if a write is briefly blocked, wait up to 5s
//                            instead of failing with SQLITE_BUSY.
//   cache_size   = -20000  — tell SQLite to use ~20 MB of page cache.
//                            Negative = KB, so this is 20 MB.
//                            Better than relying on the OS default.
//
// WAL mode also creates two extra files alongside dev.db:
//   - dev.db-wal  (write-ahead log)
//   - dev.db-shm  (shared memory index)
// Both are part of the database — back them up together.
let sqlitePragmasApplied = false;
async function applySqlitePragmas(): Promise<void> {
  if (sqlitePragmasApplied) return;
  try {
    // Use $queryRawUnsafe for all four. Even though some PRAGMAs (like
    // synchronous, busy_timeout, cache_size) *can* be set with
    // $executeRawUnsafe in isolation, several of them return the new
    // value as a result row in newer SQLite builds — which causes
    // P2010 on $executeRawUnsafe. $queryRawUnsafe handles both cases
    // safely.
    await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
    await prisma.$queryRawUnsafe("PRAGMA synchronous = NORMAL;");
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000;");
    await prisma.$queryRawUnsafe("PRAGMA cache_size = -20000;");
    sqlitePragmasApplied = true;
  } catch (err) {
    // Non-fatal: the DB still works with defaults, just slightly slower.
    console.warn("[db] Failed to apply SQLite pragmas:", err);
  }
}

// Fire-and-forget on first import. Prisma queues subsequent queries
// until the connection is ready, so no await needed at call sites.
void applySqlitePragmas();

export async function getLocalUser() {
  return prisma.appUser.upsert({
    where: { email: LOCAL_USER_EMAIL },
    update: {},
    create: { email: LOCAL_USER_EMAIL }
  });
}
