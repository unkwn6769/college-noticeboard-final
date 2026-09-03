import { pool } from "./db/database.js";
import crypto from "node:crypto";
import {
  runMigrationBatch,
} from "./migrationRunner.js";
import {
  retryFailedSourceDeletion,
} from "./migrationWorker.js";

const BATCH_SIZE = 25;
const POLL_MS = 1000;
const MAX_CONCURRENT_MIGRATIONS = 3;
const SCHEDULER_LEASE_ID = 1;
const SCHEDULER_LEASE_MS = 15_000;
const SCHEDULER_HEARTBEAT_MS = 5_000;
const CLEANUP_POLL_MS = 30_000;
let lastCleanupCheck = 0;

/*
 * If the server restarts while an item is being processed,
 * that item may remain "running" forever.
 *
 * Scheduler startup occurs only after this process acquires the
 * database-backed scheduler lease. Therefore any running item found
 * here belongs to interrupted work from a previous process and can
 * be safely returned to the pending queue.
 *
 * Preserve target_file_id/target_account_id and transfer metadata
 * because a previous upload may already exist in Drive.
 *
 * Cancelled migrations are also requeued here deliberately:
 * findRunnableMigrations() excludes cancel_requested migrations,
 * while finalizeOrphanedCancellationRequests() requires there to
 * be no running items. Requeuing the interrupted item allows the
 * cancellation finalizer to converge the migration to cancelled
 * instead of leaving it permanently running.
 */
let schedulerRunning = false;
let schedulerLeaseOwnerId = null;
let schedulerHeartbeatTimer = null;
let schedulerStopRequested = false;
const activeMigrationIds = new Set();

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

export async function recoverStaleRunningItems() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const staleItems = await client.query(
      `
      SELECT
        i.id,
        i.migration_id,
        i.source_file_id,
        i.lease_generation
      FROM google_drive_account_migration_items i
      JOIN google_drive_account_migrations m
        ON m.id = i.migration_id
      WHERE i.status = 'running'
        AND i.lease_expires_at IS NOT NULL
        AND i.lease_expires_at <= NOW()
        AND m.status IN (
          'pending',
          'running',
          'waiting_for_storage'
        )
      FOR UPDATE SKIP LOCKED
      `
    );

    if (staleItems.rowCount === 0) {
      await client.query("COMMIT");
      return [];
    }

    const staleItemIds = staleItems.rows.map((row) => row.id);

    const result = await client.query(
      `
      UPDATE google_drive_account_migration_items i
      SET
        status = 'pending',
        started_at = NULL,
        finished_at = NULL,
        reserved_bytes = 0,
        lease_generation = i.lease_generation + 1,
        lease_expires_at = NULL,

        /*
         * Keep target_file_id/target_account_id and their transfer metadata.
         *
         * A crash may already have produced a durable target in Drive.
         * migrationWorker will reconcile that target before creating another
         * upload.
         */
        bytes_transferred = CASE
          WHEN i.target_file_id IS NOT NULL
            THEN i.bytes_transferred
          ELSE 0
        END,

        transfer_phase = CASE
          WHEN i.target_file_id IS NOT NULL
            THEN 'verifying'
          ELSE 'pending'
        END,

        target_recovery_required = TRUE,
        error_message = NULL,
        updated_at = NOW()
      WHERE i.id = ANY($1::text[])
        AND i.status = 'running'
        AND i.lease_expires_at IS NOT NULL
        AND i.lease_expires_at <= NOW()
      RETURNING
        i.id,
        i.migration_id,
        i.source_file_id,
        i.lease_generation
      `,
      [staleItemIds]
    );

    await client.query("COMMIT");

    if (result.rowCount > 0) {
      console.log(
        `[MIGRATION SCHEDULER] Recovered ${result.rowCount} stale running item(s)`
      );

      for (const item of result.rows) {
        console.log(
          `[MIGRATION SCHEDULER] Requeued item ${item.id} ` +
          `(${item.source_file_id}) for migration ${item.migration_id} ` +
          `(generation ${item.lease_generation})`
        );
      }
    } else {
      console.log(
        "[MIGRATION SCHEDULER] No stale migration items to recover"
      );
    }

    return result.rows;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failures during recovery races
    }

    throw error;
  } finally {
    client.release();
  }
}


async function finalizeOrphanedCancellationRequests() {
  const result = await pool.query(`
    UPDATE google_drive_account_migrations m
    SET
      status = 'cancelled',
      finished_at = COALESCE(finished_at, NOW()),
      updated_at = NOW()
    WHERE m.cancel_requested = TRUE
      AND m.status IN ('pending', 'running', 'waiting_for_storage')
      AND NOT EXISTS (
        SELECT 1
        FROM google_drive_account_migration_items i
        WHERE i.migration_id = m.id
          AND i.status = 'running'
      )
    RETURNING id
  `);

  for (const row of result.rows) {
    console.log(
      `[MIGRATION SCHEDULER] Finalized cancelled migration ${row.id}`
    );
  }
}

