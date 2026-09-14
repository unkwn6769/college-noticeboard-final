import { withTransaction } from "../db/postgres";

export type ClaimedMigrationItem = {
  id: string;
  migration_id: string;
  source_file_id: string;
  target_file_id: string | null;
  target_account_id: string | null;
  size_bytes: string;
  bytes_transferred: string;
  transfer_phase: string | null;
  target_recovery_required: boolean;
  reconciliation_deadline: string | null;
  started_at: string | null;
  status: string;
  lease_generation: string;
  lease_expires_at: string | null;
  error_message: string | null;
  upload_session_uri_encrypted: string | null;
  upload_bytes_committed: string;
  upload_total_bytes: string;
};

const CLAIM_LEASE_MINUTES = 5;

type ClaimSelector =
  | {
      kind: "next";
      migrationId: string;
    }
  | {
      kind: "exact";
      migrationId: string;
      itemId: string;
    };

function buildClaimSelect(selector: ClaimSelector): {
  sql: string;
  params: string[];
} {
  if (selector.kind === "exact") {
    return {
      sql: `
        SELECT
          id,
          migration_id,
          source_file_id,
          target_file_id,
          target_account_id,
          size_bytes,
          bytes_transferred,
          speed_bytes_per_second,
          upload_session_uri_encrypted,
          upload_bytes_committed,
          upload_total_bytes,
          transfer_phase,
          target_recovery_required,
          reconciliation_deadline,
          started_at,
          lease_generation,
          error_message,
          status
        FROM google_drive_account_migration_items
        WHERE migration_id = $1
          AND id = $2
          AND (
            status IN ('pending', 'reconciling')
            OR (
              status = 'running'
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at <= NOW()
            )
          )
          AND (
            next_retry_at IS NULL
            OR next_retry_at <= NOW()
          )
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `,
      params: [selector.migrationId, selector.itemId],
    };
  }

  return {
    sql: `
      SELECT
        id,
        migration_id,
        source_file_id,
        target_file_id,
        target_account_id,
        size_bytes,
        bytes_transferred,
        speed_bytes_per_second,
        upload_session_uri_encrypted,
        upload_bytes_committed,
        upload_total_bytes,
        transfer_phase,
        target_recovery_required,
        reconciliation_deadline,
        started_at,
        lease_generation,
        error_message,
        status
      FROM google_drive_account_migration_items
      WHERE migration_id = $1
        AND status IN ('pending', 'reconciling')
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
      ORDER BY
        CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
        created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `,
    params: [selector.migrationId],
  };
}

