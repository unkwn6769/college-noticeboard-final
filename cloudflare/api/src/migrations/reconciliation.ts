import {
  getFile,
  listFiles,
  type DriveFile,
} from "../google/drive";

import {
  FencedMigrationItemError,
  markReconciliationExpired,
  markReconciling,
  persistRecoveredTarget,
} from "./mutations";

const DEFAULT_DEADLINE_MS = 10 * 60 * 1000;

export type ReconciliationItem = {
  id: string;
  source_file_id: string;
  target_recovery_required: boolean;
  status: string;
  reconciliation_deadline: string | null;
};

export type ReconciliationResult =
  | {
      kind: "skip";
    }
  | {
      kind: "expired";
      itemId: string;
      reason: string;
    }
  | {
      kind: "reconciling";
      itemId: string;
      reason: string;
    }
  | {
      kind: "continue";
      targetFile: DriveFile;
    };

async function findExistingTarget(
  accessToken: string,
  migrationItemId: string,
  signal?: AbortSignal,
): Promise<DriveFile | null> {
  const result = await listFiles(
    accessToken,
    {
      q:
        "'me' in owners and " +
        "trashed = false and " +
        "appProperties has " +
        `{ key='college_noticeboard_migration_item' ` +
        `and value='${migrationItemId}' }`,
      fields:
        "files(id,name,size,mimeType,md5Checksum,appProperties,trashed)",
      pageSize: 100,
      signal,
    },
  );

  const files = result.files ?? [];

  if (files.length > 1) {
    throw new Error(
      `Multiple target files found for migration item ${migrationItemId}; refusing to create another copy`,
    );
  }

  return files[0] ?? null;
}

export async function reconcileTarget(
  env: Env,
  item: ReconciliationItem,
  sourceMetadata: DriveFile,
  targetAccessToken: string,
  leaseGeneration: string,
  signal?: AbortSignal,
  deadlineMs = DEFAULT_DEADLINE_MS,
): Promise<ReconciliationResult> {
  if (
    !item.target_recovery_required &&
    item.status !== "reconciling"
  ) {
    return { kind: "skip" };
  }

  const deadline = item.reconciliation_deadline
    ? new Date(item.reconciliation_deadline).getTime()
    : Date.now() + deadlineMs;

  if (Date.now() >= deadline) {
    const reason =
      `Reconciliation deadline reached for ${item.id}; ` +
      "manual intervention required";

    await markReconciliationExpired(
      env,
      item.id,
      leaseGeneration,
      reason,
    );

    return {
      kind: "expired",
      itemId: item.id,
      reason,
    };
  }

  try {
    const existingTarget =
      await findExistingTarget(
        targetAccessToken,
        item.id,
        signal,
      );

    if (!existingTarget?.id) {
      const reason =
        `Target upload outcome is uncertain for migration item ${item.id}; ` +
        "awaiting Drive reconciliation";

      await markReconciling(
        env,
        item.id,
        leaseGeneration,
        reason,
        deadlineMs,
      );

      return {
        kind: "reconciling",
        itemId: item.id,
        reason,
      };
    }

    const targetMetadata =
      await getFile(
        targetAccessToken,
        existingTarget.id,
        "id,name,size,mimeType,md5Checksum,appProperties,trashed",
        signal,
      );

    if (
      !targetMetadata.id ||
      targetMetadata.trashed
    ) {
      throw new Error(
        `Target ${existingTarget.id} could not be validated`,
      );
    }

    if (
      sourceMetadata.size != null &&
      targetMetadata.size != null &&
      String(sourceMetadata.size) !==
        String(targetMetadata.size)
    ) {
      throw new Error(
        `Target size mismatch during reconciliation: ` +
        `source=${sourceMetadata.size}, ` +
        `target=${targetMetadata.size}`,
      );
    }

    if (
      sourceMetadata.md5Checksum &&
      targetMetadata.md5Checksum &&
      sourceMetadata.md5Checksum !==
        targetMetadata.md5Checksum
    ) {
      throw new Error(
        `Target checksum mismatch during reconciliation: ` +
        `source=${sourceMetadata.md5Checksum}, ` +
        `target=${targetMetadata.md5Checksum}`,
      );
    }

    await persistRecoveredTarget(
      env,
      item.id,
      leaseGeneration,
      targetMetadata.id,
      sourceMetadata.size ?? "0",
    );

    return {
      kind: "continue",
      targetFile: targetMetadata,
    };
  } catch (error) {
    if (error instanceof FencedMigrationItemError) {
      throw error;
    }

    const reason =
      `Target reconciliation failed for ${item.id}: ` +
      `${error instanceof Error ? error.message : String(error)}`;

    await markReconciling(
      env,
      item.id,
      leaseGeneration,
      reason,
      deadlineMs,
    );

    return {
      kind: "reconciling",
      itemId: item.id,
      reason,
    };
  }
}
