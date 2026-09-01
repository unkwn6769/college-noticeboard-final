import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Readable } from "node:stream";
import { google } from "googleapis";

import { ensureMigrationSafetySchema, pool } from "./db/database.js";
import {
  FencedWorkerError,
  abortItemTransfer,
  claimNextItem,
  clearRetryCount,
  classifyGoogleError,
  createTrackedUploadStream,
  getItemAbortController,
  heartbeatItemLease,
  incrementRetryCount,
  isFencedWorkerError,
  markAccountAuthorizationInvalid,
  markItemCompleted,
  markItemFailed,
  markItemReconciling,
  markItemReconciliationExpired,
  migrateOneItem,
  persistSourceDeleteOutcome,
  requeueItemAfterStorageWait,
  requeueItemAfterTransientFailure,
  startItemLeaseHeartbeat,
  stopItemLeaseHeartbeat,
  updateItemProgress,
} from "./migrationWorker.js";
import { recoverStaleRunningItems } from "./migrationScheduler.js";

process.env.TOKEN_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef";

function encryptTestToken(value) {
  const key = crypto
    .createHash("sha256")
    .update(process.env.TOKEN_ENCRYPTION_KEY)
    .digest();

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

await ensureMigrationSafetySchema();
await pool.query(`
  ALTER TABLE google_drive_account_migration_items
    ADD COLUMN IF NOT EXISTS bytes_transferred BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE google_drive_account_migration_items
    ADD COLUMN IF NOT EXISTS transfer_phase TEXT NOT NULL DEFAULT 'pending';
`);

async function createFenceFixture({
  itemId = `migration-item-${crypto.randomUUID()}`,
  leaseGeneration = 7,
} = {}) {
  const migrationId = `migration-fence-${crypto.randomUUID()}`;
  const sourceAccountId = `source-${crypto.randomUUID()}`;
  const targetAccountId = `target-${crypto.randomUUID()}`;
  const sourceClientId = encryptTestToken("client-id");
  const sourceClientSecret = encryptTestToken("client-secret");
  const sourceAccessToken = encryptTestToken("access-token");
  const sourceRefreshToken = encryptTestToken("refresh-token");
  const targetClientId = encryptTestToken("client-id-target");
  const targetClientSecret = encryptTestToken("client-secret-target");
  const targetAccessToken = encryptTestToken("access-token-target");
  const targetRefreshToken = encryptTestToken("refresh-token-target");

  await pool.query(
    `
      INSERT INTO google_drive_accounts (
        id,
        email,
        provider_account_id,
        client_id_encrypted,
        client_secret_encrypted,
        access_token_encrypted,
        refresh_token_encrypted,
        token_expires_at,
        redirect_uri,
        status
      )
      VALUES ($1, $2, $3, $7, $8, $9, $10, NULL, 'http://localhost/callback', 'connected'),
             ($4, $5, $6, $11, $12, $13, $14, NULL, 'http://localhost/callback', 'connected')
    `,
    [
      sourceAccountId,
      `${sourceAccountId}@example.test`,
      `${sourceAccountId}-provider`,
      targetAccountId,
      `${targetAccountId}@example.test`,
      `${targetAccountId}-provider`,
      sourceClientId,
      sourceClientSecret,
      sourceAccessToken,
      sourceRefreshToken,
      targetClientId,
      targetClientSecret,
      targetAccessToken,
      targetRefreshToken,
    ]
  );

  await pool.query(
    `
      INSERT INTO google_drive_account_migrations (
        id,
        source_account_id,
        target_account_id,
        status,
        total_files,
        completed_files,
        failed_files,
        current_file_id,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 'running', 1, 0, 0, NULL, NOW(), NOW())
    `,
    [migrationId, sourceAccountId, targetAccountId]
  );

  await pool.query(
    `
      INSERT INTO google_drive_account_migration_items (
        id,
        migration_id,
        source_file_id,
        target_file_id,
        target_account_id,
        size_bytes,
        lease_generation,
        status,
        source_delete_status,
        retry_count,
        reserved_bytes,
        speed_bytes_per_second,
        target_recovery_required,
        started_at,
        finished_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, NULL, $4, 1024, $5, 'running', 'pending', 0, 0, 0, FALSE, NOW(), NULL, NOW(), NOW())
    `,
    [itemId, migrationId, `source-${crypto.randomUUID()}`, targetAccountId, leaseGeneration]
  );

  return {
    itemId,
    migrationId,
    sourceAccountId,
    targetAccountId,
    leaseGeneration,
  };
}

async function cleanupFenceFixture({ itemId, migrationId, sourceAccountId, targetAccountId }) {
  if (itemId) {
    await pool.query("DELETE FROM google_drive_account_migration_items WHERE id = $1", [itemId]);
  }

  if (migrationId) {
    await pool.query("DELETE FROM google_drive_account_migrations WHERE id = $1", [migrationId]);
  }

  if (sourceAccountId) {
    await pool.query("DELETE FROM google_drive_accounts WHERE id = $1", [sourceAccountId]);
  }

  if (targetAccountId) {
    await pool.query("DELETE FROM google_drive_accounts WHERE id = $1", [targetAccountId]);
  }
}

test("heartbeatItemLease succeeds for the claimed generation", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 41 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET status = 'running',
          lease_expires_at = NOW() + INTERVAL '1 second',
          updated_at = NOW()
      WHERE id = $1
    `,
    [fixture.itemId]
  );

  const before = await pool.query(
    `SELECT lease_expires_at FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  await heartbeatItemLease(fixture.itemId, fixture.leaseGeneration);

  const after = await pool.query(
    `SELECT lease_expires_at, lease_generation, status FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(after.rows[0].status, "running");
  assert.equal(Number(after.rows[0].lease_generation), fixture.leaseGeneration);
  assert.ok(new Date(after.rows[0].lease_expires_at) > new Date(before.rows[0].lease_expires_at));
});

test("heartbeatItemLease rejects a stale lease_generation", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 43 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET status = 'running',
          lease_expires_at = NOW() + INTERVAL '10 minutes',
          updated_at = NOW()
      WHERE id = $1
    `,
    [fixture.itemId]
  );

  await assert.rejects(
    () => heartbeatItemLease(fixture.itemId, fixture.leaseGeneration + 1),
    (error) => error instanceof FencedWorkerError && error.message.includes(fixture.itemId)
  );
});

