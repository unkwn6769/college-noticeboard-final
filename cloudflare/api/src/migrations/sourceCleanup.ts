import { getGoogleDriveAccount } from "../google/accounts";
import { deleteFile, getFile, DriveApiError } from "../google/drive";
import { getDriveAccessToken } from "../google/oauth";
import { withDatabase } from "../db/postgres";

type CleanupResult =
  | {
      status: "skipped" | "waiting" | "blocked" | "blocked_target_missing";
      itemId: string;
      reason?: string;
    }
  | {
      status: "failed";
      itemId: string;
      error: string;
    }
  | {
      status: "deleted";
      itemId: string;
      sourceFileId: string;
    };

type CleanupRow = {
  id: string;
  migration_id: string;
  source_file_id: string;
  target_file_id: string | null;
  target_account_id: string | null;
  source_delete_status: string;
  source_account_id: string;
};

function getGoogleErrorStatus(error: unknown): number | null {
  return error instanceof DriveApiError ? error.status : null;
}

export async function retrySourceCleanup(
  env: Env,
  itemId: string,
): Promise<CleanupResult> {
  const item = await withDatabase(env, async (client) => {
    const result = await client.query<CleanupRow>(
      `
        SELECT
          i.id,
          i.migration_id,
          i.source_file_id,
          i.target_file_id,
          i.target_account_id,
          i.source_delete_status,
          m.source_account_id
        FROM google_drive_account_migration_items i
        JOIN google_drive_account_migrations m
          ON m.id = i.migration_id
        WHERE i.id = $1
          AND i.status = 'completed'
          AND i.source_delete_status IN ('pending', 'failed')
        LIMIT 1
      `,
      [itemId],
    );

    return result.rows[0] ?? null;
  });

  if (!item) {
    return {
      status: "skipped",
      itemId,
      reason:
        "Migration item is not completed or is not eligible for source cleanup",
    };
  }

  if (
    !item.target_file_id ||
    !item.target_account_id ||
    item.target_account_id === item.source_account_id
  ) {
    return {
      status: "blocked",
      itemId,
      reason:
        "Target file/account is missing or invalid; source deletion refused",
    };
  }

  const sourceAccount = await getGoogleDriveAccount(
    env,
    item.source_account_id,
  );

  if (!sourceAccount || sourceAccount.status !== "connected") {
    return {
      status: "waiting",
      itemId,
      reason: "Source Google Drive account is not connected",
    };
  }

  const targetAccount = await getGoogleDriveAccount(
    env,
    item.target_account_id,
  );

  if (!targetAccount || targetAccount.status !== "connected") {
    return {
      status: "waiting",
      itemId,
      reason: "Target Google Drive account is not connected",
    };
  }

  const sourceAccessToken = await getDriveAccessToken(
    env,
    sourceAccount,
  );
  const targetAccessToken = await getDriveAccessToken(
    env,
    targetAccount,
  );

  try {
    const targetFile = await getFile(
      targetAccessToken,
      item.target_file_id,
      "id,name,size,mimeType,md5Checksum,appProperties,trashed",
    );

    if (targetFile.trashed) {
      return {
        status: "blocked",
        itemId,
        reason: "Target file is trashed; source deletion refused",
      };
    }

    const marker =
      targetFile.appProperties?.college_noticeboard_migration_item;

    if (marker !== item.id) {
      return {
        status: "blocked",
        itemId,
        reason:
          "Target file does not belong to this migration item; source deletion refused",
      };
    }

    const mappingExists = await withDatabase(env, async (client) => {
      const result = await client.query(
        `
          SELECT 1
          FROM resources
          WHERE storage_key = $1
            AND storage_provider = 'google_drive'
            AND storage_status = 'synced'
            AND EXISTS (
              SELECT 1
              FROM google_drive_account_migration_items mi
              WHERE mi.id = $2
                AND mi.target_file_id = resources.storage_key
                AND mi.source_file_id = $3
            )
          LIMIT 1
        `,
        [
          item.target_file_id,
          item.id,
          item.source_file_id,
        ],
      );

      return result.rowCount === 1;
    });

    if (!mappingExists) {
      return {
        status: "blocked",
        itemId,
        reason:
          "Application mapping for this migration item is missing; source deletion refused",
      };
    }
  } catch (error) {
    if (getGoogleErrorStatus(error) === 404) {
      await withDatabase(env, async (client) => {
        await client.query(
          `
            UPDATE google_drive_account_migration_items
            SET
              source_delete_status = 'blocked_target_missing',
              source_delete_error = $1,
              updated_at = NOW()
            WHERE id = $2
              AND source_delete_status IN ('pending', 'failed')
          `,
          [
            "Target file no longer exists; source deletion refused",
            item.id,
          ],
        );
      });

      return {
        status: "blocked_target_missing",
        itemId,
        reason: "Target file no longer exists; source deletion refused",
      };
    }

    throw error;
  }

  const eligibleForDeletion = await withDatabase(env, async (client) => {
    const result = await client.query(
      `
        SELECT 1
        FROM google_drive_account_migration_items
        WHERE id = $1
          AND status = 'completed'
          AND source_delete_status IN ('pending', 'failed')
        LIMIT 1
      `,
      [item.id],
    );

    return result.rowCount === 1;
  });

  if (!eligibleForDeletion) {
    return {
      status: "skipped",
      itemId: item.id,
      reason:
        "Migration item is no longer eligible for source cleanup",
    };
  }

  try {
    await deleteFile(
      sourceAccessToken,
      item.source_file_id,
    );
  } catch (error) {
    const status = getGoogleErrorStatus(error);

    if (status !== 404) {
      const message =
        error instanceof Error ? error.message : String(error);

      await withDatabase(env, async (client) => {
        await client.query(
          `
            UPDATE google_drive_account_migration_items
            SET
              source_delete_status = 'failed',
              source_delete_error = $1,
              cleanup_attempt_count = cleanup_attempt_count + 1,
              cleanup_next_attempt_at = NOW() + (
                LEAST(
                  3600,
                  POWER(2, LEAST(cleanup_attempt_count + 1, 8)) * 30
                ) * INTERVAL '1 second'
              ),
              updated_at = NOW()
            WHERE id = $2
          `,
          [message, item.id],
        );
      });

      return {
        status: "failed",
        itemId,
        error: message,
      };
    }
  }

  await withDatabase(env, async (client) => {
    await client.query(
      `
        UPDATE google_drive_account_migration_items
        SET
          source_delete_status = 'deleted',
          source_delete_error = NULL,
          cleanup_attempt_count = 0,
          cleanup_next_attempt_at = NULL,
          updated_at = NOW()
        WHERE id = $1
          AND source_delete_status IN ('pending', 'failed')
      `,
      [item.id],
    );
  });

  return {
    status: "deleted",
    itemId: item.id,
    sourceFileId: item.source_file_id,
  };
}
