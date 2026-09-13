import {
  copyFile,
  createPermission,
  deletePermission,
  type DriveFile,
} from "./drive";

const DEFAULT_SHARE_THRESHOLD_BYTES =
  512 * 1024;

const MIN_ESTIMATED_STREAM_DURATION_MS =
  2500;

const TEMP_PERMISSION_EXPIRATION_MS =
  15 * 60 * 1000;

const SHARE_COPY_RETRY_DELAYS_MS =
  [50, 125, 250, 400];

export type DriveCopyItem = {
  id: string;
  speed_bytes_per_second?: number | string | null;
};

export type DriveCopyAccount = {
  email: string;
};

export type DriveCopyResult =
  | {
      kind: "copied";
      targetFile: DriveFile;
    }
  | {
      kind: "fallback";
      reason: string;
    };

function toFiniteBytes(
  value: unknown,
): number | null {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(String(value));

  return Number.isFinite(n) && n >= 0
    ? n
    : null;
}

function sleep(
  ms: number,
): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ms),
  );
}

function getStatus(
  error: unknown,
): number {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error
  )
    ? Number(
        (error as { status?: unknown }).status,
      ) || 0
    : 0;
}

function getReason(
  error: unknown,
): string | null {
  return (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    typeof (
      error as { reason?: unknown }
    ).reason === "string"
  )
    ? (
        error as { reason: string }
      ).reason
    : null;
}

function is404(
  error: unknown,
): boolean {
  return getStatus(error) === 404;
}

function isRateLimitError(
  error: unknown,
): boolean {
  const status = getStatus(error);
  const reason = getReason(error);

  return (
    status === 429 ||
    (
      status === 403 &&
      (
        reason === "rateLimitExceeded" ||
        reason === "userRateLimitExceeded"
      )
    )
  );
}

function isStorageQuotaError(
  error: unknown,
): boolean {
  const status = getStatus(error);
  const reason = getReason(error);

  return (
    reason === "storageQuotaExceeded" ||
    reason === "quotaExceeded" ||
    status === 507
  );
}

async function deleteTemporaryPermission(
  sourceAccessToken: string,
  fileId: string,
  permissionId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await deletePermission(
      sourceAccessToken,
      fileId,
      permissionId,
      signal,
    );
  } catch (error) {
    if (!is404(error)) {
      console.error(
        "Temporary source permission cleanup failed:",
        error instanceof Error
          ? error.message
          : String(error),
      );
    }
  }
}

async function createTemporarySourcePermission(
  sourceAccessToken: string,
  sourceMetadata: DriveFile,
  targetAccount: DriveCopyAccount,
  role: "reader" | "writer",
  signal?: AbortSignal,
): Promise<string> {
  if (!sourceMetadata.id) {
    throw new Error(
      "Cannot temporarily share a source file without an ID",
    );
  }

  const permission =
    await createPermission(
      sourceAccessToken,
      sourceMetadata.id,
      {
        type: "user",
        role,
        emailAddress:
          targetAccount.email,
        expirationTime:
          new Date(
            Date.now() +
              TEMP_PERMISSION_EXPIRATION_MS,
          ).toISOString(),
      },
      signal,
    );

  if (!permission.id) {
    throw new Error(
      `Google Drive did not return a permission ID for temporary sharing of ${sourceMetadata.name ?? sourceMetadata.id}`,
    );
  }

  return permission.id;
}

async function copyAfterTemporaryShare(
  targetAccessToken: string,
  sourceMetadata: DriveFile,
  item: DriveCopyItem,
  signal?: AbortSignal,
): Promise<DriveFile> {
  let lastError: unknown = null;

  for (
    const delayMs of
      [0, ...SHARE_COPY_RETRY_DELAYS_MS]
  ) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      return await copyFile(
        targetAccessToken,
        sourceMetadata.id!,
        {
          name: sourceMetadata.name,
          parents: ["root"],
          appProperties: {
            college_noticeboard_migration_item:
              item.id,
          },
        },
        "id,name,size,mimeType,md5Checksum,appProperties",
        signal,
      );
    } catch (error) {
      lastError = error;

      if (!is404(error)) {
        throw error;
      }
    }
  }

  throw (
    lastError ??
    new Error(
      "Google-side copy remained unavailable after temporary sharing",
    )
  );
}

