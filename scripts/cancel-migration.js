import { pool } from "../server/db/database.js";
import { finalizeCancellationIfIdle } from "../server/migrationWorker.js";

const migrationId = String(process.argv[2] || "").trim();

if (!migrationId) {
  console.error("Usage: node --env-file=.env scripts/cancel-migration.js <migration-id>");
  process.exit(1);
}

try {
  const result = await pool.query(
    `
      UPDATE google_drive_account_migrations
      SET
        cancel_requested = TRUE,
        updated_at = NOW()
      WHERE id = $1
        AND status IN ('pending', 'running', 'waiting_for_storage')
      RETURNING id, status, cancel_requested
    `,
    [migrationId]
  );

  if (result.rowCount === 0) {
    const current = await pool.query(
      `SELECT id, status, cancel_requested FROM google_drive_account_migrations WHERE id = $1`,
      [migrationId]
    );

    if (current.rowCount === 0) {
      throw new Error(`Migration ${migrationId} was not found`);
    }

    console.log("Migration was not active; current state:", current.rows[0]);
    process.exit(0);
  }

  console.log("Cancellation requested:", result.rows[0]);

  try {
    const finalized = await finalizeCancellationIfIdle(migrationId);
    console.log(`Finalized immediately: ${finalized}`);
  } catch (error) {
    console.error(
      "Immediate cancellation finalization could not complete; the scheduler/worker will converge it safely:",
      error instanceof Error ? error.message : error
    );
  }
} finally {
  await pool.end();
}
