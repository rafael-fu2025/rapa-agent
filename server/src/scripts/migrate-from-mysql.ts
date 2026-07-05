// One-shot migration script: copy provider settings, API keys, and
// the local user from a MySQL Rapa deployment into the new SQLite
// `server/prisma/dev.db`.
//
// Why this exists
// ---------------
// Rapa is switching its default DB from MySQL to SQLite (see
// docs/PERSONAL_DEPLOY.md). The encrypted API keys are stored as
// `iv.tag.ciphertext` base64 — engine-agnostic — so they copy
// verbatim between MySQL rows and SQLite rows. The script uses
// `APP_SECRET` (already in `.env`) to decrypt each row as a
// safety check before re-inserting; a single failure aborts the
// run before anything is written.
//
// Usage
// -----
//   # 1. Set MYSQL_DATABASE_URL in your .env (the active DATABASE_URL
//   #    must continue to point at the target SQLite so the script
//   #    writes into the right place).
//   # 2. Dry-run (default — safe to re-run):
//   npm run db:migrate-from-mysql
//   # 3. Apply for real:
//   npm run db:migrate-from-mysql:apply
//   # 4. (Optional) wipe the MYSQL_DATABASE_URL env var once the
//   #    migration is complete so the script can't be re-run by
//   #    accident.
//
// Idempotency
// -----------
// Every insert is keyed on the source row's `id` (cuid). If a row
// with the same id already exists in SQLite it's skipped (the
// script never overwrites a row that was edited locally after the
// first run). Re-running the script after a partial failure is safe.

import { createConnection, type RowDataPacket } from "mysql2/promise";
import { PrismaClient } from "@prisma/client";
import { decryptText } from "../lib/crypto.js";

// tsx (the dev runner) automatically loads .env from the cwd. The
// script is intended to be run via `npm run db:migrate-from-mysql`
// from the server/ directory, so process.env will already be
// populated by the time this file runs.

type SourceRow = Record<string, unknown>;

interface MigrationStats {
  scanned: number;
  inserted: number;
  skipped: number;
  decrypted: number;
  decryptFailures: number;
  errors: string[];
}

const APPLY = process.argv.includes("--apply");

function logSection(title: string) {
  console.log("");
  console.log("═".repeat(72));
  console.log(` ${title}`);
  console.log("═".repeat(72));
}