async function findRunnableMigrations(limit) {
  const excluded = [...activeMigrationIds];

  const result = await pool.query(
    `
    SELECT id
    FROM google_drive_account_migrations
    WHERE status IN ('pending', 'running')
      AND cancel_requested = FALSE
      AND NOT (id = ANY($1::text[]))
    ORDER BY created_at ASC
    LIMIT $2
    `,
    [excluded, limit]
  );

  return result.rows.map((row) => row.id);
}

async function ensureSchedulerLeaseSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migration_scheduler_leases (
      id INTEGER PRIMARY KEY,
      owner_id TEXT NOT NULL,
      acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function acquireSchedulerLease() {
  await ensureSchedulerLeaseSchema();

  const ownerId = crypto.randomUUID();

  const result = await pool.query(
    `
    INSERT INTO migration_scheduler_leases (
      id,
      owner_id,
      acquired_at,
      heartbeat_at
    )
    VALUES ($1, $2, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE
    SET
      owner_id = EXCLUDED.owner_id,
      acquired_at = NOW(),
      heartbeat_at = NOW()
    WHERE migration_scheduler_leases.heartbeat_at <
            NOW() - ($3 * INTERVAL '1 millisecond')
    RETURNING id, owner_id, heartbeat_at
    `,
    [SCHEDULER_LEASE_ID, ownerId, SCHEDULER_LEASE_MS]
  );

  if (result.rowCount !== 1) {
    return false;
  }

  schedulerLeaseOwnerId = ownerId;
  return true;
}

async function heartbeatSchedulerLease() {
  if (!schedulerLeaseOwnerId) {
    return false;
  }

  const result = await pool.query(
    `
    UPDATE migration_scheduler_leases
    SET heartbeat_at = NOW()
    WHERE id = $1
      AND owner_id = $2
    RETURNING id
    `,
    [SCHEDULER_LEASE_ID, schedulerLeaseOwnerId]
  );

  if (result.rowCount !== 1) {
    console.error(
      "[MIGRATION SCHEDULER] Scheduler lease was lost; stopping scheduling"
    );
    schedulerStopRequested = true;
    return false;
  }

  return true;
}

async function releaseSchedulerLease() {
  if (!schedulerLeaseOwnerId) {
    return;
  }

  const ownerId = schedulerLeaseOwnerId;
  schedulerLeaseOwnerId = null;

  try {
    await pool.query(
      `
      DELETE FROM migration_scheduler_leases
      WHERE id = $1
        AND owner_id = $2
      `,
      [SCHEDULER_LEASE_ID, ownerId]
    );
  } catch (error) {
    console.error(
      "[MIGRATION SCHEDULER] Failed to release scheduler lease:",
      error instanceof Error ? error.message : error
    );
  }
}

function startSchedulerHeartbeat() {
  if (schedulerHeartbeatTimer) {
    clearInterval(schedulerHeartbeatTimer);
  }

  schedulerHeartbeatTimer = setInterval(() => {
    heartbeatSchedulerLease().catch((error) => {
      console.error(
        "[MIGRATION SCHEDULER] Lease heartbeat failed:",
        error instanceof Error ? error.message : error
      );
      schedulerStopRequested = true;
    });
  }, SCHEDULER_HEARTBEAT_MS);

  schedulerHeartbeatTimer.unref?.();
}

function stopSchedulerHeartbeat() {
  if (!schedulerHeartbeatTimer) {
    return;
  }

  clearInterval(schedulerHeartbeatTimer);
  schedulerHeartbeatTimer = null;
}

export async function stopMigrationScheduler() {
  schedulerStopRequested = true;
  stopSchedulerHeartbeat();

  if (!schedulerLeaseOwnerId) {
    schedulerRunning = false;
    return;
  }

  await releaseSchedulerLease();
  schedulerRunning = false;
}

function launchMigration(migrationId) {
  activeMigrationIds.add(migrationId);

  console.log(
    `[MIGRATION SCHEDULER] Processing ${migrationId} ` +
    `(active migrations: ${activeMigrationIds.size}/${MAX_CONCURRENT_MIGRATIONS})`
  );

  processMigration(migrationId)
    .catch((error) => {
      console.error(
        `[MIGRATION SCHEDULER] Migration ${migrationId} failed:`,
        error instanceof Error ? error.message : error
      );
    })
    .finally(() => {
      activeMigrationIds.delete(migrationId);
    });
}

async function retryFailedSourceDeletions() {
  const result = await pool.query(
    `
    SELECT
      i.id
    FROM google_drive_account_migration_items i
    WHERE i.status = 'completed'
      AND i.source_delete_status IN ('pending', 'failed')
      AND (i.cleanup_next_attempt_at IS NULL OR i.cleanup_next_attempt_at <= NOW())
    ORDER BY i.updated_at ASC
    LIMIT 10
    `
  );

  for (const item of result.rows) {
    try {
      await retryFailedSourceDeletion(
        item.id
      );
    } catch (error) {
      console.error(
        `[MIGRATION SCHEDULER] ` +
        `Source cleanup retry failed for ${item.id}:`,
        error instanceof Error
          ? error.message
          : error
      );
    }
  }
}

async function retryWaitingMigrations() {
  const result = await pool.query(`
    SELECT id
    FROM google_drive_account_migrations
    WHERE status = 'waiting_for_storage'
      AND cancel_requested = FALSE
      AND updated_at <= NOW() - INTERVAL '30 seconds'
    ORDER BY created_at ASC
    LIMIT 10
  `);

  for (const migration of result.rows) {
    try {
      const updated = await pool.query(
        `
        UPDATE google_drive_account_migrations
        SET
          status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'pending' END,
          finished_at = CASE WHEN cancel_requested THEN COALESCE(finished_at, NOW()) ELSE finished_at END,
          updated_at = NOW()
        WHERE id = $1
          AND status = 'waiting_for_storage'
        RETURNING id
        `,
        [migration.id]
      );

      if (updated.rowCount > 0) {
        console.log(
          `[MIGRATION SCHEDULER] ` +
          `Retrying storage check for ${migration.id}`
        );
      }
    } catch (error) {
      console.error(
        `[MIGRATION SCHEDULER] Storage retry update failed for ${migration.id}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
}

async function processMigration(
  migrationId
) {
  while (true) {
    const result =
      await runMigrationBatch(
        migrationId,
        BATCH_SIZE
      );

    const status =
      result.summary?.status;

    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      return;
    }

    if (
      status === "waiting_for_storage"
    ) {
      console.log(
        `[MIGRATION SCHEDULER] ` +
        `Migration ${migrationId} is waiting for storage`
      );

      return;
    }

    if (result.deferredStorage) {
      await sleep(POLL_MS);
      continue;
    }

    if (
      result.processed === 0
    ) {
      await sleep(POLL_MS);
    }
  }
}

export async function startMigrationScheduler() {
  if (schedulerRunning) {
    return;
  }

  schedulerRunning = true;
  schedulerStopRequested = false;

  console.log(
    "Migration scheduler started"
  );

  /*
   * Recover interrupted work before starting
   * the normal scheduler loop.
   */
  let acquired = false;

  /*
   * Render deployments can briefly overlap old and new instances.
   * Do not permanently abandon scheduling when another instance
   * currently owns the lease. Wait and retry until the old lease
   * is released or expires.
   */
  while (!schedulerStopRequested) {
    acquired = await acquireSchedulerLease();

    if (acquired) {
      break;
    }

    console.log(
      `[MIGRATION SCHEDULER] Lease is currently held; retrying in ${
        SCHEDULER_HEARTBEAT_MS / 1000
      }s`
    );

    await sleep(SCHEDULER_HEARTBEAT_MS);
  }

  if (!acquired) {
    schedulerRunning = false;
    return;
  }

  if (schedulerStopRequested) {
    await releaseSchedulerLease();
    schedulerRunning = false;
    return;
  }

  startSchedulerHeartbeat();

  try {
    try {
      await recoverStaleRunningItems();
    } catch (error) {
      console.error(
        "[MIGRATION SCHEDULER] Failed to recover stale items:",
        error
      );
    }

    try {
      await finalizeOrphanedCancellationRequests();
    } catch (error) {
      console.error(
        "[MIGRATION SCHEDULER] Failed to finalize cancellation requests:",
        error
      );
    }

    while (!schedulerStopRequested) {
      const now = Date.now();

      if (
        now - lastCleanupCheck >=
        CLEANUP_POLL_MS
      ) {
        lastCleanupCheck = now;

        try {
          await retryFailedSourceDeletions();
        } catch (error) {
          console.error(
            "[MIGRATION SCHEDULER] " +
            "Failed source cleanup reconciliation:",
            error
          );
        }
      }

      if (schedulerStopRequested) {
        break;
      }

      await retryWaitingMigrations();

      if (schedulerStopRequested) {
        break;
      }

      const availableSlots =
        MAX_CONCURRENT_MIGRATIONS -
        activeMigrationIds.size;

      if (availableSlots > 0) {
        const migrationIds =
          await findRunnableMigrations(availableSlots);

        for (const migrationId of migrationIds) {
          launchMigration(migrationId);
        }
      }

      if (activeMigrationIds.size === 0) {
        await sleep(POLL_MS);
      } else {
        await sleep(Math.min(POLL_MS, 250));
      }
    }
  } finally {
    stopSchedulerHeartbeat();
    await releaseSchedulerLease();
    schedulerRunning = false;
  }
}