test("heartbeatItemLease rejects an expired lease", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 47 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET status = 'running',
          lease_expires_at = NOW() - INTERVAL '1 minute',
          updated_at = NOW()
      WHERE id = $1
    `,
    [fixture.itemId]
  );

  await assert.rejects(
    () => heartbeatItemLease(fixture.itemId, fixture.leaseGeneration),
    (error) => error instanceof FencedWorkerError && error.message.includes(fixture.itemId)
  );
});

test("heartbeatItemLease cannot renew a newer worker's lease", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 53 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET status = 'running',
          lease_generation = $1,
          lease_expires_at = NOW() - INTERVAL '1 minute',
          updated_at = NOW()
      WHERE id = $2
    `,
    [fixture.leaseGeneration, fixture.itemId]
  );

  const recovered = await recoverStaleRunningItems();

  assert.ok(recovered.some((item) => item.id === fixture.itemId));

  const row = await pool.query(
    `SELECT status, lease_generation, lease_expires_at FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(row.rows[0].status, "pending");
  assert.equal(Number(row.rows[0].lease_generation), fixture.leaseGeneration + 1);

  await assert.rejects(
    () => heartbeatItemLease(fixture.itemId, fixture.leaseGeneration),
    (error) => error instanceof FencedWorkerError && error.message.includes(fixture.itemId)
  );
});

test("recoverStaleRunningItems does not resurrect a valid lease", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 59 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET status = 'running',
          lease_expires_at = NOW() + INTERVAL '10 minutes',
          updated_at = NOW()
      WHERE id = $1
    `,
    [fixture.itemId]
  );

  const recovered = await recoverStaleRunningItems();
  const row = await pool.query(
    `SELECT status, lease_generation, lease_expires_at FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.deepEqual(recovered, []);
  assert.equal(row.rows[0].status, "running");
  assert.equal(Number(row.rows[0].lease_generation), fixture.leaseGeneration);
  assert.ok(row.rows[0].lease_expires_at !== null);
});

test("startItemLeaseHeartbeat and stopItemLeaseHeartbeat manage the timer lifecycle", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 61 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET status = 'running',
          lease_expires_at = NOW() + INTERVAL '10 minutes',
          updated_at = NOW()
      WHERE id = $1
    `,
    [fixture.itemId]
  );

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let tick = null;
  let cleared = false;

  globalThis.setInterval = (fn) => {
    tick = fn;
    return { cleared: false, unref() {} };
  };

  globalThis.clearInterval = (timer) => {
    timer.cleared = true;
    cleared = true;
  };

  try {
    const timer = startItemLeaseHeartbeat(fixture.itemId, fixture.leaseGeneration);
    assert.equal(typeof tick, "function");
    assert.ok(timer);

    await tick();

    const updated = await pool.query(
      `SELECT lease_expires_at FROM google_drive_account_migration_items WHERE id = $1`,
      [fixture.itemId]
    );

    assert.ok(updated.rows[0].lease_expires_at !== null);

    stopItemLeaseHeartbeat(fixture.itemId);
    assert.equal(cleared, true);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    stopItemLeaseHeartbeat(fixture.itemId);
  }
});

test("real DB fence predicate accepts the claimed generation and rejects a stale one", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 9 });
  t.after(() => cleanupFenceFixture(fixture));

  const countResult = await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET bytes_transferred = $1,
          transfer_phase = $2,
          updated_at = NOW()
      WHERE id = $3 AND lease_generation = $4
      RETURNING id, bytes_transferred, transfer_phase
    `,
    ["128", "uploading", fixture.itemId, fixture.leaseGeneration]
  );

  assert.equal(countResult.rowCount, 1);
  assert.equal(countResult.rows[0].transfer_phase, "uploading");

  const staleResult = await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET bytes_transferred = $1,
          transfer_phase = $2,
          updated_at = NOW()
      WHERE id = $3 AND lease_generation = $4
      RETURNING id
    `,
    ["999", "failed", fixture.itemId, fixture.leaseGeneration + 1]
  );

  assert.equal(staleResult.rowCount, 0);

  await assert.doesNotReject(() =>
    updateItemProgress(fixture.itemId, fixture.leaseGeneration, 128n, "verifying")
  );

  await assert.rejects(
    () => updateItemProgress(fixture.itemId, fixture.leaseGeneration + 1, 256n, "verifying"),
    (error) => error instanceof FencedWorkerError && error.message.includes(fixture.itemId)
  );

  const state = await pool.query(
    `SELECT bytes_transferred, transfer_phase, lease_generation FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(state.rows[0].bytes_transferred, "128");
  assert.equal(state.rows[0].transfer_phase, "verifying");
});

test("incrementRetryCount fences by the claimed lease_generation", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 11 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET retry_count = 1,
          last_retry_at = NOW(),
          next_retry_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [fixture.itemId]
  );

  await incrementRetryCount(fixture.itemId, fixture.leaseGeneration);

  const afterCorrect = await pool.query(
    `SELECT retry_count FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(Number(afterCorrect.rows[0].retry_count), 2);

  await assert.rejects(
    () => incrementRetryCount(fixture.itemId, fixture.leaseGeneration + 1),
    (error) => error instanceof FencedWorkerError && error.message.includes(fixture.itemId)
  );
});

