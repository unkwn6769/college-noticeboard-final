import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import test, { after } from "node:test";
import pg from "pg";

import {
  claimExactItem,
  claimNextItem,
} from "./claim";
import { encryptText } from "../auth/encryption";

const { Client } = pg;

function getDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;

  if (!value) {
    throw new Error(
      "DATABASE_URL is required for claim integration tests",
    );
  }

  return value;
}

function makeEnv(): Env {
  return {
    HYPERDRIVE: {
      connectionString: getDatabaseUrl(),
    },
  } as unknown as Env;
}

type Fixture = {
  migrationId: string;
  itemId: string;
  sourceAccountId: string;
  targetAccountId: string;
};

async function createFixture(options: {
  itemStatus?: string;
  nextRetryAt?: string | null;
  reconciliationDeadline?: string | null;
  targetFileId?: string | null;
} = {}): Promise<Fixture> {
  const client = new Client({
    connectionString: getDatabaseUrl(),
  });

  await client.connect();

  const migrationId = `claim-test-migration-${crypto.randomUUID()}`;
  const itemId = `claim-test-item-${crypto.randomUUID()}`;
  const sourceAccountId = `claim-test-source-${crypto.randomUUID()}`;
  const targetAccountId = `claim-test-target-${crypto.randomUUID()}`;

  const {
    itemStatus = "pending",
    nextRetryAt = null,
    reconciliationDeadline = null,
    targetFileId = null,
  } = options;

  const secret = process.env.TOKEN_ENCRYPTION_KEY;

  if (!secret) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is required for claim integration tests",
    );
  }

  const encryptedClientId = await encryptText("client-id", secret);
  const encryptedClientSecret = await encryptText("client-secret", secret);
  const encryptedAccessToken = await encryptText("access-token", secret);
  const encryptedRefreshToken = await encryptText("refresh-token", secret);

  try {
    await client.query("BEGIN");

    await client.query(
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
      VALUES
        (
          $1,
          $2,
          $3,
          $7,
          $8,
          $9,
          $10,
          NULL,
          'http://localhost/callback',
          'connected'
        ),
        (
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          NULL,
          'http://localhost/callback',
          'connected'
        )
      `,
      [
        sourceAccountId,
        `${sourceAccountId}@example.test`,
        `${sourceAccountId}-provider`,
        targetAccountId,
        `${targetAccountId}@example.test`,
        `${targetAccountId}-provider`,
        encryptedClientId,
        encryptedClientSecret,
        encryptedAccessToken,
        encryptedRefreshToken,
      ],
    );

    await client.query(
      `
      INSERT INTO google_drive_account_migrations (
        id,
        source_account_id,
        target_account_id,
        status,
        total_files
      )
      VALUES (
        $1,
        $2,
        $3,
        'pending',
        1
      )
      `,
      [
        migrationId,
        sourceAccountId,
        targetAccountId,
      ],
    );

    await client.query(
      `
      INSERT INTO google_drive_account_migration_items (
        id,
        migration_id,
        source_file_id,
        target_file_id,
        target_account_id,
        size_bytes,
        bytes_transferred,
        transfer_phase,
        status,
        next_retry_at,
        reconciliation_deadline,
        target_recovery_required,
        lease_generation
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        1234,
        777,
        CASE
          WHEN $6 = 'reconciling' THEN 'reconciling'
          ELSE 'pending'
        END,
        $6,
        $7::timestamptz,
        $8::timestamptz,
        CASE
          WHEN $6 = 'reconciling' THEN TRUE
          ELSE FALSE
        END,
        7
      )
      `,
      [
        itemId,
        migrationId,
        `source-file-${crypto.randomUUID()}`,
        targetFileId,
        targetAccountId,
        itemStatus,
        nextRetryAt,
        reconciliationDeadline,
      ],
    );

    await client.query("COMMIT");

    return {
      migrationId,
      itemId,
      sourceAccountId,
      targetAccountId,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => { });
    throw error;
  } finally {
    await client.end();
  }
}

async function cleanupFixture(
  fixture: Fixture,
): Promise<void> {
  const client = new Client({
    connectionString: getDatabaseUrl(),
  });

  await client.connect();

  try {
    await client.query(
      `
      DELETE FROM google_drive_account_migrations
      WHERE id = $1
      `,
      [fixture.migrationId],
    );

    await client.query(
      `
      DELETE FROM google_drive_accounts
      WHERE id IN ($1, $2)
      `,
      [
        fixture.sourceAccountId,
        fixture.targetAccountId,
      ],
    );
  } finally {
    await client.end();
  }
}

const createdFixtures: Fixture[] = [];

async function fixture(
  options: Parameters<typeof createFixture>[0] = {},
): Promise<Fixture> {
  const value = await createFixture(options);
  createdFixtures.push(value);
  return value;
}

test("two consumers cannot claim the same item", async () => {
  const item = await fixture();

  const env = makeEnv();

  const [first, second] = await Promise.all([
    claimExactItem(
      env,
      item.migrationId,
      item.itemId,
    ),
    claimExactItem(
      env,
      item.migrationId,
      item.itemId,
    ),
  ]);

  const results = [first, second];
  const winners = results.filter(Boolean);

  assert.equal(winners.length, 1);
  assert.equal(winners[0]?.status, "running");
  assert.equal(
    winners[0]?.lease_generation,
    "8",
  );
});

test("a claimed item cannot be claimed again while running", async () => {
  const item = await fixture();

  const env = makeEnv();

  const first = await claimExactItem(
    env,
    item.migrationId,
    item.itemId,
  );

  assert.ok(first);

  const second = await claimExactItem(
    env,
    item.migrationId,
    item.itemId,
  );

  assert.equal(second, null);
});

test("future next_retry_at prevents claiming", async () => {
  const item = await fixture({
    nextRetryAt:
      "2999-01-01T00:00:00.000Z",
  });

  const result = await claimExactItem(
    makeEnv(),
    item.migrationId,
    item.itemId,
  );

  assert.equal(result, null);
});

test("valid reconciliation resumes without starting a new upload", async () => {
  const item = await fixture({
    itemStatus: "reconciling",
    nextRetryAt:
      "2020-01-01T00:00:00.000Z",
    reconciliationDeadline:
      "2999-01-01T00:00:00.000Z",
  });

  const result = await claimExactItem(
    makeEnv(),
    item.migrationId,
    item.itemId,
  );

  assert.ok(result);
  assert.equal(result.status, "running");
  assert.equal(
    result.transfer_phase,
    "reconciling",
  );
  assert.equal(
    result.lease_generation,
    "8",
  );
  assert.ok(result.reconciliation_deadline);
  assert.equal(
    new Date(result.reconciliation_deadline).toISOString(),
    "2999-01-01T00:00:00.000Z",
  );
});

test("expired reconciliation becomes reconciliation_expired", async () => {
  const item = await fixture({
    itemStatus: "reconciling",
    nextRetryAt:
      "2020-01-01T00:00:00.000Z",
    reconciliationDeadline:
      "2020-01-01T00:00:00.000Z",
  });

  const result = await claimExactItem(
    makeEnv(),
    item.migrationId,
    item.itemId,
  );

  assert.ok(result);
  assert.equal(
    result.status,
    "reconciliation_expired",
  );
  assert.equal(
    result.transfer_phase,
    "reconciliation_expired",
  );
  assert.equal(
    result.target_recovery_required,
    true,
  );
  assert.equal(
    result.lease_generation,
    "7",
  );
});

test("persisted target resumes in verifying phase", async () => {
  const item = await fixture({
    targetFileId: "existing-target-file",
  });

  const result = await claimExactItem(
    makeEnv(),
    item.migrationId,
    item.itemId,
  );

  assert.ok(result);
  assert.equal(result.status, "running");
  assert.equal(
    result.transfer_phase,
    "verifying",
  );
  assert.equal(
    result.target_file_id,
    "existing-target-file",
  );
  assert.equal(
    result.bytes_transferred,
    "777",
  );
});

test("claimNextItem prefers pending over reconciling", async () => {
  const pending = await fixture();

  const reconciling = await createFixture({
    itemStatus: "reconciling",
    nextRetryAt:
      "2020-01-01T00:00:00.000Z",
    reconciliationDeadline:
      "2999-01-01T00:00:00.000Z",
  });

  createdFixtures.push(reconciling);

  const result = await claimNextItem(
    makeEnv(),
    pending.migrationId,
  );

  assert.ok(result);
  assert.equal(result.id, pending.itemId);
});

after(async () => {
  for (const item of createdFixtures.reverse()) {
    await cleanupFixture(item).catch(() => { });
  }
});

test("expired running lease is reclaimed for reconciliation", async () => {
  const item = await fixture();

  const client = new Client({
    connectionString: getDatabaseUrl(),
  });

  await client.connect();

  try {
    await client.query(
      `
      UPDATE google_drive_account_migration_items
      SET
        status = 'running',
        lease_expires_at = NOW() - INTERVAL '1 minute',
        transfer_phase = 'downloading',
        target_recovery_required = FALSE,
        lease_generation = 19
      WHERE id = $1
      `,
      [item.itemId],
    );
  } finally {
    await client.end();
  }

  const claimed = await claimExactItem(
    makeEnv(),
    item.migrationId,
    item.itemId,
  );

  assert.ok(claimed);

  assert.equal(
    claimed.status,
    "running",
  );

  assert.equal(
    claimed.lease_generation,
    "20",
  );

  assert.equal(
    claimed.target_recovery_required,
    true,
  );

  assert.equal(
    claimed.transfer_phase,
    "reconciling",
  );

  assert.ok(
    claimed.reconciliation_deadline,
  );
});

test("reclaiming an expired upload lease preserves resumable upload state", async () => {
  const item = await fixture();

  const client = new Client({
    connectionString: getDatabaseUrl(),
  });

  await client.connect();

  try {
    await client.query(
      `
      UPDATE google_drive_account_migration_items
      SET
        status = 'running',
        lease_expires_at =
          NOW() - INTERVAL '1 minute',
        transfer_phase = 'uploading',
        upload_session_uri_encrypted =
          'encrypted-session-test',
        upload_bytes_committed = 104857600,
        upload_total_bytes = 209715200,
        bytes_transferred = 104857600,
        target_recovery_required = FALSE,
        lease_generation = 31
      WHERE id = $1
      `,
      [item.itemId],
    );
  } finally {
    await client.end();
  }

  const claimed = await claimExactItem(
    makeEnv(),
    item.migrationId,
    item.itemId,
  );

  assert.ok(claimed);

  assert.equal(
    claimed.status,
    "running",
  );

  assert.equal(
    claimed.lease_generation,
    "32",
  );

  assert.equal(
    claimed.transfer_phase,
    "uploading",
  );

  assert.equal(
    claimed.target_recovery_required,
    false,
  );

  assert.equal(
    claimed.upload_session_uri_encrypted,
    "encrypted-session-test",
  );

  assert.equal(
    claimed.upload_bytes_committed,
    "104857600",
  );

  assert.equal(
    claimed.upload_total_bytes,
    "209715200",
  );
});
