import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import pg from "pg";
import test, { after } from "node:test";

import { encryptText } from "../auth/encryption";
import {
  processMigrationItem,
} from "./processItem";

const { Client } = pg;

process.env.TOKEN_ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef";

function databaseUrl(): string {
  const value = process.env.DATABASE_URL;

  if (!value) {
    throw new Error(
      "DATABASE_URL is required for processor integration tests",
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
  sourceFileId: string;
};

const fixtures: Fixture[] = [];

async function createFixture(
  options: {
    targetFileId?: string | null;
  } = {},
): Promise<Fixture> {
  const client = new Client({
    connectionString: databaseUrl(),
  });

  await client.connect();

  const migrationId =
    `processor-test-migration-${crypto.randomUUID()}`;

  const itemId =
    `processor-test-item-${crypto.randomUUID()}`;

  const sourceAccountId =
    `processor-test-source-${crypto.randomUUID()}`;

  const targetAccountId =
    `processor-test-target-${crypto.randomUUID()}`;

  const sourceFileId =
    `processor-test-source-file-${crypto.randomUUID()}`;

  const secret = process.env.TOKEN_ENCRYPTION_KEY!;

  const encryptedClientId =
    await encryptText("client-id", secret);

  const encryptedClientSecret =
    await encryptText("client-secret", secret);

  const encryptedAccessToken =
    await encryptText("access-token", secret);

  const encryptedRefreshToken =
    await encryptText("refresh-token", secret);

  try {
    await client.query("BEGIN");

    for (const [id, suffix] of [
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
          $5,
          $6,
          $7,
          NULL,
          'http://localhost/callback',
          'connected'
        )
        `,
        [
          id,
          `${id}@example.test`,
          `${id}-provider-${suffix}`,
          encryptedClientId,
          encryptedClientSecret,
          encryptedAccessToken,
          encryptedRefreshToken,
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
      VALUES ($1, $2, $3, 'pending', 1)
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
        status,
        transfer_phase,
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
        0,
        'pending',
        'pending',
        FALSE,
        7
      )
      `,
      [
        itemId,
        migrationId,
        sourceFileId,
        options.targetFileId ?? null,
        targetAccountId,
      ],
    );

    await client.query("COMMIT");

    const fixture = {
      migrationId,
      itemId,
      sourceAccountId,
      targetAccountId,
      sourceFileId,
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

async function queryItem(
  itemId: string,
): Promise<{
  status: string;
  target_file_id: string | null;
  lease_generation: string;
  transfer_phase: string;
}> {
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
        lease_generation,
        transfer_phase
      FROM google_drive_account_migration_items
      WHERE id = $1
      `,
      [itemId],
    );

    assert.equal(result.rows.length, 1);

    return result.rows[0];
  } finally {
    await client.end();
  }
}

async function cleanup(
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

test("processor performs a Google-side copy and completes the item", async () => {
  const fixture = await createFixture();

  const originalFetch = globalThis.fetch;

  let sourceGets = 0;
  let copies = 0;

  try {
    globalThis.fetch = async (
      input,
      init,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      assert.match(
        String(
          new Headers(init?.headers)
            .get("authorization"),
        ),
        /^Bearer access-token$/,
      );

      if (
        method === "GET" &&
        url.includes(
          `/files/${fixture.sourceFileId}`,
        )
      ) {
        sourceGets += 1;

        return Response.json({
          id: fixture.sourceFileId,
          name: "example.pdf",
          size: "1234",
          mimeType: "application/pdf",
          md5Checksum: "source-md5",
          appProperties: {},
          trashed: false,
        });
      }

      if (
        method === "POST" &&
        url.includes(
          `/files/${fixture.sourceFileId}/copy`,
        )
      ) {
        copies += 1;

        const body = JSON.parse(
          String(init?.body ?? ""),
        );

        assert.equal(body.name, "example.pdf");
        assert.deepEqual(
          body.parents,
          ["root"],
        );
        assert.equal(
          body.appProperties
            .college_noticeboard_migration_item,
          fixture.itemId,
        );

        return Response.json({
          id: "processor-target-1",
          name: "example.pdf",
          size: "1234",
          mimeType: "application/pdf",
          md5Checksum: "source-md5",
          appProperties: {
            college_noticeboard_migration_item:
              fixture.itemId,
          },
        });
      }

      throw new Error(
        `Unexpected Google request: ${method} ${url}`,
      );
    };

    const result =
      await processMigrationItem(
        env(),
        {
          migrationId:
            fixture.migrationId,
          itemId: fixture.itemId,
        },
      );

    assert.deepEqual(result, {
      status: "completed",
      migrationId:
        fixture.migrationId,
      itemId: fixture.itemId,
      targetFileId:
        "processor-target-1",
    });

    assert.equal(sourceGets, 1);
    assert.equal(copies, 1);

    const row = await queryItem(
      fixture.itemId,
    );

    assert.equal(row.status, "completed");
    assert.equal(
      row.target_file_id,
      "processor-target-1",
    );
    assert.equal(
      row.transfer_phase,
      "completed",
    );
    assert.equal(
      row.lease_generation,
      "8",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("duplicate queue delivery does not perform a second copy", async () => {
  const fixture = await createFixture();

  const originalFetch = globalThis.fetch;

  let copyCount = 0;

  try {
    globalThis.fetch = async (
      input,
      init,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        method === "GET" &&
        url.includes(
          `/files/${fixture.sourceFileId}`,
        )
      ) {
        return Response.json({
          id: fixture.sourceFileId,
          name: "duplicate-test.txt",
          size: "20",
          mimeType: "text/plain",
          appProperties: {},
          trashed: false,
        });
      }

      if (
        method === "POST" &&
        url.includes(
          `/files/${fixture.sourceFileId}/copy`,
        )
      ) {
        copyCount += 1;

        return Response.json({
          id: "duplicate-target",
          name: "duplicate-test.txt",
          size: "20",
          mimeType: "text/plain",
          appProperties: {
            college_noticeboard_migration_item:
              fixture.itemId,
          },
        });
      }

      throw new Error(
        `Unexpected Google request: ${method} ${url}`,
      );
    };

    const message = {
      migrationId:
        fixture.migrationId,
      itemId: fixture.itemId,
    };

    const first =
      await processMigrationItem(
        env(),
        message,
      );

    const second =
      await processMigrationItem(
        env(),
        message,
      );

    assert.equal(
      first.status,
      "completed",
    );

    assert.deepEqual(second, {
      status: "already_handled",
      migrationId:
        fixture.migrationId,
      itemId: fixture.itemId,
    });

    assert.equal(copyCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("persisted target is verified without performing another copy", async () => {
  const fixture = await createFixture({
    targetFileId: "persisted-target",
  });

  const originalFetch = globalThis.fetch;

  let copyCount = 0;
  let targetGets = 0;

  try {
    globalThis.fetch = async (
      input,
      init,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      assert.equal(
        method,
        "GET",
      );

      if (
        url.includes(
          `/files/persisted-target`,
        )
      ) {
        targetGets += 1;

        return Response.json({
          id: "persisted-target",
          name: "already-copied.pdf",
          size: "1234",
          mimeType: "application/pdf",
          appProperties: {
            college_noticeboard_migration_item:
              fixture.itemId,
          },
          trashed: false,
        });
      }

      throw new Error(
        `Unexpected target verification request: ${url}`,
      );
    };

    const result =
      await processMigrationItem(
        env(),
        {
          migrationId:
            fixture.migrationId,
          itemId: fixture.itemId,
        },
      );

    assert.equal(
      result.status,
      "completed",
    );

    assert.equal(
      targetGets,
      1,
    );

    assert.equal(
      copyCount,
      0,
    );

    const row = await queryItem(
      fixture.itemId,
    );

    assert.equal(
      row.status,
      "completed",
    );
    assert.equal(
      row.target_file_id,
      "persisted-target",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

after(async () => {
  for (const fixture of fixtures.reverse()) {
    await cleanup(fixture).catch(() => {});
  }
});

test("source 401 invalidates the source account and fails the item", async () => {
  const fixture = await createFixture();

  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (
      input,
      init,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        method === "GET" &&
        url.includes(
          `/files/${fixture.sourceFileId}`,
        )
      ) {
        return Response.json(
          {
            error: {
              errors: [
                {
                  reason:
                    "invalidCredentials",
                },
              ],
            },
          },
          { status: 401 },
        );
      }

      throw new Error(
        `Unexpected request: ${method} ${url}`,
      );
    };

    const result =
      await processMigrationItem(
        env(),
        {
          migrationId:
            fixture.migrationId,
          itemId: fixture.itemId,
        },
      );

    assert.equal(
      result.status,
      "failed",
    );

    const itemResult =
      await queryItem(
        fixture.itemId,
      );

    assert.equal(
      itemResult.status,
      "failed",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("source transient failure is requeued with backoff", async () => {
  const fixture = await createFixture();

  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (
      input,
      init,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        method === "GET" &&
        url.includes(
          `/files/${fixture.sourceFileId}`,
        )
      ) {
        return Response.json(
          {
            error: {
              errors: [
                {
                  reason:
                    "backendError",
                },
              ],
            },
          },
          { status: 503 },
        );
      }

      throw new Error(
        `Unexpected request: ${method} ${url}`,
      );
    };

    const result =
      await processMigrationItem(
        env(),
        {
          migrationId:
            fixture.migrationId,
          itemId: fixture.itemId,
        },
      );

    assert.equal(
      result.status,
      "retrying",
    );

    const itemResult =
      await queryItem(
        fixture.itemId,
      );

    assert.equal(
      itemResult.status,
      "pending",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("target quota failure waits for storage", async () => {
  const fixture = await createFixture();

  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (
      input,
      init,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        method === "GET" &&
        url.includes(
          `/files/${fixture.sourceFileId}`,
        )
      ) {
        return Response.json({
          id: fixture.sourceFileId,
          name: "quota-test.txt",
          size: "1234",
          mimeType: "text/plain",
          appProperties: {},
          trashed: false,
        });
      }

      if (
        method === "POST" &&
        url.includes(
          `/files/${fixture.sourceFileId}/copy`,
        )
      ) {
        return Response.json(
          {
            error: {
              errors: [
                {
                  reason:
                    "storageQuotaExceeded",
                },
              ],
            },
          },
          { status: 403 },
        );
      }

      throw new Error(
        `Unexpected request: ${method} ${url}`,
      );
    };

    const result =
      await processMigrationItem(
        env(),
        {
          migrationId:
            fixture.migrationId,
          itemId: fixture.itemId,
        },
      );

    assert.equal(
      result.status,
      "waiting_for_storage",
    );

    const itemResult =
      await queryItem(
        fixture.itemId,
      );

    assert.equal(
      itemResult.status,
      "pending",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ambiguous target copy enters reconciliation", async () => {
  const fixture = await createFixture();

  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (
      input,
      init,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        method === "GET" &&
        url.includes(
          `/files/${fixture.sourceFileId}`,
        )
      ) {
        return Response.json({
          id: fixture.sourceFileId,
          name: "ambiguous.txt",
          size: "1234",
          mimeType: "text/plain",
          appProperties: {},
          trashed: false,
        });
      }

      if (
        method === "POST" &&
        url.includes(
          `/files/${fixture.sourceFileId}/copy`,
        )
      ) {
        return Response.json(
          {
            error: {
              errors: [
                {
                  reason:
                    "backendError",
                },
              ],
            },
          },
          { status: 503 },
        );
      }

      throw new Error(
        `Unexpected request: ${method} ${url}`,
      );
    };

    const result =
      await processMigrationItem(
        env(),
        {
          migrationId:
            fixture.migrationId,
          itemId: fixture.itemId,
        },
      );

    assert.equal(
      result.status,
      "reconciling",
    );

    const itemResult =
      await queryItem(
        fixture.itemId,
      );

    assert.equal(
      itemResult.status,
      "reconciling",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("valid stale-lease recovery reconciles instead of copying again", async () => {
  const fixture = await createFixture();

  const client = new Client({
    connectionString: databaseUrl(),
  });

  await client.connect();

  try {
    await client.query(
      `
      UPDATE google_drive_account_migration_items
      SET
        status = 'running',
        transfer_phase = 'downloading',
        target_recovery_required = TRUE,
        lease_expires_at =
          NOW() - INTERVAL '1 minute',
        lease_generation = 19
      WHERE id = $1
      `,
      [fixture.itemId],
    );
  } finally {
    await client.end();
  }

  const originalFetch = globalThis.fetch;

  let copies = 0;

  try {
    globalThis.fetch = async (
      input,
      init,
    ) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        method === "GET" &&
        url.includes(
          `/files/${fixture.sourceFileId}`,
        )
      ) {
        return Response.json({
          id: fixture.sourceFileId,
          name: "recovery.txt",
          size: "1234",
          mimeType: "text/plain",
          appProperties: {},
          trashed: false,
        });
      }

      if (
        method === "GET" &&
        url.includes("/files?")
      ) {
        return Response.json({
          files: [],
        });
      }

      if (
        method === "POST" &&
        url.includes("/copy")
      ) {
        copies += 1;

        return Response.json({
          id: "must-not-copy",
        });
      }

      throw new Error(
        `Unexpected request: ${method} ${url}`,
      );
    };

    const result =
      await processMigrationItem(
        env(),
        {
          migrationId:
            fixture.migrationId,
          itemId: fixture.itemId,
        },
      );

    assert.equal(
      result.status,
      "reconciling",
    );

    assert.equal(
      copies,
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("processor completes through temporary-share Google copy", async () => {
  const fixture = await createFixture();

  const originalFetch = globalThis.fetch;

  let copyCount = 0;
  let permissionCreated = false;
  let permissionDeleted = false;

  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        method === "GET" &&
        url.includes(
          `/files/${fixture.sourceFileId}`,
        )
      ) {
        return Response.json({
          id: fixture.sourceFileId,
          name: "large-document.pdf",
          size: "1048576",
          mimeType: "application/pdf",
          copyRequiresWriterPermission: false,
          appProperties: {},
          trashed: false,
        });
      }

      if (
        method === "POST" &&
        url.includes(
          `/files/${fixture.sourceFileId}/copy`,
        )
      ) {
        copyCount += 1;

        if (copyCount === 1) {
          return Response.json(
            {
              error: {
                errors: [
                  { reason: "notFound" },
                ],
              },
            },
            { status: 404 },
          );
        }

        return Response.json({
          id: "temporary-share-target",
          name: "large-document.pdf",
          size: "1048576",
          mimeType: "application/pdf",
          appProperties: {
            college_noticeboard_migration_item:
              fixture.itemId,
          },
        });
      }

      if (
        method === "POST" &&
        url.includes(
          `/files/${fixture.sourceFileId}/permissions`,
        )
      ) {
        permissionCreated = true;

        return Response.json({
          id: "temporary-permission",
        });
      }

      if (
        method === "DELETE" &&
        url.includes(
          `/files/${fixture.sourceFileId}/permissions/temporary-permission`,
        )
      ) {
        permissionDeleted = true;

        return new Response(null, {
          status: 204,
        });
      }

      throw new Error(
        `Unexpected request: ${method} ${url}`,
      );
    };

    const result =
      await processMigrationItem(
        env(),
        {
          migrationId:
            fixture.migrationId,
          itemId:
            fixture.itemId,
        },
      );

    assert.equal(
      result.status,
      "completed",
    );

    assert.equal(
      result.targetFileId,
      "temporary-share-target",
    );

    assert.equal(
      permissionCreated,
      true,
    );

    assert.equal(
      permissionDeleted,
      true,
    );

    assert.equal(
      copyCount,
      2,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
