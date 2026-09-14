import { withDatabase } from "../db/postgres";

export async function finalizeMigrationIfComplete(
  env: Env,
  migrationId: string,
) {
  return withDatabase(env, async (client) => {
    const result = await client.query(
      `
        WITH counts AS (
          SELECT
            COUNT(*) FILTER (
              WHERE status = 'completed'
            )::bigint AS completed_count,
            COUNT(*) FILTER (
              WHERE status = 'failed'
            )::bigint AS failed_count,
            COUNT(*) FILTER (
              WHERE status = 'reconciliation_expired'
            )::bigint AS reconciliation_expired_count
          FROM google_drive_account_migration_items
          WHERE migration_id = $1
        )
        UPDATE google_drive_account_migrations m
        SET
          completed_files = counts.completed_count,
          failed_files =
            counts.failed_count +
            counts.reconciliation_expired_count,
          status = CASE
            WHEN counts.failed_count +
                 counts.reconciliation_expired_count > 0
              THEN 'failed'
            WHEN counts.completed_count >= m.total_files
              THEN 'completed'
            ELSE m.status
          END,
          current_file_id = CASE
            WHEN counts.failed_count +
                 counts.reconciliation_expired_count > 0
              OR counts.completed_count >= m.total_files
              THEN NULL
            ELSE m.current_file_id
          END,
          finished_at = CASE
            WHEN counts.failed_count +
                 counts.reconciliation_expired_count > 0
              OR counts.completed_count >= m.total_files
              THEN COALESCE(m.finished_at, NOW())
            ELSE m.finished_at
          END,
          updated_at = NOW()
        FROM counts
        WHERE m.id = $1
          AND m.status IN (
            'pending',
            'running',
            'waiting_for_storage'
          )
        RETURNING
          m.id,
          m.status,
          m.total_files,
          m.completed_files,
          m.failed_files,
          m.finished_at
      `,
      [migrationId],
    );

    return result.rows[0] ?? null;
  });
}
