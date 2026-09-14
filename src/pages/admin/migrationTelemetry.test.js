import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelemetrySample,
  deriveMigrationTelemetry,
} from "./migrationTelemetry.js";

function response(overrides = {}) {
  return {
    id: "migration-1",
    status: "running",
    startedAt: "2026-09-14T10:00:00.000Z",
    live: {
      totalBytes: "2000",
      transferredBytes: "1000",
      migrationElapsedSeconds: 0,
      overallSpeedBytesPerSecond: 0,
      currentFile: {
        id: "item-1",
        sizeBytes: "2000",
        bytesTransferred: "1000",
        speedBytesPerSecond: 0,
        elapsedSeconds: 0,
        startedAt: "2026-09-14T10:00:05.000Z",
      },
    },
    ...overrides,
  };
}

test("derives active migration and file elapsed time", () => {
  const telemetry = deriveMigrationTelemetry(
    response(),
    null,
    Date.parse("2026-09-14T10:00:15.000Z"),
  );

  assert.equal(telemetry.migrationElapsedSeconds, 15);
  assert.equal(telemetry.currentFile.elapsedSeconds, 10);
});

test("calculates live speed and ETA from consecutive byte samples", () => {
  const previous = createTelemetrySample(
    response({
      live: {
        ...response().live,
        transferredBytes: "500",
        currentFile: {
          ...response().live.currentFile,
          bytesTransferred: "500",
        },
      },
    }),
    1000,
  );
  const telemetry = deriveMigrationTelemetry(
    response(),
    previous,
    2000,
  );

  assert.equal(telemetry.overallSpeedBytesPerSecond, 500);
  assert.equal(
    telemetry.currentFile.speedBytesPerSecond,
    500,
  );
  assert.equal(telemetry.currentFile.etaSeconds, 2);
});

test("preserves the latest valid speed when backend speed is null", () => {
  const previous = {
    ...createTelemetrySample(response(), 1000),
    overallSpeedBytesPerSecond: 400,
    currentFileSpeedBytesPerSecond: 400,
  };
  const telemetry = deriveMigrationTelemetry(
    response({
      live: {
        ...response().live,
        overallSpeedBytesPerSecond: null,
        currentFile: {
          ...response().live.currentFile,
          speedBytesPerSecond: null,
        },
      },
    }),
    previous,
    2000,
  );

  assert.equal(telemetry.overallSpeedBytesPerSecond, 400);
  assert.equal(
    telemetry.currentFile.speedBytesPerSecond,
    400,
  );
});

test("does not expose active telemetry for a pending item", () => {
  const telemetry = deriveMigrationTelemetry(
    response({
      status: "pending",
      live: {
        ...response().live,
        currentFile: null,
        nextFile: {
          id: "item-2",
          status: "pending",
        },
      },
    }),
    null,
    2000,
  );

  assert.equal(telemetry.currentFile, null);
});

test("uses historical duration for completed migrations", () => {
  const telemetry = deriveMigrationTelemetry(
    response({
      status: "completed",
      finishedAt: "2026-09-14T10:00:20.000Z",
    }),
    null,
    Date.parse("2026-09-14T10:01:00.000Z"),
  );

  assert.equal(telemetry.migrationElapsedSeconds, 20);
  assert.equal(telemetry.totalEtaSeconds, 0);
});

test("verifying preserves completed bytes without transfer telemetry", () => {
  const telemetry = deriveMigrationTelemetry(
    response({
      live: {
        ...response().live,
        currentFile: {
          ...response().live.currentFile,
          bytesTransferred: "2000",
          phase: "verifying",
          speedBytesPerSecond: 900,
          etaSeconds: 1,
        },
      },
    }),
    null,
    Date.parse("2026-09-14T10:00:20.000Z"),
  );

  assert.equal(telemetry.currentFile.progressPct, 100);
  assert.equal(telemetry.currentFile.speedBytesPerSecond, null);
  assert.equal(telemetry.currentFile.etaSeconds, null);
  assert.equal(telemetry.currentFile.elapsedSeconds, 15);
});

test("Google-side copy does not expose fake byte progress", () => {
  const telemetry = deriveMigrationTelemetry(
    response({
      live: {
        ...response().live,
        currentFile: {
          ...response().live.currentFile,
          bytesTransferred: "0",
          telemetryMode: "google_drive_copy",
          phase: "downloading",
          speedBytesPerSecond: 1200,
        },
      },
    }),
    null,
    Date.parse("2026-09-14T10:00:20.000Z"),
  );

  assert.equal(telemetry.currentFile.copyInProgress, true);
  assert.equal(telemetry.currentFile.speedBytesPerSecond, null);
  assert.equal(telemetry.currentFile.etaSeconds, null);
  assert.equal(telemetry.currentFile.elapsedSeconds, 15);
});