test("clearRetryCount fences by the claimed lease_generation", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 17 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET retry_count = 4,
          last_retry_at = NOW(),
          next_retry_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [fixture.itemId]
  );

  await clearRetryCount(fixture.itemId, fixture.leaseGeneration);

  const afterCorrect = await pool.query(
    `SELECT retry_count, last_retry_at, next_retry_at FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(Number(afterCorrect.rows[0].retry_count), 0);
  assert.equal(afterCorrect.rows[0].last_retry_at, null);
  assert.equal(afterCorrect.rows[0].next_retry_at, null);

  await assert.rejects(
    () => clearRetryCount(fixture.itemId, fixture.leaseGeneration + 1),
    (error) => error instanceof FencedWorkerError && error.message.includes(fixture.itemId)
  );
});

test("persistSourceDeleteOutcome fences the post-delete status write", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 23 });
  t.after(() => cleanupFenceFixture(fixture));

  await persistSourceDeleteOutcome(
    fixture.itemId,
    fixture.leaseGeneration,
    "deleted",
    null
  );

  const afterCorrect = await pool.query(
    `SELECT source_delete_status, source_delete_error FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(afterCorrect.rows[0].source_delete_status, "deleted");
  assert.equal(afterCorrect.rows[0].source_delete_error, null);

  await assert.rejects(
    () => persistSourceDeleteOutcome(
      fixture.itemId,
      fixture.leaseGeneration + 1,
      "failed",
      "stale generation"
    ),
    (error) => error instanceof FencedWorkerError && error.message.includes(fixture.itemId)
  );

  const afterStale = await pool.query(
    `SELECT source_delete_status, source_delete_error FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(afterStale.rows[0].source_delete_status, "deleted");
  assert.equal(afterStale.rows[0].source_delete_error, null);
});

test("worker-owned mutation helpers are fenced by lease_generation", async (t) => {
  const cases = [
    {
      name: "updateItemProgress",
      run: async (itemId, generation) => {
        await updateItemProgress(itemId, generation, 10n, "uploading");
      },
      expect: (row) => row.transfer_phase === "uploading" && row.bytes_transferred === "10",
    },
    {
      name: "markItemCompleted",
      run: async (itemId, generation) => {
        await markItemCompleted(itemId, generation, "target-file-1");
      },
      expect: (row) => row.status === "completed" && row.target_file_id === "target-file-1",
    },
    {
      name: "markItemFailed",
      run: async (itemId, generation) => {
        await markItemFailed(itemId, generation, "failure reason");
      },
      expect: (row) => row.status === "failed" && row.error_message === "failure reason",
    },
    {
      name: "requeueItemAfterStorageWait",
      run: async (itemId, generation) => {
        await requeueItemAfterStorageWait(itemId, generation, "waiting for storage");
      },
      expect: (row) => row.status === "pending" && row.error_message === "waiting for storage",
    },
    {
      name: "requeueItemAfterTransientFailure",
      run: async (itemId, generation) => {
        await requeueItemAfterTransientFailure(itemId, generation, "transient okay", 250);
      },
      expect: (row) => row.status === "pending" && row.error_message === "transient okay",
    },
  ];

  for (const testCase of cases) {
    const fixture = await createFenceFixture({ leaseGeneration: 5 });
    t.after(() => cleanupFenceFixture(fixture));

    await testCase.run(fixture.itemId, fixture.leaseGeneration);

    const row = await pool.query(
      `SELECT status, target_file_id, error_message, bytes_transferred, transfer_phase FROM google_drive_account_migration_items WHERE id = $1`,
      [fixture.itemId]
    );

    assert.ok(testCase.expect(row.rows[0]), `${testCase.name} failed to write the expected state`);
  }
});

test("FencedWorkerError is propagated without stale-worker cleanup or requeue side effects", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 33 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET retry_count = 2,
          error_message = 'pre-fence',
          status = 'running',
          updated_at = NOW()
      WHERE id = $1
    `,
    [fixture.itemId]
  );

  const before = await pool.query(
    `SELECT retry_count, status, error_message FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  let fencedError;
  try {
    await updateItemProgress(fixture.itemId, fixture.leaseGeneration + 1, 777n, "uploading");
    assert.fail("Expected stale-generation update to fail");
  } catch (error) {
    fencedError = error;
    assert.ok(error instanceof FencedWorkerError, "Expected FencedWorkerError");
    assert.equal(isFencedWorkerError(error), true);
  }

  const after = await pool.query(
    `SELECT retry_count, status, error_message FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.ok(fencedError instanceof FencedWorkerError);
  assert.equal(after.rows[0].retry_count, before.rows[0].retry_count);
  assert.equal(after.rows[0].status, before.rows[0].status);
  assert.equal(after.rows[0].error_message, before.rows[0].error_message);
});

test("scheduler recovery invalidates an expired lease generation", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 13 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET status = 'running',
          lease_generation = $1,
          lease_expires_at = NOW() - INTERVAL '1 minute',
          updated_at = NOW()
      WHERE id = $2
    `,
    [fixture.leaseGeneration, fixture.itemId]
  );

  const recovered = await recoverStaleRunningItems();
  const row = await pool.query(
    `SELECT status, lease_generation, lease_expires_at, target_recovery_required FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.ok(recovered.some((item) => item.id === fixture.itemId));
  assert.equal(row.rows[0].status, "pending");
  assert.equal(Number(row.rows[0].lease_generation), fixture.leaseGeneration + 1);
  assert.equal(row.rows[0].lease_expires_at, null);
  assert.equal(row.rows[0].target_recovery_required, true);
});

