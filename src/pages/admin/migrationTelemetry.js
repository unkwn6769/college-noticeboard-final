const BYTES_PER_MIB = 1024 * 1024;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function elapsedSeconds(startedAt, endedAt, now = Date.now()) {
  if (!startedAt) {
    return null;
  }

  const start = new Date(startedAt).getTime();
  const end = endedAt
    ? new Date(endedAt).getTime()
    : now;

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  return Math.max(0, (end - start) / 1000);
}

function measuredSpeed(bytes, previousBytes, timestamp, previousTimestamp) {
  if (
    previousTimestamp === null ||
    previousTimestamp === undefined ||
    previousBytes === null ||
    previousBytes === undefined
  ) {
    return null;
  }

  const seconds = (timestamp - previousTimestamp) / 1000;
  const delta = bytes - previousBytes;

  return seconds > 0 && delta > 0 ? delta / seconds : null;
}

export function deriveMigrationTelemetry(
  latest,
  previous = null,
  now = Date.now(),
) {
  if (!latest?.live) {
    return {
      migrationElapsedSeconds: null,
      overallSpeedBytesPerSecond: null,
      totalEtaSeconds: null,
      currentFile: null,
    };
  }

  const live = latest.live;
  const totalBytes = finiteNumber(live.totalBytes) ?? 0;
  const transferredBytes =
    finiteNumber(live.transferredBytes) ?? 0;
  const active =
    latest.status === "pending" ||
    latest.status === "running" ||
    latest.status === "waiting_for_storage";

  const backendOverallSpeed = finiteNumber(
    live.overallSpeedBytesPerSecond,
  );
  const observedOverallSpeed = measuredSpeed(
    transferredBytes,
    previous?.transferredBytes,
    now,
    previous?.timestamp,
  );
  const overallSpeed =
    observedOverallSpeed ??
    (backendOverallSpeed > 0 ? backendOverallSpeed : null) ??
    (previous?.overallSpeedBytesPerSecond ?? null);

  const currentFile = live.currentFile;
  let derivedCurrentFile = null;

  if (currentFile) {
    const isGoogleDriveCopy =
      currentFile.telemetryMode === "google_drive_copy";
    const fileBytes =
      finiteNumber(currentFile.bytesTransferred) ?? 0;
    const fileSize =
      finiteNumber(currentFile.sizeBytes) ?? 0;
    const backendFileSpeed = finiteNumber(
      currentFile.speedBytesPerSecond,
    );
    const observedFileSpeed =
      currentFile.id === previous?.currentFileId
        ? measuredSpeed(
            fileBytes,
            previous?.currentFileBytes,
            now,
            previous?.timestamp,
          )
        : null;
    const isVerifying =
      currentFile.phase === "verifying";
    const fileSpeed = isGoogleDriveCopy || isVerifying
      ? null
      : observedFileSpeed ??
        (backendFileSpeed > 0 ? backendFileSpeed : null) ??
        (currentFile.id === previous?.currentFileId
          ? previous?.currentFileSpeedBytesPerSecond ?? null
          : null);
    const fileElapsed =
      elapsedSeconds(
        currentFile.startedAt,
        active ? null : latest.finishedAt,
        now,
      ) ??
      finiteNumber(currentFile.elapsedSeconds) ??
      0;
    const remainingBytes = Math.max(
      0,
      fileSize - fileBytes,
    );

    derivedCurrentFile = {
      ...currentFile,
      copyInProgress: isGoogleDriveCopy,
      speedBytesPerSecond: fileSpeed,
      etaSeconds:
        !isGoogleDriveCopy &&
        !isVerifying &&
        fileSpeed > 0
          ? remainingBytes / fileSpeed
          : null,
      elapsedSeconds: fileElapsed,
      progressPct:
        fileSize > 0
          ? Math.min(100, (fileBytes / fileSize) * 100)
          : 0,
    };
  }

  const migrationElapsed =
    elapsedSeconds(
      latest.startedAt,
      active ? null : latest.finishedAt,
      now,
    ) ??
    finiteNumber(live.migrationElapsedSeconds) ??
    0;
  const remainingTotalBytes = Math.max(
    0,
    totalBytes - transferredBytes,
  );

  return {
    migrationElapsedSeconds: migrationElapsed,
    overallSpeedBytesPerSecond: overallSpeed,
    overallSpeedMiBPerSecond:
      overallSpeed === null
        ? null
        : overallSpeed / BYTES_PER_MIB,
    totalEtaSeconds:
      latest.status === "completed"
        ? 0
        : overallSpeed > 0
          ? remainingTotalBytes / overallSpeed
          : null,
    currentFile: derivedCurrentFile,
  };
}

export function createTelemetrySample(
  latest,
  timestamp = Date.now(),
) {
  const currentFile = latest?.live?.currentFile;

  return {
    migrationId: latest?.id ?? null,
    timestamp,
    transferredBytes:
      finiteNumber(latest?.live?.transferredBytes) ?? 0,
    currentFileId: currentFile?.id ?? null,
    currentFileBytes:
      finiteNumber(currentFile?.bytesTransferred) ?? 0,
    overallSpeedBytesPerSecond:
      finiteNumber(
        latest?.live?.overallSpeedBytesPerSecond,
      ) ?? null,
    currentFileSpeedBytesPerSecond:
      finiteNumber(
        currentFile?.speedBytesPerSecond,
      ) ?? null,
  };
}
