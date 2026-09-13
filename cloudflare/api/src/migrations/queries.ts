import { withDatabase } from "../db/postgres";

export type MigrationItem = {
  id: string;
  migration_id: string;
  source_file_id: string;
  target_file_id: string | null;
  target_account_id: string | null;
  status: string;
  transfer_phase: string | null;
  size_bytes: string | null;
  bytes_transferred: string | null;
  speed_bytes_per_second: number;
  target_recovery_required: boolean;
  upload_session_uri_encrypted: string | null;
  upload_bytes_committed: string;
  upload_total_bytes: string;
  reconciliation_deadline: string | null;
  next_retry_at: string | null;
  lease_generation: string;
  lease_expires_at: string | null;
};

export type Migration = {
  id: string;
  status: string;
  source_account_id: string;
  target_account_id: string | null;
  cancel_requested: boolean;
};

export async function getMigration(
  env: Env,
  migrationId: string,
): Promise<Migration | null> {
  return withDatabase(env, async (client) => {
    const result = await client.query<Migration>(
      `
      SELECT
        id,
        status,
        source_account_id,
        target_account_id,
        cancel_requested
      FROM google_drive_account_migrations
      WHERE id = $1
      LIMIT 1
      `,
      [migrationId],
    );

    return result.rows[0] ?? null;
  });
}

export async function getMigrationItem(
  env: Env,
  itemId: string,
): Promise<MigrationItem | null> {
  return withDatabase(env, async (client) => {
    const result = await client.query<MigrationItem>(
      `
      SELECT
        id,
        migration_id,
        source_file_id,
        target_file_id,
        target_account_id,
        status,
        transfer_phase,
        size_bytes,
        bytes_transferred,
        speed_bytes_per_second,
        target_recovery_required,
        upload_session_uri_encrypted,
        upload_bytes_committed,
        upload_total_bytes,
        reconciliation_deadline,
        next_retry_at,
        lease_generation,
        lease_expires_at
      FROM google_drive_account_migration_items
      WHERE id = $1
      LIMIT 1
      `,
      [itemId],
    );

    return result.rows[0] ?? null;
  });
}