test("old workers are fenced after scheduler recovery invalidates the lease", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 19 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET status = 'running',
          lease_generation = $1,
          lease_expires_at = NOW() - INTERVAL '1 minute',
          updated_at = NOW()
      WHERE id = $2
    `,
    [fixture.leaseGeneration, fixture.itemId]
  );

  await recoverStaleRunningItems();

  await assert.rejects(
    () => updateItemProgress(fixture.itemId, fixture.leaseGeneration, 5n, "uploading"),
    (error) => error instanceof FencedWorkerError && error.message.includes(fixture.itemId)
  );
});

test("new worker claim gets a newer generation after stale recovery", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 21 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET status = 'running',
          lease_generation = $1,
          lease_expires_at = NOW() - INTERVAL '1 minute',
          updated_at = NOW()
      WHERE id = $2
    `,
    [fixture.leaseGeneration, fixture.itemId]
  );

  await recoverStaleRunningItems();

  const claimed = await claimNextItem(fixture.migrationId);

  assert.ok(claimed);
  assert.ok(Number(claimed.lease_generation) > fixture.leaseGeneration);
  assert.equal(claimed.id, fixture.itemId);
});

test("recovery does not steal a valid lease", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 29 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET status = 'running',
          lease_generation = $1,
          lease_expires_at = NOW() + INTERVAL '10 minutes',
          updated_at = NOW()
      WHERE id = $2
    `,
    [fixture.leaseGeneration, fixture.itemId]
  );

  const recovered = await recoverStaleRunningItems();
  const row = await pool.query(
    `SELECT status, lease_generation, lease_expires_at FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(recovered.length, 0);
  assert.equal(row.rows[0].status, "running");
  assert.equal(Number(row.rows[0].lease_generation), fixture.leaseGeneration);
  assert.ok(row.rows[0].lease_expires_at !== null);
});

test("recovery and claim cannot race past a row lock", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 31 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET status = 'running',
          lease_generation = $1,
          lease_expires_at = NOW() - INTERVAL '1 minute',
          updated_at = NOW()
      WHERE id = $2
    `,
    [fixture.leaseGeneration, fixture.itemId]
  );

  const lockClient = await pool.connect();
  const blockedClient = await pool.connect();

  try {
    await lockClient.query("BEGIN");
    await lockClient.query(
      `SELECT id FROM google_drive_account_migration_items WHERE id = $1 FOR UPDATE`,
      [fixture.itemId]
    );

    await blockedClient.query("BEGIN");
    await blockedClient.query("SET LOCAL lock_timeout = '100ms'");

    await assert.rejects(
      () => blockedClient.query(
        `
          UPDATE google_drive_account_migration_items
          SET status = 'pending',
              lease_generation = lease_generation + 1,
              lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = $1
            AND status = 'running'
            AND lease_expires_at <= NOW()
        `,
        [fixture.itemId]
      ),
      (error) => /lock timeout|canceling statement due to lock timeout/i.test(String(error))
    );

    await lockClient.query("ROLLBACK");
    await blockedClient.query("ROLLBACK");

    const recovered = await recoverStaleRunningItems();
    assert.ok(recovered.some((item) => item.id === fixture.itemId));
  } finally {
    lockClient.release();
    blockedClient.release();
  }
});

test("createTrackedUploadStream preserves the fence error instead of swallowing it", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 4 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `UPDATE google_drive_account_migration_items SET lease_generation = $1, updated_at = NOW() WHERE id = $2`,
    [fixture.leaseGeneration + 10, fixture.itemId]
  );

  const tracker = createTrackedUploadStream(Readable.from([Buffer.from("abc")]), {
    itemId: fixture.itemId,
    leaseGeneration: fixture.leaseGeneration,
    startedAt: new Date(),
    sizeBytes: 3n,
  });

  await new Promise((resolve) => {
    tracker.on("finish", resolve);
    tracker.on("error", resolve);
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(tracker.getFenceError() instanceof FencedWorkerError);
  await assert.rejects(
    () => tracker.getProgressState(),
    (error) => error instanceof FencedWorkerError
  );

  const state = await pool.query(
    `SELECT bytes_transferred, transfer_phase FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(state.rows[0].bytes_transferred, "0");
  assert.equal(state.rows[0].transfer_phase, "pending");
});

test("cancel_requested exits before worker processing and does not mark the item failed", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 71 });
  t.after(() => cleanupFenceFixture(fixture));

  await pool.query(
    `UPDATE google_drive_account_migrations SET status = 'pending', cancel_requested = TRUE WHERE id = $1`,
    [fixture.migrationId]
  );

  const result = await migrateOneItem(fixture.migrationId);
  const itemRow = await pool.query(
    `SELECT status, retry_count, error_message FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(result.status, "pending");
  assert.equal(itemRow.rows[0].status, "running");
  assert.equal(Number(itemRow.rows[0].retry_count), 0);
  assert.equal(itemRow.rows[0].error_message, null);
});

test("AbortController aborts a tracked upload stream and triggers abort semantics", async (t) => {
  const fixture = await createFenceFixture({ leaseGeneration: 73 });
  t.after(() => cleanupFenceFixture(fixture));

  const controller = getItemAbortController(fixture.itemId);
  const source = new Readable({
    read() {
      setTimeout(() => {
        this.push(Buffer.from("hello"));
        setTimeout(() => this.push(null), 10);
      }, 10);
    },
  });

  const tracker = createTrackedUploadStream(source, {
    itemId: fixture.itemId,
    leaseGeneration: fixture.leaseGeneration,
    startedAt: new Date(),
    sizeBytes: 5n,
    abortController: controller,
  });

  const aborted = new Promise((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(true), { once: true });
    tracker.on("error", () => resolve(true));
  });

  controller.abort();
  const didAbort = await aborted;

  assert.equal(controller.signal.aborted, true);
  assert.equal(didAbort, true);
  assert.ok(tracker.destroyed || tracker.getFenceError() instanceof FencedWorkerError || tracker.readableEnded);

  abortItemTransfer(fixture.itemId);
  const itemState = await pool.query(
    `SELECT status, bytes_transferred, transfer_phase FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(itemState.rows[0].status, "running");
  assert.equal(itemState.rows[0].bytes_transferred, "0");
  assert.equal(itemState.rows[0].transfer_phase, "pending");
});

function makeAbortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

async function createLiveTransferFixture({
  itemId = `migration-item-live-${crypto.randomUUID()}`,
  leaseGeneration = 0,
} = {}) {
  const migrationId = `migration-live-${crypto.randomUUID()}`;
  const sourceAccountId = `source-live-${crypto.randomUUID()}`;
  const targetAccountId = `target-live-${crypto.randomUUID()}`;
  const sourceFileId = `source-file-${crypto.randomUUID()}`;
  const sourceClientId = encryptTestToken("client-id");
  const sourceClientSecret = encryptTestToken("client-secret");
  const sourceAccessToken = encryptTestToken("access-token");
  const sourceRefreshToken = encryptTestToken("refresh-token");
  const targetClientId = encryptTestToken("client-id-target");
  const targetClientSecret = encryptTestToken("client-secret-target");
  const targetAccessToken = encryptTestToken("access-token-target");
  const targetRefreshToken = encryptTestToken("refresh-token-target");

  await pool.query(
    `
      INSERT INTO google_drive_accounts (
        id,
        email,
        provider_account_id,
        client_id_encrypted,
        client_secret_encrypted,
        access_token_encrypted,
        refresh_token_encrypted,
        token_expires_at,
        redirect_uri,
        status
      )
      VALUES ($1, $2, $3, $7, $8, $9, $10, NULL, 'http://localhost/callback', 'connected'),
             ($4, $5, $6, $11, $12, $13, $14, NULL, 'http://localhost/callback', 'connected')
    `,
    [
      sourceAccountId,
      `${sourceAccountId}@example.test`,
      `${sourceAccountId}-provider`,
      targetAccountId,
      `${targetAccountId}@example.test`,
      `${targetAccountId}-provider`,
      sourceClientId,
      sourceClientSecret,
      sourceAccessToken,
      sourceRefreshToken,
      targetClientId,
      targetClientSecret,
      targetAccessToken,
      targetRefreshToken,
    ]
  );

  await pool.query(
    `
      INSERT INTO google_drive_account_migrations (
        id,
        source_account_id,
        target_account_id,
        status,
        total_files,
        completed_files,
        failed_files,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 'pending', 1, 0, 0, NOW(), NOW())
    `,
    [migrationId, sourceAccountId, targetAccountId]
  );

  await pool.query(
    `
      INSERT INTO google_drive_account_migration_items (
        id,
        migration_id,
        source_file_id,
        target_file_id,
        target_account_id,
        size_bytes,
        lease_generation,
        status,
        source_delete_status,
        retry_count,
        reserved_bytes,
        speed_bytes_per_second,
        target_recovery_required,
        started_at,
        finished_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, NULL, $4, 1024, $5, 'pending', 'pending', 0, 0, 0, FALSE, NOW(), NULL, NOW(), NOW())
    `,
    [itemId, migrationId, sourceFileId, targetAccountId, leaseGeneration]
  );

  return {
    itemId,
    migrationId,
    sourceAccountId,
    targetAccountId,
    sourceFileId,
    targetFileId: `target-file-${crypto.randomUUID()}`,
  };
}

async function cleanupLiveTransferFixture({ itemId, migrationId, sourceAccountId, targetAccountId }) {
  if (itemId) {
    await pool.query("DELETE FROM google_drive_account_migration_items WHERE id = $1", [itemId]);
  }
  if (migrationId) {
    await pool.query("DELETE FROM google_drive_account_migrations WHERE id = $1", [migrationId]);
  }
  if (sourceAccountId || targetAccountId) {
    await pool.query(
      "DELETE FROM google_drive_file_accounts WHERE account_id = ANY($1::text[])",
      [[sourceAccountId, targetAccountId].filter(Boolean)]
    );
  }
  if (sourceAccountId) {
    await pool.query("DELETE FROM google_drive_accounts WHERE id = $1", [sourceAccountId]);
  }
  if (targetAccountId) {
    await pool.query("DELETE FROM google_drive_accounts WHERE id = $1", [targetAccountId]);
  }
}

function createFakeDriveApi({
  sourceFileId,
  targetFileId,
  onDownloadStarted,
  onUploadStarted,
  deleteCalls,
}) {
  let openDownloadResolver = null;
  let openUploadResolver = null;

  const drive = {
    about: {
      get: async () => ({
        data: {
          storageQuota: {
            limit: "10737418240",
            usage: "0",
          },
        },
      }),
    },
    files: {
      get: async (params, options = {}) => {
        if (params.alt === "media") {
          return new Promise((resolve, reject) => {
            const stream = new Readable({
              read() {},
            });

            const abortListener = () => {
              stream.destroy();
              reject(makeAbortError("download aborted"));
            };

            if (options.signal) {
              if (options.signal.aborted) {
                reject(makeAbortError("download aborted"));
                return;
              }
              options.signal.addEventListener("abort", abortListener, { once: true });
            }

            onDownloadStarted?.();
            openDownloadResolver = () => {
              stream.push(Buffer.from("hello world"));
              stream.push(null);
              resolve({ data: stream });
            };
          });
        }

        if (params.fileId === sourceFileId) {
          return {
            data: {
              id: sourceFileId,
              name: "source.txt",
              size: "1024",
              mimeType: "text/plain",
              md5Checksum: "abc123",
            },
          };
        }

        if (params.fileId === targetFileId) {
          return {
            data: {
              id: targetFileId,
              name: "source.txt",
              size: "1024",
              mimeType: "text/plain",
              md5Checksum: "abc123",
            },
          };
        }

        return {
          data: { id: params.fileId, name: "unknown" },
        };
      },
      create: async (params, options = {}) => {
        return new Promise((resolve, reject) => {
          const abortListener = () => {
            reject(makeAbortError("upload aborted"));
          };

          if (options.signal) {
            if (options.signal.aborted) {
              reject(makeAbortError("upload aborted"));
              return;
            }
            options.signal.addEventListener("abort", abortListener, { once: true });
          }

          onUploadStarted?.();
          openUploadResolver = () => {
            resolve({
              data: {
                id: targetFileId,
                name: params.requestBody.name,
                size: "1024",
                mimeType: params.requestBody.mimeType,
                md5Checksum: "abc123",
                appProperties: params.requestBody.appProperties,
              },
            });
          };
        });
      },
      delete: async (params, options = {}) => {
        deleteCalls.push(params.fileId);
        if (options.signal?.aborted) {
          throw makeAbortError("delete aborted");
        }
        return { data: {} };
      },
      list: async () => ({ data: { files: [] } }),
    },
  };

  return {
    drive,
    releaseDownload() {
      openDownloadResolver?.();
    },
    releaseUpload() {
      openUploadResolver?.();
    },
  };
}

