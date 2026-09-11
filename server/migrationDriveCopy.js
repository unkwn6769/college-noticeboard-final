// Fast Google Drive migration path.
//
// Strategy:
//   1. Attempt a direct target-authenticated files.copy() first.
//   2. If the target cannot see the source (404) and the file is worth
//      accelerating, temporarily grant the target read access from the source
//      account, then retry the Google-side copy.
//   3. Remove only the temporary permission we created.
//   4. Preserve Render streaming as the safe fallback for small files,
//      restricted files, or permission failures.

const DEFAULT_SHARE_THRESHOLD_BYTES = 512 * 1024;
const SHARE_COPY_RETRY_DELAYS_MS = [50, 125, 250, 400];
const DRIVE_THROTTLE_RETRY_DELAYS_MS = [100, 250, 600, 1200];
const MIN_ESTIMATED_STREAM_DURATION_MS = 2500;
const TEMP_PERMISSION_EXPIRATION_MS = 15 * 60 * 1000;

function getDriveErrorStatus(error) {
  return Number(error?.response?.status ?? error?.code ?? 0) || 0;
}

function getDriveErrorReason(error) {
  return String(
    error?.response?.data?.error?.errors?.[0]?.reason ??
      error?.response?.data?.error?.status ??
      error?.errors?.[0]?.reason ??
      ""
  );
}

function isRetryableDriveThrottle(error) {
  const status = getDriveErrorStatus(error);
  const reason = getDriveErrorReason(error);

  return (
    status === 429 ||
    (status === 403 &&
      ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason))
  );
}

function getRetryDelayWithJitter(delayMs) {
  return delayMs + Math.floor(Math.random() * Math.min(100, Math.max(10, delayMs / 4)));
}


