import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { ensureMigrationSafetySchema, pool } from "./db/database.js";
import {
  classifyGoogleError,
  markAccountAuthorizationInvalid,
  persistSourceDeleteOutcome,
} from "./migrationWorker.js";

await ensureMigrationSafetySchema();

async function createAccountRow() {
  const accountId = `auth-${crypto.randomUUID()}`;
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
        redirect_uri,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'connected')
    `,
    [
      accountId,
      `${accountId}@example.test`,
      `${accountId}-provider`,
      "enc-client",
      "enc-secret",
      "enc-access",
      "enc-refresh",
      "http://localhost/callback",
    ]
  );

  return accountId;
}

async function createMigrationItemRow({ leaseGeneration = 17 } = {}) {
  const migrationId = `migration-fix67-${crypto.randomUUID()}`;
  const itemId = `migration-item-fix67-${crypto.randomUUID()}`;
  const sourceAccountId = await createAccountRow();
  const targetAccountId = await createAccountRow();

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
      VALUES ($1, $2, $3, 'running', 1, 0, 0, NOW(), NOW())
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

  return { itemId, migrationId, sourceAccountId, targetAccountId };
}

test("classifyGoogleError marks an invalid Google authorization as authorization_invalid", () => {
  const error = {
    response: {
      status: 401,
      data: {
        error: {
          errors: [{ reason: "invalid_grant" }],
        },
      },
    },
  };

  const classification = classifyGoogleError(error);

  assert.equal(classification.type, "authorization_invalid");
  assert.equal(classification.reason, "invalid_grant");
});

test("markAccountAuthorizationInvalid marks the account status in PostgreSQL", async (t) => {
  const accountId = await createAccountRow();
  t.after(async () => {
    await pool.query("DELETE FROM google_drive_accounts WHERE id = $1", [accountId]);
  });

  const changed = await markAccountAuthorizationInvalid(accountId, "token revoked");
  const row = await pool.query(
    `SELECT status FROM google_drive_accounts WHERE id = $1`,
    [accountId]
  );

  assert.equal(changed, true);
  assert.equal(row.rows[0].status, "authorization_invalid");
});

test("persistSourceDeleteOutcome accepts a blocked target missing state", async (t) => {
  const fixture = await createMigrationItemRow({ leaseGeneration: 51 });
  t.after(async () => {
    await pool.query("DELETE FROM google_drive_account_migration_items WHERE id = $1", [fixture.itemId]);
    await pool.query("DELETE FROM google_drive_account_migrations WHERE id = $1", [fixture.migrationId]);
    await pool.query("DELETE FROM google_drive_accounts WHERE id = $1", [fixture.sourceAccountId]);
    await pool.query("DELETE FROM google_drive_accounts WHERE id = $1", [fixture.targetAccountId]);
  });

  await persistSourceDeleteOutcome(
    fixture.itemId,
    51,
    "blocked_target_missing",
    "Target file disappeared after mapping commit"
  );

  const row = await pool.query(
    `SELECT source_delete_status, source_delete_error FROM google_drive_account_migration_items WHERE id = $1`,
    [fixture.itemId]
  );

  assert.equal(row.rows[0].source_delete_status, "blocked_target_missing");
  assert.match(row.rows[0].source_delete_error, /Target file disappeared/i);
});
