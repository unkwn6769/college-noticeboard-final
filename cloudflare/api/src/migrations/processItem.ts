import {
  getFile,
  copyFile,
} from "../google/drive";

import { getDriveAccessToken } from "../google/oauth";
import { classifyGoogleError } from "../google/errors";
import { tryDriveSideCopy } from "../google/driveCopy";

import { claimExactItem } from "./claim";
import {
  getMigrationItem,
} from "./queries";
import {
  loadMigrationContext,
} from "./context";

import {
  markCompleted,
  markFailed,
  markAccountAuthorizationInvalid,
  incrementRetryCount,
  clearRetryCount,
  requeueAfterTransientFailure,
  requeueAfterStorageWait,
  markReconciling,
  persistTargetFileId,
  FencedMigrationItemError,
} from "./mutations";

import {
  reconcileTarget,
} from "./reconciliation";
import { ensureTargetMapping } from "./targetMapping";

const MAX_TRANSIENT_RETRIES = 3;
const RETRY_DELAY_MS = 3_000;
const RECONCILIATION_DEADLINE_MS = 10 * 60 * 1000;
const RECONCILIATION_RETRY_DELAY_MS = 2_000;
const DUPLICATE_QUEUE_RETRY_DELAY_MS = 5_000;

export type MigrationQueueMessage = {
  migrationId: string;
  itemId: string;
};

export type ProcessItemResult =
  | {
      status: "completed";
      migrationId: string;
      itemId: string;
      targetFileId: string;
    }
  | {
      status: "already_handled";
      migrationId: string;
      itemId: string;
    }
  | {
      status: "retry_later";
      migrationId: string;
      itemId: string;
      delayMs: number;
    }
  | {
      status: "retrying";
      migrationId: string;
      itemId: string;
      retryCount: number;
      delayMs: number;
    }
  | {
      status: "waiting_for_storage";
      migrationId: string;
      itemId: string;
      delayMs: number;
    }
  | {
      status: "reconciling";
      migrationId: string;
      itemId: string;
      delayMs: number;
      reason: string;
    }
  | {
      status: "reconciliation_expired";
      migrationId: string;
      itemId: string;
      reason: string;
    }
  | {
      status: "failed";
      migrationId: string;
      itemId: string;
      reason: string;
    };

function assertMessage(
  message: unknown,
): asserts message is MigrationQueueMessage {
  if (!message || typeof message !== "object") {
    throw new Error("Invalid migration queue message");
  }

  const value =
    message as Record<string, unknown>;

  if (
    typeof value.migrationId !== "string" ||
    !value.migrationId ||
    typeof value.itemId !== "string" ||
    !value.itemId
  ) {
    throw new Error(
      "Migration queue message requires migrationId and itemId",
    );
  }
}