async function withFakeGoogleDrive(driveFactory, callback) {
  const originalDrive = google.drive;
  google.drive = driveFactory;
  try {
    await callback();
  } finally {
    google.drive = originalDrive;
  }
}

test("migrateOneItem aborts a live source download when cancellation is requested", async (t) => {
  const fixture = await createLiveTransferFixture();
  t.after(() => cleanupLiveTransferFixture(fixture));

  const deleteCalls = [];
  let startedResolve;
  const downloadStarted = new Promise((resolve) => {
    startedResolve = resolve;
  });

  const { drive, releaseDownload } = createFakeDriveApi({
    sourceFileId: fixture.sourceFileId,
    targetFileId: fixture.targetFileId,
    deleteCalls,
    onDownloadStarted: () => startedResolve(),
  });

  const controller = getItemAbortController(fixture.itemId);

  await withFakeGoogleDrive(() => drive, async () => {
    const runPromise = migrateOneItem(fixture.migrationId);
    await downloadStarted;

    await pool.query(
      `UPDATE google_drive_account_migrations SET cancel_requested = TRUE WHERE id = $1`,
      [fixture.migrationId]
    );

    abortItemTransfer(fixture.itemId);

    await assert.rejects(
      runPromise,
      (error) => error.name === "AbortError" || error.name === "CanceledError"
    );

    const itemRow = await pool.query(
      `SELECT status, retry_count, error_message FROM google_drive_account_migration_items WHERE id = $1`,
      [fixture.itemId]
    );

    assert.equal(itemRow.rows[0].status, "running");
    assert.equal(Number(itemRow.rows[0].retry_count), 0);
    assert.equal(itemRow.rows[0].error_message, null);
    assert.equal(deleteCalls.length, 0);

    const nextController = getItemAbortController(fixture.itemId);
    assert.notStrictEqual(nextController, controller);
  });

  releaseDownload();
});

test("migrateOneItem aborts a live target upload when cancellation is requested", async (t) => {
  const fixture = await createLiveTransferFixture();
  t.after(() => cleanupLiveTransferFixture(fixture));

  const deleteCalls = [];
  let downloadStartedResolve;
  let uploadStartedResolve;
  const downloadStarted = new Promise((resolve) => {
    downloadStartedResolve = resolve;
  });
  const uploadStarted = new Promise((resolve) => {
    uploadStartedResolve = resolve;
  });

  const { drive, releaseDownload, releaseUpload } = createFakeDriveApi({
    sourceFileId: fixture.sourceFileId,
    targetFileId: fixture.targetFileId,
    deleteCalls,
    onDownloadStarted: () => downloadStartedResolve(),
    onUploadStarted: () => uploadStartedResolve(),
  });

  await withFakeGoogleDrive(() => drive, async () => {
    const runPromise = migrateOneItem(fixture.migrationId);
    await downloadStarted;
    releaseDownload();
    await uploadStarted;

    await pool.query(
      `UPDATE google_drive_account_migrations SET cancel_requested = TRUE WHERE id = $1`,
      [fixture.migrationId]
    );

    abortItemTransfer(fixture.itemId);

    await assert.rejects(
      runPromise,
      (error) => error.name === "AbortError" || error.name === "CanceledError"
    );

    const itemRow = await pool.query(
      `SELECT status, retry_count, error_message FROM google_drive_account_migration_items WHERE id = $1`,
      [fixture.itemId]
    );

    assert.equal(itemRow.rows[0].status, "running");
    assert.equal(Number(itemRow.rows[0].retry_count), 0);
    assert.equal(itemRow.rows[0].error_message, null);
    assert.equal(deleteCalls.length, 0);
  });

  releaseUpload();
});

