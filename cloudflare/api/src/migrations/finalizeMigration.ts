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
            COUNT(*)::bigint AS item_count,
            COUNT(*) FILTER (
              WHERE status = 'completed'
            )::bigint AS completed_count,
            COUNT(*) FILTER (
              WHERE status = 'failed'
            )::bigint AS failed_count,
            COUNT(*) FILTER (
              WHERE status = 'reconciliation_expired'
            )::bigint AS reconciliation_expired_count,
            COUNT(*) FILTER (
              WHERE status IN (
                'completed',
                'failed',
                'reconciliation_expired',
                'cancelled'
              )
            )::bigint AS terminal_count,
            MAX(source_file_id) FILTER (
              WHERE status IN (
                'pending',
                'running',
                'reconciling'
              )
            ) AS active_file_id,
            MIN(error_message) FILTER (
              WHERE status IN (
                'failed',
                'reconciliation_expired'
              )
              AND error_message IS NOT NULL
            ) AS representative_error
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
            WHEN counts.item_count = m.total_files
              AND counts.terminal_count = m.total_files
              AND counts.failed_count +
                  counts.reconciliation_expired_count > 0
              THEN 'failed'
            WHEN counts.item_count = m.total_files
              AND counts.completed_count >= m.total_files
              THEN 'completed'
            ELSE m.status
          END,
          current_file_id = CASE
            WHEN counts.item_count = m.total_files
              AND counts.terminal_count = m.total_files
              THEN NULL
            ELSE COALESCE(counts.active_file_id, m.current_file_id)
          END,
          finished_at = CASE
            WHEN counts.item_count = m.total_files
              AND counts.terminal_count = m.total_files
              THEN COALESCE(m.finished_at, NOW())
            ELSE m.finished_at
          END,
          error_message = CASE
            WHEN counts.item_count = m.total_files
              AND counts.terminal_count = m.total_files
              AND counts.failed_count +
                  counts.reconciliation_expired_count > 0
              THEN COALESCE(m.error_message, counts.representative_error)
            ELSE m.error_message
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
