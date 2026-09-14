import type { GoogleDriveAccount } from "../google/accounts";
import {
  type Migration,
  type MigrationItem,
} from "./queries";
import { withDatabase } from "../db/postgres";

type MigrationContextRow = {
  migration_id: string;
  migration_status: string;
  source_account_id: string;
  migration_target_account_id: string | null;
  cancel_requested: boolean;
  id: string;
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
  source_email: string;
  source_client_id_encrypted: string;
  source_client_secret_encrypted: string;
  source_access_token_encrypted: string;
  source_refresh_token_encrypted: string;
  source_token_expires_at: string | null;
  source_redirect_uri: string | null;
  source_status: string;
  target_email: string;
  target_client_id_encrypted: string;
  target_client_secret_encrypted: string;
  target_access_token_encrypted: string;
  target_refresh_token_encrypted: string;
  target_token_expires_at: string | null;
  target_redirect_uri: string | null;
  target_status: string;
};

export type MigrationContext = {
  migration: Migration;
  item: MigrationItem;
  sourceAccount: GoogleDriveAccount;
  targetAccount: GoogleDriveAccount;
};

export async function loadMigrationContext(
  env: Env,
  migrationId: string,
  itemId: string,
): Promise<MigrationContext> {
  const context = await withDatabase(env, async (client) => {
    const result = await client.query<MigrationContextRow>(
      `
        SELECT
          m.id AS migration_id,
          m.status AS migration_status,
          m.source_account_id,
          m.target_account_id AS migration_target_account_id,
          m.cancel_requested,
          i.id,
          i.migration_id,
          i.source_file_id,
          i.target_file_id,
          i.target_account_id,
          i.status,
          i.transfer_phase,
          i.size_bytes,
          i.bytes_transferred,
          i.speed_bytes_per_second,
          i.target_recovery_required,
          i.upload_session_uri_encrypted,
          i.upload_bytes_committed,
          i.upload_total_bytes,
          i.reconciliation_deadline,
          i.next_retry_at,
          i.lease_generation,
          i.lease_expires_at,
          source.email AS source_email,
          source.client_id_encrypted AS source_client_id_encrypted,
          source.client_secret_encrypted AS source_client_secret_encrypted,
          source.access_token_encrypted AS source_access_token_encrypted,
          source.refresh_token_encrypted AS source_refresh_token_encrypted,
          source.token_expires_at AS source_token_expires_at,
          source.redirect_uri AS source_redirect_uri,
          source.status AS source_status,
          target.email AS target_email,
          target.client_id_encrypted AS target_client_id_encrypted,
          target.client_secret_encrypted AS target_client_secret_encrypted,
          target.access_token_encrypted AS target_access_token_encrypted,
          target.refresh_token_encrypted AS target_refresh_token_encrypted,
          target.token_expires_at AS target_token_expires_at,
          target.redirect_uri AS target_redirect_uri,
          target.status AS target_status
        FROM google_drive_account_migration_items i
        JOIN google_drive_account_migrations m
          ON m.id = i.migration_id
        JOIN google_drive_accounts source
          ON source.id = m.source_account_id
        JOIN google_drive_accounts target
          ON target.id = COALESCE(i.target_account_id, m.target_account_id)
        WHERE m.id = $1
          AND i.id = $2
        LIMIT 1
      `,
      [migrationId, itemId],
    );

    return result.rows[0] ?? null;
  });

  if (!context) {
    throw new Error("Migration context not found");
  }

  const migration: Migration = {
    id: context.migration_id,
    status: context.migration_status,
    source_account_id: context.source_account_id,
    target_account_id: context.migration_target_account_id,
    cancel_requested: context.cancel_requested,
  };

  const item: MigrationItem = {
    id: context.id,
    migration_id: context.migration_id,
    source_file_id: context.source_file_id,
    target_file_id: context.target_file_id,
    target_account_id: context.target_account_id,
    status: context.status,
    transfer_phase: context.transfer_phase,
    size_bytes: context.size_bytes,
    bytes_transferred: context.bytes_transferred,
    speed_bytes_per_second: context.speed_bytes_per_second,
    target_recovery_required: context.target_recovery_required,
    upload_session_uri_encrypted: context.upload_session_uri_encrypted,
    upload_bytes_committed: context.upload_bytes_committed,
    upload_total_bytes: context.upload_total_bytes,
    reconciliation_deadline: context.reconciliation_deadline,
    next_retry_at: context.next_retry_at,
    lease_generation: context.lease_generation,
    lease_expires_at: context.lease_expires_at,
  };

  const sourceAccount: GoogleDriveAccount = {
    id: migration.source_account_id,
    email: context.source_email,
    client_id_encrypted: context.source_client_id_encrypted,
    client_secret_encrypted: context.source_client_secret_encrypted,
    access_token_encrypted: context.source_access_token_encrypted,
    refresh_token_encrypted: context.source_refresh_token_encrypted,
    token_expires_at: context.source_token_expires_at,
    redirect_uri: context.source_redirect_uri,
    status: context.source_status,
  };

  if (sourceAccount.status !== "connected") {
    throw new Error(
      "Source Google Drive account is not connected",
    );
  }

  const targetAccountId =
    item.target_account_id ??
    migration.target_account_id;

  if (!targetAccountId) {
    throw new Error(
      "Target Google Drive account is not assigned",
    );
  }

  if (targetAccountId === migration.source_account_id) {
    throw new Error(
      "Source and target Google Drive accounts must differ",
    );
  }

  const targetAccount: GoogleDriveAccount = {
    id: targetAccountId,
    email: context.target_email,
    client_id_encrypted: context.target_client_id_encrypted,
    client_secret_encrypted: context.target_client_secret_encrypted,
    access_token_encrypted: context.target_access_token_encrypted,
    refresh_token_encrypted: context.target_refresh_token_encrypted,
    token_expires_at: context.target_token_expires_at,
    redirect_uri: context.target_redirect_uri,
    status: context.target_status,
  };

  if (targetAccount.status !== "connected") {
    throw new Error(
      "Target Google Drive account is not connected",
    );
  }

  return {
    migration,
    item,
    sourceAccount,
    targetAccount,
  };
}
