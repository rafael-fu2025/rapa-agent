// One-shot verification script — confirms the new SQLite DB has the
// expected number of rows after the MySQL → SQLite migration.
//
// Usage:
//   cd server
//   npx tsx src/scripts/verify-migration.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const [users, providers, keys, serviceKeys] = await Promise.all([
    prisma.appUser.count(),
    prisma.providerSetting.count(),
    prisma.providerApiKey.count(),
    prisma.serviceApiKey.count()
  ]);

  console.log("");
  console.log("Row counts in the new SQLite dev.db");
  console.log("-----------------------------------");
  console.log(`AppUser          : ${users}`);
  console.log(`ProviderSetting  : ${providers}`);
  console.log(`ProviderApiKey   : ${keys}`);
  console.log(`ServiceApiKey    : ${serviceKeys}`);

  // Most-recent active keys
  const sample = await prisma.providerApiKey.findMany({
    where: { isActive: true },
    include: {
      providerSetting: {
        select: { provider: true, displayName: true, baseUrl: true }
      }
    },
    take: 20,
    orderBy: { createdAt: "desc" }
  });

  console.log("");
  console.log("Most-recent active API keys (up to 20):");
  console.log("-----------------------------------");
  for (const k of sample) {
    const provider = k.providerSetting.provider.padEnd(12);
    const name = k.name.padEnd(22);
    const url = k.providerSetting.baseUrl;
    console.log(`  ${provider} :: ${name} :: ${url}`);
  }

  // Group by provider so the user can see the per-provider counts
  const grouped = await prisma.providerApiKey.groupBy({
    by: ["providerSettingId"],
    _count: { _all: true }
  });
  const settings = await prisma.providerSetting.findMany({
    where: { id: { in: grouped.map((g) => g.providerSettingId) } }
  });
  const settingMap = new Map(settings.map((s) => [s.id, s]));

  console.log("");
  console.log("API keys per provider:");
  console.log("-----------------------------------");
  for (const g of grouped.sort((a, b) => b._count._all - a._count._all)) {
    const setting = settingMap.get(g.providerSettingId);
    if (setting) {
      const provider = setting.provider.padEnd(12);
      console.log(`  ${provider} : ${g._count._all} keys`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Verification failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
