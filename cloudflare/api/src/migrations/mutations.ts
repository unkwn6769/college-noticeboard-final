import { withDatabase } from "../db/postgres";

export class FencedMigrationItemError extends Error {
  constructor(itemId: string) {
    super(`Migration item ${itemId} was fenced`);
    this.name = "FencedMigrationItemError";
  }
}

async function fencedUpdate(
  env: Env,
  itemId: string,
  leaseGeneration: string,
  sql: string,
  params: unknown[],
): Promise<void> {
  const result = await withDatabase(env, async (client) => {
    return client.query(sql, params);
  });

  if (result.rowCount !== 1) {
    throw new FencedMigrationItemError(itemId);
  }
}

export async function persistTargetFileId(
  env: Env,
  itemId: string,
  leaseGeneration: string,
  targetFileId: string,
): Promise<void> {
  await fencedUpdate(
    env,
    itemId,
    leaseGeneration,
    `
      UPDATE google_drive_account_migration_items
      SET
        target_file_id = $1,
        target_recovery_required = FALSE,
        transfer_phase = 'verifying',
        updated_at = NOW()
      WHERE id = $2
        AND lease_generation = $3
        AND status = 'running'
    `,
    [
      targetFileId,
      itemId,
      leaseGeneration,
    ],
  );
}

export async function markCompleted(
  env: Env,
  itemId: string,
  leaseGeneration: string,
  targetFileId: string,
): Promise<void> {
  await fencedUpdate(
    env,
    itemId,
    leaseGeneration,
    `
      UPDATE google_drive_account_migration_items
      SET
        status = 'completed',
        target_file_id = $1,
        reserved_bytes = 0,
        bytes_transferred = size_bytes,
        speed_bytes_per_second = 0,
        transfer_phase = 'completed',
        upload_session_uri_encrypted = NULL,
        upload_bytes_committed = 0,
        upload_total_bytes = 0,
        finished_at = NOW(),
        updated_at = NOW(),
        error_message = NULL
      WHERE id = $2
        AND lease_generation = $3
        AND status = 'running'
    `,
    [
      targetFileId,
      itemId,
      leaseGeneration,
    ],
  );
}

export async function markFailed(
  env: Env,
  itemId: string,
  leaseGeneration: string,
  errorMessage: string,
): Promise<void> {
  await fencedUpdate(
    env,
    itemId,
    leaseGeneration,
    `
      UPDATE google_drive_account_migration_items
      SET
        status = 'failed',
        reserved_bytes = 0,
        transfer_phase = 'failed',
        error_message = $1,
        finished_at = NOW(),
        updated_at = NOW()
      WHERE id = $2
        AND lease_generation = $3
        AND status = 'running'
    `,
    [
      errorMessage,
      itemId,
      leaseGeneration,
    ],
  );
}

export async function incrementRetryCount(
  env: Env,
  itemId: string,
  leaseGeneration: string,
): Promise<number> {
  const result = await withDatabase(env, async (client) => {
    return client.query<{ retry_count: number }>(
      `
      UPDATE google_drive_account_migration_items
      SET
        retry_count = retry_count + 1,
        last_retry_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
        AND lease_generation = $2
      RETURNING retry_count
      `,
      [itemId, leaseGeneration],
    );
  });

  if (result.rowCount !== 1) {
    throw new FencedMigrationItemError(itemId);
  }

  return Number(result.rows[0].retry_count);
}

export async function clearRetryCount(
  env: Env,
  itemId: string,
  leaseGeneration: string,
): Promise<void> {
  await fencedUpdate(
    env,
    itemId,
    leaseGeneration,
    `
      UPDATE google_drive_account_migration_items
      SET
        retry_count = 0,
        last_retry_at = NULL,
        next_retry_at = NULL,
        updated_at = NOW()
      WHERE id = $1
        AND lease_generation = $2
    `,
    [itemId, leaseGeneration],
  );
}

export async function requeueAfterTransientFailure(
  env: Env,
  itemId: string,
  leaseGeneration: string,
  errorMessage: string,
  delayMs: number,
): Promise<void> {
  await fencedUpdate(
    env,
    itemId,
    leaseGeneration,
    `
      UPDATE google_drive_account_migration_items
      SET
        status = 'pending',
        reserved_bytes = 0,
        error_message = $1,
        started_at = NULL,
        finished_at = NULL,
        bytes_transferred =
          CASE
            WHEN target_file_id IS NOT NULL
              THEN bytes_transferred
            ELSE 0
          END,
        transfer_phase =
          CASE
            WHEN target_file_id IS NOT NULL
              THEN 'verifying'
            WHEN upload_session_uri_encrypted IS NOT NULL
              OR upload_bytes_committed > 0
              THEN 'uploading'
            ELSE 'pending'
          END,
        next_retry_at =
          NOW() + ($3 * INTERVAL '1 millisecond'),
        lease_expires_at = NULL,
        updated_at = NOW()
      WHERE id = $2
        AND lease_generation = $4
    `,
    [
      errorMessage,
      itemId,
      delayMs,
      leaseGeneration,
    ],
  );
}

