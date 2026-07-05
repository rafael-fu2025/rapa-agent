// Run with: npx tsx src/scripts/verify-pragmas.ts
// Confirms that the SQLite PRAGMAs in src/lib/db.ts actually take effect.
import { prisma } from "../lib/db.js";

async function main() {
  // Give the boot-time pragmas a moment to apply.
  await new Promise((r) => setTimeout(r, 300));

  const journal = await prisma.$queryRawUnsafe("PRAGMA journal_mode;");
  const sync = await prisma.$queryRawUnsafe("PRAGMA synchronous;");
  const busy = await prisma.$queryRawUnsafe("PRAGMA busy_timeout;");
  const cache = await prisma.$queryRawUnsafe("PRAGMA cache_size;");

  console.log("=== SQLite runtime PRAGMAs ===");
  console.log("journal_mode =", (journal as any)[0]?.journal_mode, " (want: wal)");
  console.log("synchronous  =", (sync as any)[0]?.synchronous, "       (want: 1 = NORMAL)");
  console.log("busy_timeout =", (busy as any)[0]?.busy_timeout, "    (want: 5000)");
  console.log(
    "cache_size   =",
    (cache as any)[0]?.cache_size,
    "  (want: -20000 = 20 MB)"
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