function getNumericBytes(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    const n = Number(String(value));
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteTemporaryPermission({
  sourceDrive,
  fileId,
  permissionId,
  log,
}) {
  if (!permissionId) return;

  try {
    await sourceDrive.permissions.delete({
      fileId,
      permissionId,
      supportsAllDrives: true,
    });
  } catch (error) {
    const status = getDriveErrorStatus(error);
    if (status !== 404) {
      log(
        `Temporary source permission cleanup failed for ${fileId}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

async function createTemporarySourcePermission({
  sourceDrive,
  sourceMetadata,
  targetAccount,
  abortController,
  log,
  role = "reader",
}) {
  const response = await sourceDrive.permissions.create(
    {
      fileId: sourceMetadata.id,
      requestBody: {
        type: "user",
        role,
        emailAddress: targetAccount.email,
        expirationTime: new Date(
          Date.now() + TEMP_PERMISSION_EXPIRATION_MS
        ).toISOString(),
      },
      sendNotificationEmail: false,
      supportsAllDrives: true,
      fields: "id,type,role,emailAddress",
    },
    { signal: abortController.signal }
  );

  const permissionId = response?.data?.id;
  if (!permissionId) {
    throw new Error(
      `Google Drive did not return a permission ID for temporary sharing of ${sourceMetadata.name}`
    );
  }

  log(
    `Temporarily shared ${sourceMetadata.name} with ${targetAccount.email} ` +
      `for Google-side copy`
  );

  return permissionId;
}

async function copyOnce({
  targetDrive,
  sourceMetadata,
  item,
  abortController,
}) {
  return targetDrive.files.copy(
    {
      fileId: sourceMetadata.id,
      requestBody: {
        name: sourceMetadata.name,
        parents: ["root"],
        appProperties: {
          college_noticeboard_migration_item: item.id,
        },
      },
      supportsAllDrives: true,
      fields: "id,name,size,mimeType,md5Checksum,appProperties",
    },
    { signal: abortController.signal }
  );
}

async function copyOnceWithThrottleRetry(args, log, label) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await copyOnce(args);
    } catch (error) {
      if (attempt >= DRIVE_THROTTLE_RETRY_DELAYS_MS.length || !isRetryableDriveThrottle(error)) {
        throw error;
      }

      const delayMs = getRetryDelayWithJitter(
        DRIVE_THROTTLE_RETRY_DELAYS_MS[attempt]
      );

      log(
        `Drive API throttled ${label}; retrying in ${delayMs}ms ` +
          `(attempt ${attempt + 1}/${DRIVE_THROTTLE_RETRY_DELAYS_MS.length})`
      );

      await sleep(delayMs);
    }
  }
}

async function copyWithTemporarySourcePermission({
  sourceDrive,
  targetDrive,
  sourceMetadata,
  targetAccount,
  item,
  abortController,
  log,
  role = "reader",
}) {
  const permissionId = await createTemporarySourcePermission({
    sourceDrive,
    sourceMetadata,
    targetAccount,
    abortController,
    log,
    role,
  });

  try {
    let lastError = null;

    for (const delayMs of [0, ...SHARE_COPY_RETRY_DELAYS_MS]) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }

      try {
        return await copyOnceWithThrottleRetry(
          { targetDrive, sourceMetadata, item, abortController },
          log,
          `temporary-copy ${sourceMetadata.name}`
        );
      } catch (error) {
        lastError = error;
        if (getDriveErrorStatus(error) !== 404) {
          throw error;
        }
      }
    }

    throw lastError ?? new Error("Google-side copy remained unavailable after temporary sharing");
  } finally {
    void deleteTemporaryPermission({
      sourceDrive,
      fileId: sourceMetadata.id,
      permissionId,
      log,
    });
  }
}

export async function tryServerSideDriveCopy({
  sourceDrive,
  targetDrive,
  targetAccount,
  item,
  sourceMetadata,
  abortController,
  ensureHeartbeatStillValid,
  workerNumber,
  log,
  enabled =
    String(process.env.MIGRATION_SERVER_SIDE_COPY || "").toLowerCase() ===
    "true",
  markItemReconcilingFn,
  reconciliationDeadlineMs = 10 * 60 * 1000,
  shareThresholdBytes = Number(
    process.env.MIGRATION_SERVER_SIDE_COPY_SHARE_THRESHOLD_BYTES ||
      DEFAULT_SHARE_THRESHOLD_BYTES
  ),
}) {
  if (!enabled) {
    return { kind: "fallback", reason: "server-side copy disabled" };
  }

  ensureHeartbeatStillValid();

  const copyStartedAt = Date.now();

  log(
    `Google-side copy ${sourceMetadata.name} ` +
      `from ${sourceMetadata.id} to ${targetAccount.email}`
  );

  let copyResponse;

  try {
    copyResponse = await copyOnceWithThrottleRetry(
      { targetDrive, sourceMetadata, item, abortController },
      log,
      sourceMetadata.name
    );
  } catch (error) {
    let status = getDriveErrorStatus(error);

    if (status === 404) {
      const sizeBytes = getNumericBytes(sourceMetadata.size);
      const threshold = Number.isFinite(shareThresholdBytes)
        ? Math.max(0, shareThresholdBytes)
        : DEFAULT_SHARE_THRESHOLD_BYTES;
      const historicalSpeed = getNumericBytes(item?.speed_bytes_per_second);
      const estimatedStreamMs =
        sizeBytes !== null && historicalSpeed > 0
          ? (sizeBytes / historicalSpeed) * 1000
          : null;
      const temporaryShareRole =
        sourceMetadata.copyRequiresWriterPermission === true
          ? "writer"
          : "reader";
      const writerShareEnabled =
        temporaryShareRole !== "writer" ||
        String(
          process.env.MIGRATION_SERVER_SIDE_COPY_TEMPORARY_WRITER || "true"
        ).toLowerCase() === "true";
      const shouldTryShare =
        sourceDrive &&
        targetAccount?.email &&
        writerShareEnabled &&
        (sizeBytes === null ||
          sizeBytes > threshold ||
          estimatedStreamMs > MIN_ESTIMATED_STREAM_DURATION_MS);

      if (shouldTryShare) {
        try {
          copyResponse = await copyWithTemporarySourcePermission({
            targetDrive,
            sourceDrive,
            sourceMetadata,
            targetAccount,
            item,
            abortController,
            log,
            role: temporaryShareRole,
          });
        } catch (shareCopyError) {
          error = shareCopyError;
          status = getDriveErrorStatus(shareCopyError);
        }
      }

      if (copyResponse) {
        // Continue with the normal successful-copy path below.
      } else if (status === 404) {
        const reason = shouldTryShare
          ? "temporary source share did not make the file copyable"
          : sourceMetadata.copyRequiresWriterPermission === true && !writerShareEnabled
            ? "copy restriction requires temporary writer access, which is disabled"
            : "file below temporary-share threshold";
        log(
          `Server-side copy unavailable for ${sourceMetadata.name}; ` +
            `${reason}; falling back to Render streaming (404)`
        );
        return {
          kind: "fallback",
          reason: "target cannot access source (404)",
        };
      }
    }

    if (!copyResponse) {
      if ([400, 403].includes(status)) {
        log(
          `Server-side copy unavailable for ${sourceMetadata.name}; ` +
            `falling back to Render streaming (${status})`
        );
        return {
          kind: "fallback",
          reason: `target cannot access source (${status})`,
        };
      }

      const ambiguous =
        status === 0 ||
        status === 408 ||
        status === 409 ||
        status === 429 ||
        status >= 500;

      if (ambiguous) {
        const reason =
          `Google-side copy outcome is uncertain for ${item.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`;

        await markItemReconcilingFn(
          item.id,
          item.lease_generation,
          reason,
          reconciliationDeadlineMs
        );

        return {
          kind: "reconciling",
          status: "reconciling",
          itemId: item.id,
          sourceFileId: item.source_file_id,
          workerNumber,
          reason,
        };
      }

      throw error;
    }
  }

  const copyElapsedMs = Date.now() - copyStartedAt;
  const target = copyResponse?.data;

  if (!target?.id) {
    const reason =
      `Google-side copy returned no target file ID for migration item ${item.id}`;

    await markItemReconcilingFn(
      item.id,
      item.lease_generation,
      reason,
      reconciliationDeadlineMs
    );

    return {
      kind: "reconciling",
      status: "reconciling",
      itemId: item.id,
      sourceFileId: item.source_file_id,
      workerNumber,
      reason,
    };
  }

  ensureHeartbeatStillValid();

  log(
    `Google-side copy completed for ${sourceMetadata.name} ` +
      `in ${copyElapsedMs}ms (API-operation latency; not Render wire throughput)`
  );

  return {
    kind: "copied",
    targetFileId: target.id,
    targetMetadata: target,
    copyElapsedMs,
  };
}
