// Google Drive server-side copy path used by migrationWorker.js.
// Dependencies that mutate migration state are injected by the worker so
// this module can be tested with deterministic fakes.

function getDriveErrorStatus(error) {
  return Number(error?.response?.status ?? error?.code ?? 0) || 0;
}

export async function tryServerSideDriveCopy({
  targetDrive,
  targetAccount,
  item,
  sourceMetadata,
  abortController,
  ensureHeartbeatStillValid,
  workerNumber,
  log,
  enabled =
    String(process.env.MIGRATION_SERVER_SIDE_COPY || "").toLowerCase() === "true",
  markItemReconcilingFn,
  reconciliationDeadlineMs = 10 * 60 * 1000,
}) {
  if (!enabled) {
    return { kind: "fallback", reason: "server-side copy disabled" };
  }

  try {
    const capabilityResponse = await targetDrive.files.get(
      {
        fileId: item.source_file_id,
        fields: "id,name,mimeType,size,md5Checksum,capabilities(canCopy)",
        supportsAllDrives: true,
      },
      { signal: abortController.signal }
    );

    if (capabilityResponse?.data?.capabilities?.canCopy !== true) {
      log(
        `Server-side copy not permitted for ${sourceMetadata.name}; ` +
          `falling back to Render streaming`
      );
      return { kind: "fallback", reason: "target capabilities.canCopy=false" };
    }
  } catch (error) {
    const status = getDriveErrorStatus(error);

    if ([400, 403, 404].includes(status)) {
      log(
        `Server-side copy unavailable for ${sourceMetadata.name}; ` +
          `falling back to Render streaming (${status})`
      );
      return {
        kind: "fallback",
        reason: `target cannot access source (${status})`,
      };
    }

    throw error;
  }

  ensureHeartbeatStillValid();

  const copyStartedAt = Date.now();

  log(
    `Google-side copy ${sourceMetadata.name} ` +
      `from ${sourceMetadata.id} to ${targetAccount.email}`
  );

  let copyResponse;

  try {
    copyResponse = await targetDrive.files.copy(
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
        fields:
          "id,name,size,mimeType,md5Checksum,appProperties,owners(emailAddress),parents",
      },
      { signal: abortController.signal }
    );
  } catch (error) {
    const status = getDriveErrorStatus(error);
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