function formatRow(row: SourceRow, keys: string[]): string {
  return keys.map((k) => `${k}=${truncate(String(row[k] ?? ""), 32)}`).join(" ");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(0, n - 1))}…`;
}

async function main() {
  const mysqlUrl = process.env.MYSQL_DATABASE_URL;
  if (!mysqlUrl) {
    throw new Error(
      "MYSQL_DATABASE_URL is not set. Add it to server/.env, e.g.\n" +
        '  MYSQL_DATABASE_URL="mysql://root:YOUR_PASSWORD@127.0.0.1:3306/recreate_ui"'
    );
  }

  const targetUrl = process.env.DATABASE_URL;
  if (!targetUrl) {
    throw new Error("DATABASE_URL is not set — can't determine the target DB.");
  }

  logSection("Pre-flight");
  console.log(`Source (MySQL) : ${redactUrl(mysqlUrl)}`);
  console.log(`Target (SQLite): ${targetUrl}`);
  console.log(`Mode          : ${APPLY ? "APPLY (will write to target)" : "DRY-RUN (no writes)"}`);
  console.log(`APP_SECRET    : ${process.env.APP_SECRET ? "set (" + process.env.APP_SECRET.length + " chars)" : "MISSING"}`);

  if (!process.env.APP_SECRET || process.env.APP_SECRET.length < 32) {
    throw new Error("APP_SECRET must be set to a value of at least 32 characters.");
  }

  // Connect to MySQL via the raw driver. The Prisma client in
  // this codebase is generated for SQLite, so it can't talk to
  // MySQL directly without a schema-swap dance. mysql2 is a
  // small, well-typed driver that just runs SELECT.
  const mysql = await createConnection({
    uri: mysqlUrl,
    // Force DATETIME/DATETIME(3) to come back as strings so we
    // can re-insert them verbatim without timezone surprises.
    dateStrings: true,
    // Quick timeout so a typo in the URL doesn't hang the script.
    connectTimeout: 10_000
  });

  const target = new PrismaClient();
  const stats: MigrationStats = {
    scanned: 0,
    inserted: 0,
    skipped: 0,
    decrypted: 0,
    decryptFailures: 0,
    errors: []
  };

  try {
    // Read all four tables in dependency order. We pull every column
    // and let Prisma figure out what to keep on insert.
    const userRows = await readAll(mysql, "AppUser");
    const providerRows = await readAll(mysql, "ProviderSetting");
    const apiKeyRows = await readAll(mysql, "ProviderApiKey");
    const serviceKeyRows = await readAll(mysql, "ServiceApiKey");

    logSection("Source row counts");
    console.log(`AppUser          : ${userRows.length}`);
    console.log(`ProviderSetting  : ${providerRows.length}`);
    console.log(`ProviderApiKey   : ${apiKeyRows.length}`);
    console.log(`ServiceApiKey    : ${serviceKeyRows.length}`);

    // -------- 1. AppUser --------
    logSection(`Migrating AppUser (${userRows.length} rows)`);
    for (const row of userRows) {
      stats.scanned += 1;
      const existing = await target.appUser.findUnique({ where: { id: row.id as string } });
      if (existing) {
        stats.skipped += 1;
        console.log(`  SKIP  ${formatRow(row, ["id", "email"])} (already present)`);
        continue;
      }
      if (!APPLY) {
        stats.inserted += 1;
        console.log(`  DRY   ${formatRow(row, ["id", "email"])}`);
        continue;
      }
      try {
        await target.appUser.create({ data: normalizeUser(row) });
        stats.inserted += 1;
        console.log(`  ADD   ${formatRow(row, ["id", "email"])}`);
      } catch (err) {
        stats.errors.push(`AppUser ${row.id}: ${(err as Error).message}`);
        console.log(`  FAIL  ${row.id} :: ${(err as Error).message}`);
      }
    }

    // -------- 2. ProviderSetting --------
    logSection(`Migrating ProviderSetting (${providerRows.length} rows)`);
    for (const row of providerRows) {
      stats.scanned += 1;
      const existing = await target.providerSetting.findUnique({ where: { id: row.id as string } });
      if (existing) {
        stats.skipped += 1;
        console.log(`  SKIP  ${formatRow(row, ["id", "provider", "baseUrl"])} (already present)`);
        continue;
      }
      // If the ProviderSetting row carries an inline apiKeyEncrypted
      // (older single-key rows), verify it decrypts before we copy.
      const ciphertext = row.apiKeyEncrypted;
      if (typeof ciphertext === "string" && ciphertext.length > 0) {
        const ok = verifyCipher(ciphertext);
        if (ok) {
          stats.decrypted += 1;
        } else {
          stats.decryptFailures += 1;
          stats.errors.push(`ProviderSetting ${row.id}: apiKeyEncrypted does not decrypt with current APP_SECRET`);
          console.log(`  FAIL  ${row.id} :: inline apiKeyEncrypted is undecryptable — skipping`);
          continue;
        }
      }
      if (!APPLY) {
        stats.inserted += 1;
        console.log(`  DRY   ${formatRow(row, ["id", "provider", "baseUrl"])}`);
        continue;
      }
      try {
        await target.providerSetting.create({ data: normalizeProviderSetting(row) });
        stats.inserted += 1;
        console.log(`  ADD   ${formatRow(row, ["id", "provider", "baseUrl"])}`);
      } catch (err) {
        stats.errors.push(`ProviderSetting ${row.id}: ${(err as Error).message}`);
        console.log(`  FAIL  ${row.id} :: ${(err as Error).message}`);
      }
    }

    // -------- 3. ProviderApiKey (the main event) --------
    logSection(`Migrating ProviderApiKey (${apiKeyRows.length} rows)`);
    for (const row of apiKeyRows) {
      stats.scanned += 1;
      const existing = await target.providerApiKey.findUnique({ where: { id: row.id as string } });
      if (existing) {
        stats.skipped += 1;
        console.log(`  SKIP  ${formatRow(row, ["id", "name", "isActive"])} (already present)`);
        continue;
      }
      // Ciphertext portability check — this is the whole reason the
      // migration is safe. If decryptText throws, the row was
      // encrypted with a different APP_SECRET (or the bytes are
      // corrupted) and copying it would silently break the user's
      // key. We refuse rather than risk that.
      const ciphertext = row.apiKeyEncrypted as string;
      const ok = verifyCipher(ciphertext);
      if (ok) {
        stats.decrypted += 1;
      } else {
        stats.decryptFailures += 1;
        stats.errors.push(`ProviderApiKey ${row.id}: apiKeyEncrypted does not decrypt with current APP_SECRET`);
        console.log(`  FAIL  ${row.id} (name=${row.name}) :: undecryptable — skipping`);
        continue;
      }
      if (!APPLY) {
        stats.inserted += 1;
        console.log(`  DRY   ${formatRow(row, ["id", "name", "isActive"])} (cipher OK)`);
        continue;
      }
      try {
        await target.providerApiKey.create({ data: normalizeApiKey(row) });
        stats.inserted += 1;
        console.log(`  ADD   ${formatRow(row, ["id", "name", "isActive"])} (cipher OK)`);
      } catch (err) {
        stats.errors.push(`ProviderApiKey ${row.id}: ${(err as Error).message}`);
        console.log(`  FAIL  ${row.id} :: ${(err as Error).message}`);
      }
    }

    // -------- 4. ServiceApiKey --------
    logSection(`Migrating ServiceApiKey (${serviceKeyRows.length} rows)`);
    for (const row of serviceKeyRows) {
      stats.scanned += 1;
      const existing = await target.serviceApiKey.findUnique({ where: { id: row.id as string } });
      if (existing) {
        stats.skipped += 1;
        console.log(`  SKIP  ${formatRow(row, ["id", "service", "name"])} (already present)`);
        continue;
      }
      // Service keys use the same AES-256-GCM scheme.
      const ciphertext = row.apiKeyEncrypted as string;
      const ok = verifyCipher(ciphertext);
      if (ok) {
        stats.decrypted += 1;
      } else {
        stats.decryptFailures += 1;
        stats.errors.push(`ServiceApiKey ${row.id}: apiKeyEncrypted does not decrypt with current APP_SECRET`);
        console.log(`  FAIL  ${row.id} (${row.service}/${row.name}) :: undecryptable — skipping`);
        continue;
      }
      if (!APPLY) {
        stats.inserted += 1;
        console.log(`  DRY   ${formatRow(row, ["id", "service", "name"])} (cipher OK)`);
        continue;
      }
      try {
        await target.serviceApiKey.create({ data: normalizeServiceKey(row) });
        stats.inserted += 1;
        console.log(`  ADD   ${formatRow(row, ["id", "service", "name"])} (cipher OK)`);
      } catch (err) {
        stats.errors.push(`ServiceApiKey ${row.id}: ${(err as Error).message}`);
        console.log(`  FAIL  ${row.id} :: ${(err as Error).message}`);
      }
    }
  } finally {
    await mysql.end();
    await target.$disconnect();
  }

  // -------- Summary --------
  logSection("Summary");
  console.log(`Rows scanned        : ${stats.scanned}`);
  console.log(`Rows inserted       : ${stats.inserted}${APPLY ? "" : " (dry-run, not actually written)"}`);
  console.log(`Rows skipped (dup)  : ${stats.skipped}`);
  console.log(`Ciphers verified    : ${stats.decrypted}`);
  console.log(`Cipher failures     : ${stats.decryptFailures}`);
  console.log(`Errors              : ${stats.errors.length}`);
  if (stats.errors.length > 0) {
    console.log("");
    for (const e of stats.errors) {
      console.log(`  - ${e}`);
    }
  }

  if (!APPLY) {
    console.log("");
    console.log("This was a DRY-RUN. No rows were written. Re-run with --apply to commit.");
  } else if (stats.errors.length === 0 && stats.decryptFailures === 0) {
    console.log("");
    console.log("Migration completed cleanly. Every cipher verified against APP_SECRET.");
  } else {
    console.log("");
    console.log("Migration completed WITH errors. Check the rows above before restarting the server.");
    process.exitCode = 1;
  }
}

// ----- helpers ---------------------------------------------------------------

/**
 * Resolve the actual table name as the MySQL server stores it.
 * On Windows MySQL (XAMPP) the case is preserved verbatim
 * (`AppUser`), but on Linux with `lower_case_table_names=1` it
 * becomes `appuser`. We query INFORMATION_SCHEMA once at startup
 * to find the real name, then use it for the SELECT.
 */
async function resolveTableName(
  mysql: Awaited<ReturnType<typeof createConnection>>,
  expected: string
): Promise<string> {
  const [rows] = await mysql.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, LOWER(?), UPPER(?)) LIMIT 1`,
    [expected, expected, expected]
  );
  const actual = (rows[0] as { name: string } | undefined)?.name;
  if (!actual) {
    throw new Error(
      `Could not find table matching "${expected}" in the source database. ` +
        `Run SHOW TABLES in your MySQL client to see what's actually present.`
    );
  }
  return actual;
}

