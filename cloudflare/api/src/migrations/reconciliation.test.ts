import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import pg from "pg";
import test, { after } from "node:test";

import {
  encryptText,
} from "../auth/encryption";

import {
  claimExactItem,
} from "./claim";

import {
  reconcileTarget,
} from "./reconciliation";

const { Client } = pg;

process.env.TOKEN_ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef";

function databaseUrl(): string {
  const value = process.env.DATABASE_URL;

  if (!value) {
    throw new Error(
      "DATABASE_URL is required",
    );
  }

  return value;
}

function env(): Env {
  return {
    HYPERDRIVE: {
      connectionString: databaseUrl(),
    },
    TOKEN_ENCRYPTION_KEY:
      process.env.TOKEN_ENCRYPTION_KEY!,
  } as unknown as Env;
}

type Fixture = {
  migrationId: string;
  itemId: string;
  sourceAccountId: string;
  targetAccountId: string;
};

const fixtures: Fixture[] = [];

async function createFixture(
  options: {
    deadline?: string;
    targetRecoveryRequired?: boolean;
    itemStatus?: "pending" | "reconciling";
  } = {},
): Promise<Fixture> {
  const client = new Client({
    connectionString: databaseUrl(),
  });

  await client.connect();

  const migrationId =
    `reconcile-test-${crypto.randomUUID()}`;
  const itemId =
    `reconcile-item-${crypto.randomUUID()}`;
  const sourceAccountId =
    `reconcile-source-${crypto.randomUUID()}`;
  const targetAccountId =
    `reconcile-target-${crypto.randomUUID()}`;

  const secret =
    process.env.TOKEN_ENCRYPTION_KEY!;

  const encrypted =
    await encryptText(
      "test-token",
      secret,
    );

  try {
    await client.query("BEGIN");

    for (const [id, label] of [
      [sourceAccountId, "source"],
      [targetAccountId, "target"],
    ]) {
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
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $4,
          $4,
          $4,
          NULL,
          'http://localhost/callback',
          'connected'
        )
        `,
        [
          id,
          `${id}@example.test`,
          `${id}-${label}`,
          encrypted,
        ],
      );
    }

    await client.query(
      `
      INSERT INTO google_drive_account_migrations (
        id,
        source_account_id,
        target_account_id,
        status,
        total_files
      )
      VALUES ($1, $2, $3, 'running', 1)
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
        target_account_id,
        size_bytes,
        status,
        transfer_phase,
        target_recovery_required,
        lease_generation,
        reconciliation_deadline,
        next_retry_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        1234,
        $6,
        CASE
          WHEN $6 = 'reconciling'
            THEN 'reconciling'
          ELSE 'pending'
        END,
        $5,
        7,
        $7::timestamptz,
        NOW()
      )
      `,
      [
        itemId,
        migrationId,
        `source-file-${crypto.randomUUID()}`,
        targetAccountId,
        options.targetRecoveryRequired ?? true,
        options.itemStatus ?? "pending",
        options.deadline ??
          "2999-01-01T00:00:00.000Z",
      ],
    );

    await client.query("COMMIT");

    const fixture = {
      migrationId,
      itemId,
      sourceAccountId,
      targetAccountId,
    };

    fixtures.push(fixture);
    return fixture;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function itemState(itemId: string) {
  const client = new Client({
    connectionString: databaseUrl(),
  });

  await client.connect();

  try {
    const result = await client.query(
      `
      SELECT
        status,
        target_file_id,
        target_recovery_required,
        transfer_phase,
        lease_generation
      FROM google_drive_account_migration_items
      WHERE id = $1
      `,
      [itemId],
    );

    assert.equal(result.rowCount, 1);
    return result.rows[0];
  } finally {
    await client.end();
  }
}

async function cleanupFixture(
  fixture: Fixture,
): Promise<void> {
  const client = new Client({
    connectionString: databaseUrl(),
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

async function claimedFixture() {
  const fixture = await createFixture();

  const claimed =
    await claimExactItem(
      env(),
      fixture.migrationId,
      fixture.itemId,
    );

  assert.ok(claimed);

  return {
    fixture,
    item: claimed,
  };
}

test("zero target candidates remain reconciling", async () => {
  const { fixture, item } =
    await claimedFixture();

  const originalFetch =
    globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      Response.json({
        files: [],
      });

    const result =
      await reconcileTarget(
        env(),
        item,
        {
          id: item.source_file_id,
          name: "example.txt",
          size: "1234",
          mimeType: "text/plain",
        },
        "target-access-token",
        item.lease_generation,
      );

    assert.equal(
      result.kind,
      "reconciling",
    );

    const state =
      await itemState(fixture.itemId);

    assert.equal(
      state.status,
      "reconciling",
    );
    assert.equal(
      state.target_recovery_required,
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("one valid target is adopted", async () => {
  const { fixture, item } =
    await claimedFixture();

  const originalFetch =
    globalThis.fetch;

  try {
    globalThis.fetch = async (input) => {
      const url = String(input);

      if (url.includes("/files?")) {
        return Response.json({
          files: [
            {
              id: "recovered-target",
              name: "example.txt",
              size: "1234",
              mimeType: "text/plain",
              md5Checksum: "abc",
              appProperties: {
                college_noticeboard_migration_item:
                  fixture.itemId,
              },
              trashed: false,
            },
          ],
        });
      }

      if (
        url.includes(
          "/files/recovered-target?",
        )
      ) {
        return Response.json({
          id: "recovered-target",
          name: "example.txt",
          size: "1234",
          mimeType: "text/plain",
          md5Checksum: "abc",
          appProperties: {
            college_noticeboard_migration_item:
              fixture.itemId,
          },
          trashed: false,
        });
      }

      throw new Error(
        `Unexpected request ${url}`,
      );
    };

    const result =
      await reconcileTarget(
        env(),
        item,
        {
          id: item.source_file_id,
          name: "example.txt",
          size: "1234",
          mimeType: "text/plain",
          md5Checksum: "abc",
        },
        "target-access-token",
        item.lease_generation,
      );

    assert.equal(
      result.kind,
      "continue",
    );

    const state =
      await itemState(fixture.itemId);

    assert.equal(
      state.target_file_id,
      "recovered-target",
    );
    assert.equal(
      state.target_recovery_required,
      false,
    );
    assert.equal(
      state.transfer_phase,
      "verifying",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("multiple targets remain unresolved", async () => {
  const { fixture, item } =
    await claimedFixture();

  const originalFetch =
    globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      Response.json({
        files: [
          { id: "target-a" },
          { id: "target-b" },
        ],
      });

    const result =
      await reconcileTarget(
        env(),
        item,
        {
          id: item.source_file_id,
          name: "example.txt",
          size: "1234",
          mimeType: "text/plain",
        },
        "target-access-token",
        item.lease_generation,
      );

    assert.equal(
      result.kind,
      "reconciling",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("expired reconciliation becomes reconciliation_expired", async () => {
  const fixture =
    await createFixture({
      itemStatus: "reconciling",
      deadline:
        "2020-01-01T00:00:00.000Z",
    });

  const claimed =
    await claimExactItem(
      env(),
      fixture.migrationId,
      fixture.itemId,
    );

  assert.ok(claimed);

  const originalFetch =
    globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      Response.json({
        files: [],
      });

    const result =
      await reconcileTarget(
        env(),
        claimed,
        {
          id: claimed.source_file_id,
          name: "example.txt",
          size: "1234",
          mimeType: "text/plain",
        },
        "target-access-token",
        claimed.lease_generation,
      );

    assert.equal(
      result.kind,
      "expired",
    );

    const state =
      await itemState(fixture.itemId);

    assert.equal(
      state.status,
      "reconciliation_expired",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

after(async () => {
  for (const fixture of fixtures.reverse()) {
    await cleanupFixture(fixture).catch(() => {});
  }
});
