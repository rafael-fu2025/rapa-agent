// One-off diagnostic: list stored API key ciphertexts and try common
// APP_SECRET values to see which one decrypts them. Run with:
//   npx tsx scripts/inspect-keys.ts
import { prisma } from "../src/lib/db.js";
import { decryptText } from "../src/lib/crypto.js";

const CANDIDATE_SECRETS = [
  "change-this-secret-to-a-long-random-value",
  "super-secret-default-key-change-me",
  "GENERATE_A_STRONG_RANDOM_SECRET_AND_REPLACE_THIS_VALUE",
  "rapa_dev_5f8a9c1e3b7d2469af0c1e5b8d2f4a6c_generate_a_new_one_for_prod",
  process.env.APP_SECRET ?? ""
];

async function main() {
  const keys = await prisma.providerApiKey.findMany({
    take: 5,
    orderBy: { id: "asc" },
    include: { providerSetting: { select: { provider: true } } }
  });
  console.log(`Found ${keys.length} sample keys in DB.`);
  for (const k of keys) {
    console.log(`\n--- key ${k.id} (${k.providerSetting.provider} / ${k.name}) ---`);
    console.log(`ciphertext prefix: ${k.apiKeyEncrypted.slice(0, 60)}...`);
    for (const candidate of CANDIDATE_SECRETS) {
      if (!candidate) continue;
      try {
        const decrypted = decryptText(k.apiKeyEncrypted, candidate);
        console.log(`  ✓ DECRYPTS with: ${candidate.slice(0, 20)}...`);
        console.log(`    plaintext prefix: ${decrypted.slice(0, 8)}...`);
        break;
      } catch {
        // not this one
      }
    }
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