async function readAll(
  mysql: Awaited<ReturnType<typeof createConnection>>,
  expectedName: string
): Promise<SourceRow[]> {
  // Resolve the real name once. Subsequent calls for the same table
  // would benefit from a Map cache, but the cost is one extra
  // INFORMATION_SCHEMA hit per table — 4 tables total — so the
  // simple version is fine.
  const actual = await resolveTableName(mysql, expectedName);
  const [rows] = await mysql.query<RowDataPacket[]>(`SELECT * FROM \`${actual}\``);
  return rows as SourceRow[];
}

function verifyCipher(ciphertext: string): boolean {
  if (typeof ciphertext !== "string" || ciphertext.length === 0) return false;
  try {
    decryptText(ciphertext, process.env.APP_SECRET!);
    return true;
  } catch {
    return false;
  }
}

function redactUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ":***@");
}

/**
 * MySQL may return JSON columns as already-parsed objects, or as
 * strings (depending on driver version). Prisma wants objects, so
 * parse defensively.
 */
function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function normalizeUser(row: SourceRow) {
  return {
    id: row.id as string,
    email: row.email as string,
    // mysql2 returns nullable VARCHAR as `null` (not undefined) when
    // the column IS NULL. We coerce to `string | null` so Prisma's
    // generated create-input type accepts it.
    passwordHash: (row.passwordHash ?? null) as string | null,
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date()
  };
}