test("migrateOneItem propagates a fenced worker error during an active live transfer", async (t) => {
  const fixture = await createLiveTransferFixture();
  t.after(() => cleanupLiveTransferFixture(fixture));

  const deleteCalls = [];
  let downloadStartedResolve;
  let uploadStartedResolve;
  const downloadStarted = new Promise((resolve) => {
    downloadStartedResolve = resolve;
  });
  const uploadStarted = new Promise((resolve) => {
    uploadStartedResolve = resolve;
  });

  const { drive, releaseDownload, releaseUpload } = createFakeDriveApi({
    sourceFileId: fixture.sourceFileId,
    targetFileId: fixture.targetFileId,
    deleteCalls,
    onDownloadStarted: () => downloadStartedResolve(),
    onUploadStarted: () => uploadStartedResolve(),
  });

  let heartbeatTrigger = null;
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => {
    heartbeatTrigger = fn;
    return { unref() {} };
  };

  try {
    await withFakeGoogleDrive(() => drive, async () => {
      const runPromise = migrateOneItem(fixture.migrationId);
      await downloadStarted;
      releaseDownload();
      await uploadStarted;

      await pool.query(
        `
          UPDATE google_drive_account_migration_items
          SET lease_generation = lease_generation + 1,
              lease_expires_at = NOW() - INTERVAL '1 minute',
              updated_at = NOW()
          WHERE id = $1
        `,
        [fixture.itemId]
      );

      await assert.rejects(
        async () => {
          heartbeatTrigger?.();
          await runPromise;
        },
        (error) => error instanceof FencedWorkerError || isFencedWorkerError(error)
      );

      const itemRow = await pool.query(
        `SELECT status, retry_count, error_message FROM google_drive_account_migration_items WHERE id = $1`,
        [fixture.itemId]
      );

      assert.equal(itemRow.rows[0].status, "running");
      assert.equal(Number(itemRow.rows[0].retry_count), 0);
      assert.equal(deleteCalls.length, 0);
    });
  } finally {
    globalThis.setInterval = originalSetInterval;
    releaseUpload();
  }
});

test("migrateOneItem fails closed if the lease heartbeat query fails during an active transfer", async (t) => {
  const fixture = await createLiveTransferFixture();
  t.after(() => cleanupLiveTransferFixture(fixture));

  const deleteCalls = [];
  let downloadStartedResolve;
  let uploadStartedResolve;
  const downloadStarted = new Promise((resolve) => {
    downloadStartedResolve = resolve;
  });
  const uploadStarted = new Promise((resolve) => {
    uploadStartedResolve = resolve;
  });

  const { drive, releaseDownload, releaseUpload } = createFakeDriveApi({
    sourceFileId: fixture.sourceFileId,
    targetFileId: fixture.targetFileId,
    deleteCalls,
    onDownloadStarted: () => downloadStartedResolve(),
    onUploadStarted: () => uploadStartedResolve(),
  });

  let heartbeatTrigger = null;
  const originalSetInterval = globalThis.setInterval;
  const originalPoolQuery = pool.query.bind(pool);
  globalThis.setInterval = (fn) => {
    heartbeatTrigger = fn;
    return { unref() {} };
  };

  try {
    await withFakeGoogleDrive(() => drive, async () => {
      pool.query = async (...args) => {
        const [sqlText, params] = args;
        if (
          typeof sqlText === "string" &&
          sqlText.includes("UPDATE google_drive_account_migration_items") &&
          sqlText.includes("lease_expires_at") &&
          params && params[0] === fixture.itemId
        ) {
          throw new Error("heartbeat db unavailable");
        }
        return originalPoolQuery(...args);
      };

      const runPromise = migrateOneItem(fixture.migrationId);
      await downloadStarted;
      releaseDownload();
      await uploadStarted;

      await assert.rejects(
        async () => {
          heartbeatTrigger?.();
          await runPromise;
        },
        (error) => !isFencedWorkerError(error) && error instanceof Error && error.message.includes("heartbeat db unavailable")
      );

      const itemRow = await pool.query(
        `SELECT status, retry_count, error_message FROM google_drive_account_migration_items WHERE id = $1`,
        [fixture.itemId]
      );

      assert.equal(itemRow.rows[0].status, "running");
      assert.equal(Number(itemRow.rows[0].retry_count), 0);
      assert.equal(deleteCalls.length, 0);
    });
  } finally {
    pool.query = originalPoolQuery;
    globalThis.setInterval = originalSetInterval;
    releaseUpload();
  }
});