export async function requeueAfterStorageWait(
  env: Env,
  itemId: string,
  leaseGeneration: string,
  errorMessage: string,
): Promise<void> {
  await fencedUpdate(
    env,
    itemId,
    leaseGeneration,
    `
      UPDATE google_drive_account_migration_items
      SET
        status = 'pending',
        reserved_bytes = 0,
        error_message = $1,
        started_at = NULL,
        finished_at = NULL,
        bytes_transferred =
          CASE
            WHEN target_file_id IS NOT NULL
              THEN bytes_transferred
            ELSE 0
          END,
        transfer_phase =
          CASE
            WHEN target_file_id IS NOT NULL
              THEN 'verifying'
            WHEN upload_session_uri_encrypted IS NOT NULL
              OR upload_bytes_committed > 0
              THEN 'uploading'
            ELSE 'pending'
          END,
        next_retry_at =
          NOW() + INTERVAL '30 seconds',
        lease_expires_at = NULL,
        updated_at = NOW()
      WHERE id = $2
        AND lease_generation = $3
    `,
    [
      errorMessage,
      itemId,
      leaseGeneration,
    ],
  );
}

export async function markReconciling(
  env: Env,
  itemId: string,
  leaseGeneration: string,
  errorMessage: string,
  deadlineMs = 10 * 60 * 1000,
  retryDelayMs = 2000,
): Promise<void> {
  await fencedUpdate(
    env,
    itemId,
    leaseGeneration,
    `
      UPDATE google_drive_account_migration_items
      SET
        status = 'reconciling',
        target_recovery_required = TRUE,
        reconciliation_deadline = COALESCE(
          reconciliation_deadline,
          NOW() + ($1 * INTERVAL '1 millisecond')
        ),
        error_message = $2,
        transfer_phase = 'reconciling',
        next_retry_at =
          NOW() + ($3 * INTERVAL '1 millisecond'),
        lease_expires_at = NULL,
        updated_at = NOW()
      WHERE id = $4
        AND lease_generation = $5
    `,
    [
      deadlineMs,
      errorMessage,
      retryDelayMs,
      itemId,
      leaseGeneration,
    ],
  );
}

export async function markReconciliationExpired(
  env: Env,
  itemId: string,
  leaseGeneration: string,
  errorMessage =
    "Reconciliation deadline reached; manual intervention required",
): Promise<void> {
  await fencedUpdate(
    env,
    itemId,
    leaseGeneration,
    `
      UPDATE google_drive_account_migration_items
      SET
        status = 'reconciliation_expired',
        transfer_phase = 'reconciliation_expired',
        target_recovery_required = TRUE,
        error_message = $1,
        next_retry_at = NULL,
        lease_expires_at = NULL,
        updated_at = NOW()
      WHERE id = $2
        AND lease_generation = $3
    `,
    [
      errorMessage,
      itemId,
      leaseGeneration,
    ],
  );
}

export async function persistRecoveredTarget(
  env: Env,
  itemId: string,
  leaseGeneration: string,
  targetFileId: string,
  sizeBytes: string | number | bigint,
): Promise<void> {
  await fencedUpdate(
    env,
    itemId,
    leaseGeneration,
    `
      UPDATE google_drive_account_migration_items
      SET
        target_file_id = $1,
        target_recovery_required = FALSE,
        bytes_transferred = $2,
        speed_bytes_per_second = 0,
        transfer_phase = 'verifying',
        next_retry_at = NULL,
        updated_at = NOW()
      WHERE id = $3
        AND lease_generation = $4
    `,
    [
      targetFileId,
      sizeBytes,
      itemId,
      leaseGeneration,
    ],
  );
}

export async function markAccountAuthorizationInvalid(
  env: Env,
  accountId: string,
): Promise<void> {
  await withDatabase(env, async (client) => {
    await client.query(
      `
      UPDATE google_drive_accounts
      SET
        status = 'authorization_invalid',
        updated_at = NOW()
      WHERE id = $1
        AND status <> 'authorization_invalid'
      `,
      [accountId],
    );
  });
}

export async function persistUploadSession(
  env: Env,
  itemId: string,
  leaseGeneration: string,
  encryptedSessionUri: string,
  totalBytes: string | number | bigint,
): Promise<void> {
  await fencedUpdate(
    env,
    itemId,
    leaseGeneration,
    `
      UPDATE google_drive_account_migration_items
      SET
        upload_session_uri_encrypted = $1,
        upload_bytes_committed = 0,
        upload_total_bytes = $2,
        updated_at = NOW()
      WHERE id = $3
        AND lease_generation = $4
        AND status = 'running'
    `,
    [
      encryptedSessionUri,
      totalBytes,
      itemId,
      leaseGeneration,
    ],
  );
}

export async function persistUploadProgress(
  env: Env,
  itemId: string,
  leaseGeneration: string,
  bytesCommitted: string | number | bigint,
): Promise<void> {
  await fencedUpdate(
    env,
    itemId,
    leaseGeneration,
    `
      UPDATE google_drive_account_migration_items
      SET
        upload_bytes_committed = $1,
        bytes_transferred = $1,
        transfer_phase = 'uploading',
        updated_at = NOW()
      WHERE id = $2
        AND lease_generation = $3
        AND status = 'running'
    `,
    [
      bytesCommitted,
      itemId,
      leaseGeneration,
    ],
  );
}

export async function clearUploadSession(
  env: Env,
  itemId: string,
  leaseGeneration: string,
): Promise<void> {
  await fencedUpdate(
    env,
    itemId,
    leaseGeneration,
    `
      UPDATE google_drive_account_migration_items
      SET
        upload_session_uri_encrypted = NULL,
        upload_bytes_committed = 0,
        upload_total_bytes = 0,
        updated_at = NOW()
      WHERE id = $1
        AND lease_generation = $2
    `,
    [
      itemId,
      leaseGeneration,
    ],
  );
}
