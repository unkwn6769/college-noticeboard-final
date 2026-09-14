import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./database.js";

const migrationsDirectory = path.dirname(fileURLToPath(import.meta.url)) + "/migrations";

export async function runSchemaMigrations() {
  const files = (await fs.readdir(migrationsDirectory))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const file of files) {
    const version = file.split("_", 1)[0];
    const applied = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [version],
    );
    if (applied.rowCount) continue;

    const sql = await fs.readFile(path.join(migrationsDirectory, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(version) VALUES ($1)",
        [version],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`Schema migration ${file} failed: ${error.message}`, { cause: error });
    } finally {
      client.release();
    }
  }
}