export async function claimItem(
  env: Env,
  selector: ClaimSelector,
): Promise<ClaimedMigrationItem | null> {
  return withTransaction(env, async (client) => {
    const selection = buildClaimSelect(selector);

    const result = await client.query<
      ClaimedMigrationItem & {
        status: "pending" | "reconciling";
      }
    >(selection.sql, selection.params);

    if (result.rows.length === 0) {
      return null;
    }

    const item = result.rows[0];

    if (
      item.status === "reconciling" &&
      item.reconciliation_deadline &&
      new Date(item.reconciliation_deadline).getTime() <= Date.now()
    ) {
      const expired = await client.query<ClaimedMigrationItem>(
        `
        UPDATE google_drive_account_migration_items
        SET
          status = 'reconciliation_expired',
          transfer_phase = 'reconciliation_expired',
          target_recovery_required = TRUE,
          error_message = 'Reconciliation deadline reached; manual intervention required',
          next_retry_at = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
        WHERE id = $1
          AND lease_generation = $2
          AND status = 'reconciling'
          AND reconciliation_deadline IS NOT NULL
          AND reconciliation_deadline <= NOW()
        RETURNING
          id,
          migration_id,
          source_file_id,
          target_file_id,
          target_account_id,
          size_bytes,
          bytes_transferred,
          speed_bytes_per_second,
          upload_session_uri_encrypted,
          upload_bytes_committed,
          upload_total_bytes,
          transfer_phase,
          target_recovery_required,
          reconciliation_deadline,
          started_at,
          status,
          lease_generation,
          lease_expires_at,
          error_message
        `,
        [item.id, item.lease_generation],
      );

      return expired.rows[0] ?? null;
    }

    const claimed = await client.query<ClaimedMigrationItem>(
      `
      UPDATE google_drive_account_migration_items
      SET
  status = 'running',
  lease_generation = lease_generation + 1,
  lease_expires_at =
    NOW() + INTERVAL '${CLAIM_LEASE_MINUTES} minutes',

  reserved_bytes = 0,

  started_at = COALESCE(started_at, NOW()),
  finished_at = NULL,

  bytes_transferred =
    CASE
      WHEN target_file_id IS NOT NULL
        THEN bytes_transferred
      WHEN upload_session_uri_encrypted IS NOT NULL
        OR upload_bytes_committed > 0
        THEN GREATEST(
          bytes_transferred,
          upload_bytes_committed
        )
      ELSE 0
    END,

  speed_bytes_per_second =
    CASE
      WHEN status = 'pending'
        AND bytes_transferred = 0
        AND upload_bytes_committed = 0
        THEN 0
      ELSE speed_bytes_per_second
    END,

  target_recovery_required =
    CASE
      WHEN status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= NOW()
        THEN CASE
          WHEN upload_session_uri_encrypted IS NOT NULL
            OR upload_bytes_committed > 0
            THEN FALSE
          ELSE TRUE
        END
      ELSE target_recovery_required
    END,

  transfer_phase =
    CASE
      WHEN status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= NOW()
        AND (
          upload_session_uri_encrypted IS NOT NULL
          OR upload_bytes_committed > 0
        )
        THEN 'uploading'
      WHEN status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= NOW()
        THEN 'reconciling'
      WHEN target_file_id IS NOT NULL
        THEN 'verifying'
      WHEN status = 'reconciling'
        THEN 'reconciling'
      WHEN upload_session_uri_encrypted IS NOT NULL
        OR upload_bytes_committed > 0
        THEN 'uploading'
      ELSE 'downloading'
    END,

  reconciliation_deadline =
    CASE
      WHEN status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= NOW()
        AND (
          upload_session_uri_encrypted IS NOT NULL
          OR upload_bytes_committed > 0
        )
        THEN NULL
      WHEN status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= NOW()
        THEN COALESCE(
          reconciliation_deadline,
          NOW() + INTERVAL '10 minutes'
        )
      WHEN status = 'reconciling'
        THEN reconciliation_deadline
      ELSE NULL
    END,

  next_retry_at =
    CASE
      WHEN status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= NOW()
        AND (
          upload_session_uri_encrypted IS NOT NULL
          OR upload_bytes_committed > 0
        )
        THEN NULL
      WHEN status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= NOW()
        THEN NOW()
      WHEN status = 'reconciling'
        THEN next_retry_at
      ELSE NULL
    END,

  updated_at = NOW(),
  error_message = NULL
      WHERE id = $1
        AND (
          status IN ('pending', 'reconciling')
          OR (
            status = 'running'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= NOW()
          )
        )
      RETURNING
        id,
        migration_id,
        source_file_id,
        target_file_id,
        target_account_id,
        size_bytes,
        bytes_transferred,
        speed_bytes_per_second,
        upload_session_uri_encrypted,
        upload_bytes_committed,
        upload_total_bytes,
        transfer_phase,
        target_recovery_required,
        reconciliation_deadline,
        started_at,
        status,
        lease_generation,
        lease_expires_at,
        error_message
      `,
      [item.id],
    );

    return claimed.rows[0] ?? null;
  });
}

export async function claimNextItem(
  env: Env,
  migrationId: string,
): Promise<ClaimedMigrationItem | null> {
  return claimItem(env, {
    kind: "next",
    migrationId,
  });
}

export async function claimExactItem(
  env: Env,
  migrationId: string,
  itemId: string,
): Promise<ClaimedMigrationItem | null> {
  return claimItem(env, {
    kind: "exact",
    migrationId,
    itemId,
  });
}
