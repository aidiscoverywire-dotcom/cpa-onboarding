/**
 * Migration runner: applies db/migrations/*.sql in filename order.
 *
 * Usage: npm run db:migrate   (DATABASE_URL must be set)
 *
 * - Tracks applied migrations in `schema_migrations` (created on first run).
 * - Each migration runs inside its own transaction; a failed migration rolls
 *   back and aborts the run with a non-zero exit.
 * - Idempotent: already-applied versions are skipped.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";

const MIGRATIONS_DIR = resolve(__dirname, "..", "db", "migrations");

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set.");
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    if (files.length === 0) {
      console.log("No migrations found.");
      return;
    }

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const seen = await client.query(
        `SELECT 1 FROM schema_migrations WHERE version = $1`,
        [version],
      );
      if ((seen.rowCount ?? 0) > 0) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }
      console.log(`apply ${file}`);
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (version) VALUES ($1)`,
          [version],
        );
        await client.query("COMMIT");
        console.log(`done  ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    console.log("Migrations complete.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
