import assert from "node:assert/strict";
import test from "node:test";

import { pool } from "./database.js";
import { runSchemaMigrations } from "./migrate.js";

test("tracked migration creates runtime item columns on existing tables", async (t) => {
  if (!process.env.DATABASE_URL) {
    t.skip("DATABASE_URL is required for database-backed migration tests");
    return;
  }

  t.after(() => pool.end());

  await runSchemaMigrations();

  const result = await pool.query(
    `
      SELECT column_name, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'google_drive_account_migration_items'
        AND column_name IN ('bytes_transferred', 'transfer_phase')
      ORDER BY column_name
    `,
  );

  assert.deepEqual(
    result.rows,
    [
      {
        column_name: "bytes_transferred",
        column_default: "0",
        is_nullable: "NO",
      },
      {
        column_name: "transfer_phase",
        column_default: "'pending'::text",
        is_nullable: "NO",
      },
    ],
  );

  const migration = await pool.query(
    "SELECT 1 FROM schema_migrations WHERE version = '001'",
  );
  assert.equal(migration.rowCount, 1);
});