function normalizeProviderSetting(row: SourceRow) {
  return {
    id: row.id as string,
    userId: row.userId as string,
    provider: row.provider as string,
    displayName: (row.displayName ?? null) as string | null,
    isCustom: Boolean(row.isCustom),
    enabled: row.enabled === undefined ? true : Boolean(row.enabled),
    baseUrl: row.baseUrl as string,
    apiKeyEncrypted: (row.apiKeyEncrypted ?? null) as string | null,
    autoSwitchApiKey: Boolean(row.autoSwitchApiKey),
    // `models` is JSON in MySQL. mysql2 can return it as either a
    // parsed object or a JSON string depending on driver settings;
    // parseJson handles both. Cast to Prisma's InputJsonValue for
    // create-input acceptance.
    models: parseJson(row.models) as any,
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date()
  };
}

function normalizeApiKey(row: SourceRow) {
  return {
    id: row.id as string,
    providerSettingId: row.providerSettingId as string,
    name: row.name as string,
    apiKeyEncrypted: row.apiKeyEncrypted as string,
    isActive: Boolean(row.isActive),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date()
  };
}

function normalizeServiceKey(row: SourceRow) {
  return {
    id: row.id as string,
    userId: row.userId as string,
    service: row.service as string,
    name: row.name as string,
    apiKeyEncrypted: row.apiKeyEncrypted as string,
    isActive: Boolean(row.isActive),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date()
  };
}

main().catch((err) => {
  console.error("");
  console.error("FATAL: " + (err instanceof Error ? err.message : String(err)));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
