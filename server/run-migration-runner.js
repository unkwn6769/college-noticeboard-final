import { runSchemaMigrations } from "./db/migrate.js";
import { pool, closeDatabase } from "./db/database.js";
import { startMigrationScheduler, stopMigrationScheduler } from "./migrationScheduler.js";

await runSchemaMigrations();
const scheduler = startMigrationScheduler();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stopMigrationScheduler();
  await scheduler;
  await closeDatabase();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

const idleTimeout = Number(process.env.MIGRATION_RUNNER_IDLE_TIMEOUT_MS || 300_000);
const startedAt = Date.now();
while (!stopping && Date.now() - startedAt < idleTimeout) {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM google_drive_account_migrations
    WHERE status IN ('pending', 'running', 'waiting_for_storage')
      AND cancel_requested = FALSE
  `);
  if (Number(result.rows[0]?.count || 0) === 0) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

await shutdown();