test("reconciliation keeps a zero-result target search in reconciling without uploading again", async (t) => {
  const fixture = await createLiveTransferFixture();
  t.after(() => cleanupLiveTransferFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET status = 'reconciling',
          target_recovery_required = TRUE,
          target_account_id = $1,
          reconciliation_deadline = NOW() + INTERVAL '10 minutes',
          lease_generation = 42,
          updated_at = NOW()
      WHERE id = $2
    `,
    [fixture.targetAccountId, fixture.itemId]
  );

  const fakeDrive = {
    about: {
      get: async () => ({ data: { storageQuota: { limit: "10737418240", usage: "0" } } }),
    },
    files: {
      get: async (params) => {
        if (params.alt === "media") {
          return {
            data: Readable.from([Buffer.from("hello world")]),
          };
        }

        if (params.fileId === fixture.sourceFileId) {
          return {
            data: {
              id: fixture.sourceFileId,
              name: "source.txt",
              size: "11",
              mimeType: "text/plain",
              md5Checksum: "abc123",
            },
          };
        }

        return { data: { id: params.fileId, name: "target.txt" } };
      },
      list: async () => ({ data: { files: [] } }),
      create: async () => {
        throw new Error("should not upload again");
      },
      delete: async () => {
        throw new Error("source delete should not run");
      },
    },
  };

  await withFakeGoogleDrive(() => fakeDrive, async () => {
    await migrateOneItem(fixture.migrationId);
  });

  const row = await pool.query(
    `SELECT status, target_recovery_required, error_message FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(row.rows[0].status, "reconciling");
  assert.equal(row.rows[0].target_recovery_required, true);
  assert.match(String(row.rows[0].error_message), /reconciliation/i);
});

test("reconciliation deadline expires the item instead of retrying upload", async (t) => {
  const fixture = await createLiveTransferFixture();
  t.after(() => cleanupLiveTransferFixture(fixture));

  const generationRow = await pool.query(
    `SELECT lease_generation FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );
  const generation = Number(generationRow.rows[0].lease_generation);

  await markItemReconciling(
    fixture.itemId,
    generation,
    "uncertain upload",
    0
  );

  await pool.query(
    `UPDATE google_drive_account_migration_items SET reconciliation_deadline = NOW() - INTERVAL '1 minute' WHERE id = $1`,
    [fixture.itemId]
  );

  const fakeDrive = {
    about: { get: async () => ({ data: { storageQuota: { limit: "10737418240", usage: "0" } } }) },
    files: {
      get: async (params) => {
        if (params.alt === "media") {
          return { data: Readable.from([Buffer.from("hello world")]) };
        }
        if (params.fileId === fixture.sourceFileId) {
          return { data: { id: fixture.sourceFileId, name: "source.txt", size: "11", mimeType: "text/plain", md5Checksum: "abc123" } };
        }
        return { data: { id: params.fileId, name: "target.txt" } };
      },
      list: async () => ({ data: { files: [] } }),
      create: async () => { throw new Error("should not retry after expiry"); },
      delete: async () => { throw new Error("source delete should never run"); },
    },
  };

  await withFakeGoogleDrive(() => fakeDrive, async () => {
    await migrateOneItem(fixture.migrationId);
  });

  const row = await pool.query(
    `SELECT status, error_message FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(row.rows[0].status, "reconciliation_expired");
  assert.match(String(row.rows[0].error_message), /deadline/i);
});

test("valid target discovery during reconciliation is adopted and completed without a new upload", async (t) => {
  const fixture = await createLiveTransferFixture();
  t.after(() => cleanupLiveTransferFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET status = 'reconciling',
          target_recovery_required = TRUE,
          target_account_id = $1,
          reconciliation_deadline = NOW() + INTERVAL '10 minutes',
          updated_at = NOW()
      WHERE id = $2
    `,
    [fixture.targetAccountId, fixture.itemId]
  );

  const targetFileId = `recovered-target-${crypto.randomUUID()}`;
  const uniquePath = `/source-${crypto.randomUUID()}.txt`;
  await pool.query(
    `
      INSERT INTO departments (id, slug, name, status, created_at, updated_at)
      VALUES (1, 'test-department', 'Test Department', 1, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `
  );
  await pool.query(
    `
      INSERT INTO resources (
        department_id,
        name,
        type,
        path,
        url,
        size,
        first_seen_at,
        last_seen_at,
        is_available,
        created_at,
        updated_at,
        storage_provider,
        storage_key,
        storage_status
      )
      VALUES (
        1,
        'source.txt',
        'file',
        $1,
        'https://example.test/source.txt',
        11,
        NOW(),
        NOW(),
        TRUE,
        NOW(),
        NOW(),
        'google_drive',
        $2,
        'synced'
      )
    `,
    [uniquePath, fixture.sourceFileId]
  );

  const fakeDrive = {
    about: { get: async () => ({ data: { storageQuota: { limit: "10737418240", usage: "0" } } }) },
    files: {
      get: async (params) => {
        if (params.alt === "media") {
          return { data: Readable.from([Buffer.from("hello world")]) };
        }
        if (params.fileId === fixture.sourceFileId) {
          return { data: { id: fixture.sourceFileId, name: "source.txt", size: "11", mimeType: "text/plain", md5Checksum: "abc123" } };
        }
        if (params.fileId === targetFileId) {
          return { data: { id: targetFileId, name: "source.txt", size: "11", mimeType: "text/plain", md5Checksum: "abc123", appProperties: { college_noticeboard_migration_item: fixture.itemId } } };
        }
        return { data: { id: params.fileId, name: "target.txt" } };
      },
      list: async () => ({ data: { files: [{ id: targetFileId, name: "source.txt", size: "11", mimeType: "text/plain", appProperties: { college_noticeboard_migration_item: fixture.itemId } }] } }),
      create: async () => { throw new Error("fresh upload should not happen when target already exists"); },
      delete: async () => ({ data: {} }),
    },
  };

  await withFakeGoogleDrive(() => fakeDrive, async () => {
    await migrateOneItem(fixture.migrationId);
  });

  const row = await pool.query(
    `SELECT status, target_file_id FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(row.rows[0].status, "completed");
  assert.equal(row.rows[0].target_file_id, targetFileId);
});

test("ambiguous reconciliation candidates are not adopted", async (t) => {
  const fixture = await createLiveTransferFixture();
  t.after(() => cleanupLiveTransferFixture(fixture));

  await pool.query(
    `
      UPDATE google_drive_account_migration_items
      SET status = 'reconciling',
          target_recovery_required = TRUE,
          target_account_id = $1,
          reconciliation_deadline = NOW() + INTERVAL '10 minutes',
          updated_at = NOW()
      WHERE id = $2
    `,
    [fixture.targetAccountId, fixture.itemId]
  );

  const fakeDrive = {
    about: { get: async () => ({ data: { storageQuota: { limit: "10737418240", usage: "0" } } }) },
    files: {
      get: async (params) => {
        if (params.alt === "media") {
          return { data: Readable.from([Buffer.from("hello world")]) };
        }
        if (params.fileId === fixture.sourceFileId) {
          return { data: { id: fixture.sourceFileId, name: "source.txt", size: "11", mimeType: "text/plain", md5Checksum: "abc123" } };
        }
        return { data: { id: params.fileId, name: "other.txt" } };
      },
      list: async () => ({ data: { files: [{ id: "wrong-1", appProperties: { college_noticeboard_migration_item: "different-item" } }, { id: "wrong-2", appProperties: { college_noticeboard_migration_item: "different-item" } }] } }),
      create: async () => { throw new Error("new upload must not start"); },
      delete: async () => { throw new Error("source delete must not happen"); },
    },
  };

  await withFakeGoogleDrive(() => fakeDrive, async () => {
    await migrateOneItem(fixture.migrationId);
  });

  const row = await pool.query(
    `SELECT status, target_file_id FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(row.rows[0].status, "reconciling");
  assert.equal(row.rows[0].target_file_id, null);
});
