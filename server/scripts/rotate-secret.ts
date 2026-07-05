// One-time migration: re-encrypt all stored ProviderApiKey rows from one
// APP_SECRET to another. Required when the server's APP_SECRET has been
// rotated and existing ciphertexts were produced with the old secret.
//
// Usage:
//   OLD_APP_SECRET="..." NEW_APP_SECRET="..." npx tsx scripts/rotate-secret.ts
//
// Or set them via env / interactive prompt. The script will:
//   1. List every ProviderApiKey row
//   2. Try to decrypt with OLD_APP_SECRET
//   3. Re-encrypt with NEW_APP_SECRET
//   4. Update the row in a single transaction
//
// Safe to re-run: if a row already decrypts with NEW_APP_SECRET, it's
// skipped.

import { prisma } from "../src/lib/db.js";
import { decryptText, encryptText } from "../src/lib/crypto.js";

function readSecret(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value && value.trim().length > 0) return value.trim();
  if (fallback && fallback.length > 0) return fallback;
  throw new Error(`Missing required env var ${name}`);
}

async function main() {
  const oldSecret = readSecret("OLD_APP_SECRET");
  const newSecret = readSecret("NEW_APP_SECRET");
  if (oldSecret === newSecret) {
    console.log("OLD and NEW secrets are identical — nothing to do.");
    return;
  }

  const keys = await prisma.providerApiKey.findMany({
    include: { providerSetting: { select: { provider: true } } }
  });
  console.log(`Scanning ${keys.length} stored API keys...`);

  let migrated = 0;
  let alreadyNew = 0;
  let failed = 0;
  const failures: { id: string; reason: string }[] = [];

  for (const k of keys) {
    // 1. Try new secret first — if it already works, skip.
    try {
      decryptText(k.apiKeyEncrypted, newSecret);
      alreadyNew += 1;
      continue;
    } catch {
      // fall through to migration
    }

    // 2. Try old secret.
    let plaintext: string;
    try {
      plaintext = decryptText(k.apiKeyEncrypted, oldSecret);
    } catch (err) {
      failed += 1;
      failures.push({ id: k.id, reason: (err as Error).message });
      console.log(`  ✗ ${k.id} (${k.providerSetting.provider} / ${k.name}): cannot decrypt with old secret — ${(err as Error).message}`);
      continue;
    }

    // 3. Re-encrypt with the new secret.
    const reEncrypted = encryptText(plaintext, newSecret);

    // 4. Persist.
    try {
      await prisma.providerApiKey.update({
        where: { id: k.id },
        data: { apiKeyEncrypted: reEncrypted }
      });
      migrated += 1;
      console.log(`  ✓ ${k.id} (${k.providerSetting.provider} / ${k.name}): migrated`);
    } catch (err) {
      failed += 1;
      failures.push({ id: k.id, reason: (err as Error).message });
      console.log(`  ✗ ${k.id} (${k.providerSetting.provider} / ${k.name}): DB update failed — ${(err as Error).message}`);
    }
  }

  console.log("\n--- Migration summary ---");
  console.log(`Total keys       : ${keys.length}`);
  console.log(`Already new      : ${alreadyNew}`);
  console.log(`Migrated         : ${migrated}`);
  console.log(`Failed           : ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f.id}: ${f.reason}`);
  }

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