function isTerminalStatus(
  status: string,
): boolean {
  return [
    "completed",
    "failed",
    "cancelled",
    "reconciliation_expired",
  ].includes(status);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

function retryDelay(
  retryCount: number,
): number {
  return Math.min(
    60_000,
    RETRY_DELAY_MS *
      2 ** Math.max(0, retryCount - 1),
  );
}

export async function processMigrationItem(
  env: Env,
  rawMessage: unknown,
): Promise<ProcessItemResult> {
  assertMessage(rawMessage);

  const {
    migrationId,
    itemId,
  } = rawMessage;

  const claimed =
    await claimExactItem(
      env,
      migrationId,
      itemId,
    );

  if (!claimed) {
    const current =
      await getMigrationItem(
        env,
        itemId,
      );

    if (!current) {
      return {
        status: "already_handled",
        migrationId,
        itemId,
      };
    }

    if (
      current.migration_id !== migrationId
    ) {
      return {
        status: "already_handled",
        migrationId,
        itemId,
      };
    }

    if (
      isTerminalStatus(current.status)
    ) {
      return {
        status: "already_handled",
        migrationId,
        itemId,
      };
    }

    let delayMs =
      DUPLICATE_QUEUE_RETRY_DELAY_MS;

    if (current.next_retry_at) {
      const retryAt =
        new Date(
          current.next_retry_at,
        ).getTime();

      if (Number.isFinite(retryAt)) {
        delayMs = Math.max(
          1_000,
          Math.min(
            60_000,
            retryAt - Date.now(),
          ),
        );
      }
    }

    return {
      status: "retry_later",
      migrationId,
      itemId,
      delayMs,
    };
  }

  if (
    claimed.status ===
    "reconciliation_expired"
  ) {
    return {
      status: "reconciliation_expired",
      migrationId,
      itemId,
      reason:
        claimed.error_message ??
        "Reconciliation deadline reached",
    };
  }

  const leaseGeneration =
    claimed.lease_generation;

  let activeAccountId:
    string | null = null;

  let lastOperation:
    | "source_auth"
    | "source_read"
    | "target_auth"
    | "target_verify"
    | "target_copy"
    | "none" = "none";

  try {
    const {
      migration,
      item,
      sourceAccount,
      targetAccount,
    } = await loadMigrationContext(
      env,
      migrationId,
      itemId,
    );

    /*
     * A previously persisted target is always verified before
     * completion. Never issue a second copy just because the
     * process restarted after the DB write boundary.
     */
    if (item.target_file_id) {
      activeAccountId = targetAccount.id;
      lastOperation = "target_auth";

      const targetToken =
        await getDriveAccessToken(
          env,
          targetAccount,
        );

      lastOperation = "target_verify";

      const persistedTarget =
        await getFile(
          targetToken,
          item.target_file_id,
          "id,name,size,mimeType,md5Checksum,appProperties,trashed",
        );

      if (
        !persistedTarget.id ||
        persistedTarget.trashed
      ) {
        throw new Error(
          "Persisted target file could not be verified",
        );
      }

      await ensureTargetMapping(env, {
        itemId,
        leaseGeneration,
        targetFileId: persistedTarget.id,
        targetName: persistedTarget.name,
        targetSize: persistedTarget.size,
      });
      await markCompleted(
        env,
        itemId,
        leaseGeneration,
        persistedTarget.id,
      );

      return {
        status: "completed",
        migrationId,
        itemId,
        targetFileId:
          persistedTarget.id,
      };
    }

    activeAccountId = sourceAccount.id;
    lastOperation = "source_auth";

    const sourceToken =
      await getDriveAccessToken(
        env,
        sourceAccount,
      );

    lastOperation = "source_read";

    const sourceFile =
      await getFile(
        sourceToken,
        item.source_file_id,
        "id,name,size,mimeType,md5Checksum,appProperties,trashed,copyRequiresWriterPermission",
      );

    if (!sourceFile.id) {
      throw new Error(
        "Source file metadata did not contain an ID",
      );
    }

    if (sourceFile.trashed) {
      throw new Error(
        "Source file is in the Drive trash",
      );
    }

    /*
     * A recovered item must reconcile BEFORE another copy.
     * This includes a stale running lease and an ambiguous copy
     * that was requeued with target_recovery_required = true.
     */
    if (
      item.target_recovery_required ||
      item.transfer_phase === "reconciling"
    ) {
      activeAccountId = targetAccount.id;
      lastOperation = "target_auth";

      const targetToken =
        await getDriveAccessToken(
          env,
          targetAccount,
        );

      const reconciliation =
        await reconcileTarget(
          env,
          item,
          sourceFile,
          targetToken,
          leaseGeneration,
          undefined,
          RECONCILIATION_DEADLINE_MS,
        );

      if (
        reconciliation.kind ===
        "expired"
      ) {
        return {
          status:
            "reconciliation_expired",
          migrationId,
          itemId,
          reason:
            reconciliation.reason,
        };
      }

      if (
        reconciliation.kind ===
        "reconciling"
      ) {
        return {
          status: "reconciling",
          migrationId,
          itemId,
          delayMs:
            RECONCILIATION_RETRY_DELAY_MS,
          reason:
            reconciliation.reason,
        };
      }

      if (
        reconciliation.kind ===
        "continue"
      ) {
        const recoveredTargetFileId =
          reconciliation.targetFile.id;

        if (!recoveredTargetFileId) {
          throw new Error(
            "Reconciliation returned a target without an ID",
          );
        }

        await ensureTargetMapping(env, {
          itemId,
          leaseGeneration,
          targetFileId: recoveredTargetFileId,
          targetName: reconciliation.targetFile.name,
          targetSize: reconciliation.targetFile.size,
        });
        await markCompleted(
          env,
          itemId,
          leaseGeneration,
          recoveredTargetFileId,
        );

        return {
          status: "completed",
          migrationId,
          itemId,
          targetFileId:
            recoveredTargetFileId,
        };
      }
    }

    activeAccountId = targetAccount.id;
    lastOperation = "target_auth";

    const targetToken =
      await getDriveAccessToken(
        env,
        targetAccount,
      );

    /*
     * The primary Worker path is Google-side copy:
     * source Drive -> target Drive.
     *
     * 408/409/429/5xx/network failures during this WRITE are
     * ambiguous because the copy may already exist. They go to
     * reconciliation, not blind retry.
     */
    lastOperation = "target_copy";

    const copyResult =
      await tryDriveSideCopy({
        sourceAccessToken: sourceToken,
        targetAccessToken: targetToken,
        sourceMetadata: sourceFile,
        targetAccount: {
          email: targetAccount.email,
        },
        item: {
          id: item.id,
          speed_bytes_per_second:
            item.speed_bytes_per_second,
        },
      });

    if (copyResult.kind === "fallback") {
      return {
        status: "retry_later",
        migrationId,
        itemId,
        delayMs: 1_000,
      };
    }

    const targetFile =
      copyResult.targetFile;

    const targetFileId =
      targetFile.id;

    if (!targetFileId) {
      throw new Error(
        "Google Drive copy returned no target file ID",
      );
    }

    await clearRetryCount(
      env,
      itemId,
      leaseGeneration,
    );

    await persistTargetFileId(
      env,
      itemId,
      leaseGeneration,
      targetFileId,
    );

    await ensureTargetMapping(env, {
      itemId,
      leaseGeneration,
      targetFileId,
      targetName: targetFile.name,
      targetSize: targetFile.size,
    });

    await markCompleted(
      env,
      itemId,
      leaseGeneration,
      targetFileId,
    );

    return {
      status: "completed",
      migrationId,
      itemId,
      targetFileId,
    };

  } catch (error) {
    if (
      error instanceof
      FencedMigrationItemError
    ) {
      throw error;
    }

    const message =
      getErrorMessage(error);

    const errorClass =
      classifyGoogleError(error);

    /*
     * A target-side copy failure is fundamentally different from
     * a source metadata read failure: the remote WRITE may already
     * have succeeded.
     */
    if (
      lastOperation === "target_copy" &&
      (
        errorClass.type ===
          "transient" ||
        errorClass.type ===
          "ambiguous"
      )
    ) {
      const reason =
        `Google-side copy outcome is uncertain for ${itemId}: ${message}`;

      await markReconciling(
        env,
        itemId,
        leaseGeneration,
        reason,
        RECONCILIATION_DEADLINE_MS,
        RECONCILIATION_RETRY_DELAY_MS,
      );

      return {
        status: "reconciling",
        migrationId,
        itemId,
        delayMs:
          RECONCILIATION_RETRY_DELAY_MS,
        reason,
      };
    }

    if (
      errorClass.type ===
      "authorization_invalid"
    ) {
      if (activeAccountId) {
        await markAccountAuthorizationInvalid(
          env,
          activeAccountId,
        );
      }

      const reason =
        `Google Drive authorization is invalid for account ${activeAccountId ?? "unknown"}: ${message}`;

      await clearRetryCount(
        env,
        itemId,
        leaseGeneration,
      );

      await markFailed(
        env,
        itemId,
        leaseGeneration,
        reason,
      );

      return {
        status: "failed",
        migrationId,
        itemId,
        reason,
      };
    }

    /*
     * If a previously persisted target disappears, reconciling
     * by migration marker is safer than issuing another copy.
     */
    if (
      lastOperation ===
        "target_verify" &&
      errorClass.type ===
        "permanent" &&
      (
        errorClass.reason ===
          "fileNotFound" ||
        errorClass.reason ===
          "notFound"
      )
    ) {
      const reason =
        `Persisted target ${itemId} could not be found; reconciling by migration marker`;

      await markReconciling(
        env,
        itemId,
        leaseGeneration,
        reason,
        RECONCILIATION_DEADLINE_MS,
        RECONCILIATION_RETRY_DELAY_MS,
      );

      return {
        status: "reconciling",
        migrationId,
        itemId,
        delayMs:
          RECONCILIATION_RETRY_DELAY_MS,
        reason,
      };
    }

    if (
      errorClass.type ===
      "storage"
    ) {
      const reason =
        `Waiting for storage: ${message}`;

      await requeueAfterStorageWait(
        env,
        itemId,
        leaseGeneration,
        reason,
      );

      return {
        status:
          "waiting_for_storage",
        migrationId,
        itemId,
        delayMs: 30_000,
      };
    }

    if (
      errorClass.type ===
        "transient" ||
      errorClass.type ===
        "ambiguous"
    ) {
      const retryCount =
        await incrementRetryCount(
          env,
          itemId,
          leaseGeneration,
        );

      if (
        retryCount <=
        MAX_TRANSIENT_RETRIES
      ) {
        const delayMs =
          retryDelay(retryCount);

        const reason =
          `Transient failure; retry ${retryCount}/${MAX_TRANSIENT_RETRIES}: ${message}`;

        await requeueAfterTransientFailure(
          env,
          itemId,
          leaseGeneration,
          reason,
          delayMs,
        );

        return {
          status: "retrying",
          migrationId,
          itemId,
          retryCount,
          delayMs,
        };
      }

      const reason =
        `Transient failure persisted after ${MAX_TRANSIENT_RETRIES} retries: ${message}`;

      await clearRetryCount(
        env,
        itemId,
        leaseGeneration,
      );

      await markFailed(
        env,
        itemId,
        leaseGeneration,
        reason,
      );

      return {
        status: "failed",
        migrationId,
        itemId,
        reason,
      };
    }

    const reason =
      errorClass.type ===
      "permanent"
        ? `Permanent Google Drive failure (${errorClass.reason}): ${message}`
        : message;

    await clearRetryCount(
      env,
      itemId,
      leaseGeneration,
    );

    await markFailed(
      env,
      itemId,
      leaseGeneration,
      reason,
    );

    return {
      status: "failed",
      migrationId,
      itemId,
      reason,
    };
  }
}
