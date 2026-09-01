import {
  migrateOneItem,
  getMigrationSummary,
  getMigrationStatus,
  finalizeCancellationIfIdle,
} from "./migrationWorker.js";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 25;
const DEFAULT_FILE_WORKERS_PER_MIGRATION = 40;
const MAX_FILE_WORKERS_PER_MIGRATION = 50;

function getConfiguredFileWorkers() {
  const raw = process.env.MIGRATION_FILE_WORKERS;

  if (raw == null || raw === "") {
    return DEFAULT_FILE_WORKERS_PER_MIGRATION;
  }

  const value = Number(raw);

  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_FILE_WORKERS_PER_MIGRATION
  ) {
    throw new Error(
      `MIGRATION_FILE_WORKERS must be an integer between 1 and ${MAX_FILE_WORKERS_PER_MIGRATION}`
    );
  }

  return value;
}
const MAX_RESULT_SAMPLES = 100;
const DEFERRED_STORAGE_BACKOFF_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBatchSize(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_BATCH_SIZE;
  }

  const size = Number(value);

  if (
    !Number.isInteger(size) ||
    size < 1 ||
    size > MAX_BATCH_SIZE
  ) {
    throw new Error(
      `Batch size must be an integer between 1 and ${MAX_BATCH_SIZE}`
    );
  }

  return size;
}

function addResultSample(results, result) {
  if (!result) return;

  if (results.length < MAX_RESULT_SAMPLES) {
    results.push(result);
    return;
  }

  results.shift();
  results.push(result);
}

async function runFileWorker(
  migrationId,
  workerNumber,
  workerCount,
  sharedState
) {
  while (true) {
    const result = await migrateOneItem(
      migrationId,
      workerNumber,
      workerCount
    );

    if (
      !result ||
      result.message === "No pending migration items"
    ) {
      return;
    }

    sharedState.processed++;
    addResultSample(sharedState.results, result);

    if (
      result.status === "waiting_for_storage"
    ) {
      sharedState.deferredStorage = true;
      return;
    }

    if (
      result.status === "deferred_storage"
    ) {
      sharedState.deferredStorage = true;
      /*
       * The item is already requeued with a future next_retry_at. Avoid a
       * hot loop where the same worker immediately reclaims another item
       * that is likely to hit the same storage condition.
       */
      await sleep(DEFERRED_STORAGE_BACKOFF_MS);
      continue;
    }
  }
}

export async function runMigrationBatch(
  migrationId,
  requestedBatchSize
) {
  const batchSize = getBatchSize(
    requestedBatchSize
  );

  const before =
    await getMigrationStatus(migrationId);

  if (!before) {
    throw new Error("Migration not found");
  }

  if (before.cancel_requested) {
    await finalizeCancellationIfIdle(migrationId);
    const summary = await getMigrationSummary(migrationId);
    return {
      migrationId,
      status: summary?.status,
      processed: 0,
      results: [],
      summary,
      deferredStorage: false,
    };
  }

  if (
    before.status !== "pending" &&
    before.status !== "running" &&
    before.status !== "waiting_for_storage"
  ) {
    return {
      migrationId,
      status: before.status,
      processed: 0,
      results: [],
      summary: await getMigrationSummary(migrationId),
      deferredStorage: false,
    };
  }

  const workerCount = getConfiguredFileWorkers();

  const sharedState = {
    processed: 0,
    results: [],
    deferredStorage: false,
  };

  /*
   * Keep a fixed pool of file workers alive for the whole migration.
   * A worker immediately claims another item after finishing one instead of
   * waiting for the slowest worker in a 25-item batch. This removes the
   * stop/start "batch wave" effect that otherwise wastes throughput on large
   * migrations with files of different sizes.
   */
  const settled = await Promise.allSettled(
    Array.from(
      { length: workerCount },
      (_, index) =>
        runFileWorker(
          migrationId,
          index + 1,
          workerCount,
          sharedState
        )
    )
  );

  for (const [index, entry] of settled.entries()) {
    if (entry.status !== "rejected") continue;

    const workerNumber = index + 1;
    const message =
      entry.reason instanceof Error
        ? entry.reason.message
        : String(entry.reason);

    console.error(
      `[MIGRATION ${migrationId}] ` +
      `[WORKER ${workerNumber}/${workerCount}] Worker failed:`,
      message
    );

    sharedState.processed++;
    addResultSample(sharedState.results, {
      status: "error",
      workerNumber,
      error: message,
    });
  }

  const summary =
    await getMigrationSummary(migrationId);

  return {
    migrationId,
    status: summary?.status,
    processed: sharedState.processed,
    results: sharedState.results,
    summary,
    deferredStorage: sharedState.deferredStorage,
  };
}