export async function tryDriveSideCopy({
  sourceAccessToken,
  targetAccessToken,
  sourceMetadata,
  targetAccount,
  item,
  signal,
  shareThresholdBytes =
    DEFAULT_SHARE_THRESHOLD_BYTES,
  temporaryWriterEnabled = true,
}: {
  sourceAccessToken: string;
  targetAccessToken: string;
  sourceMetadata: DriveFile;
  targetAccount: DriveCopyAccount;
  item: DriveCopyItem;
  signal?: AbortSignal;
  shareThresholdBytes?: number;
  temporaryWriterEnabled?: boolean;
}): Promise<DriveCopyResult> {
  if (!sourceMetadata.id) {
    throw new Error(
      "Source file metadata did not contain an ID",
    );
  }

  let targetFile: DriveFile | null = null;

  /*
   * First attempt: direct Google-side copy.
   *
   * 403 rateLimitExceeded / userRateLimitExceeded and 429 are
   * retried locally. If throttling persists, the error is allowed
   * to escape so processItem() can treat the write as ambiguous
   * and enter reconciliation.
   */
  try {
    for (
      let attempt = 0;
      ;
      attempt += 1
    ) {
      try {
        targetFile =
          await copyFile(
            targetAccessToken,
            sourceMetadata.id,
            {
              name: sourceMetadata.name,
              parents: ["root"],
              appProperties: {
                college_noticeboard_migration_item:
                  item.id,
              },
            },
            "id,name,size,mimeType,md5Checksum,appProperties",
            signal,
          );

        break;
      } catch (error) {
        if (
          !isRateLimitError(error) ||
          attempt >= 4
        ) {
          throw error;
        }

        const delays = [
          100,
          250,
          600,
          1200,
        ];

        await sleep(
          delays[attempt],
        );
      }
    }
  } catch (error) {
    const status = getStatus(error);

    /*
     * Quota is handled by the migration state machine.
     */
    if (isStorageQuotaError(error)) {
      throw error;
    }

    /*
     * Target cannot access the source through server-side copy.
     * The migration processor can choose the byte-stream fallback.
     */
    if (
      (
        status === 400 ||
        status === 403
      ) &&
      !isRateLimitError(error)
    ) {
      return {
        kind: "fallback",
        reason:
          `target cannot access source (${status})`,
      };
    }

    /*
     * 404 means the target account cannot currently see the source.
     * For sufficiently large/slow transfers, temporarily share the
     * source and retry the Google-side copy.
     */
    if (status === 404) {
      const sizeBytes =
        toFiniteBytes(
          sourceMetadata.size,
        );

      const speed =
        toFiniteBytes(
          item.speed_bytes_per_second,
        ) ?? 0;

      const estimatedStreamMs =
        sizeBytes !== null &&
        speed > 0
          ? (sizeBytes / speed) * 1000
          : null;

      const threshold =
        Number.isFinite(
          shareThresholdBytes,
        )
          ? Math.max(
              0,
              shareThresholdBytes,
            )
          : DEFAULT_SHARE_THRESHOLD_BYTES;

      const role =
        sourceMetadata
          .copyRequiresWriterPermission ===
        true
          ? "writer"
          : "reader";

      if (
        role === "writer" &&
        !temporaryWriterEnabled
      ) {
        return {
          kind: "fallback",
          reason:
            "copy restriction requires temporary writer access, which is disabled",
        };
      }

      const shouldTryShare =
        Boolean(targetAccount.email) &&
        (
          sizeBytes === null ||
          sizeBytes > threshold ||
          (
            estimatedStreamMs !== null &&
            estimatedStreamMs >
              MIN_ESTIMATED_STREAM_DURATION_MS
          )
        );

      if (!shouldTryShare) {
        return {
          kind: "fallback",
          reason:
            "file below temporary-share threshold",
        };
      }

      const permissionId =
        await createTemporarySourcePermission(
          sourceAccessToken,
          sourceMetadata,
          targetAccount,
          role,
          signal,
        );

      try {
        targetFile =
          await copyAfterTemporaryShare(
            targetAccessToken,
            sourceMetadata,
            item,
            signal,
          );
      } finally {
        await deleteTemporaryPermission(
          sourceAccessToken,
          sourceMetadata.id,
          permissionId,
          signal,
        );
      }
    } else {
      /*
       * 429 / exhausted rate-limit retries, 5xx, network errors,
       * etc. are deliberately allowed to reach processItem().
       * The processor will classify ambiguous write outcomes.
       */
      throw error;
    }
  }

  if (!targetFile?.id) {
    throw new Error(
      "Google Drive copy returned no target file ID",
    );
  }

  return {
    kind: "copied",
    targetFile,
  };
}
