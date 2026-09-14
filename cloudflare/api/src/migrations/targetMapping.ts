import { withDatabase } from "../db/postgres";

type MappingInput = {
  itemId: string;
  targetFileId: string;
  targetName: string | null | undefined;
  targetSize: string | number | null | undefined;
  leaseGeneration?: string;
};

export async function ensureTargetMapping(
  env: Env,
  input: MappingInput,
): Promise<void> {
  await withDatabase(env, async (client) => {
    await client.query("BEGIN");

    try {
      const leaseCondition = input.leaseGeneration
        ? "AND i.lease_generation = $2 AND i.status = 'running'"
        : "AND i.status = 'completed'";
      const params = input.leaseGeneration
        ? [input.itemId, input.leaseGeneration]
        : [input.itemId];

      const itemResult = await client.query<{
        source_file_id: string;
        source_account_id: string;
        target_account_id: string;
      }>(
        `
          SELECT
            i.source_file_id,
            m.source_account_id,
            COALESCE(i.target_account_id, m.target_account_id) AS target_account_id
          FROM google_drive_account_migration_items i
          JOIN google_drive_account_migrations m
            ON m.id = i.migration_id
          WHERE i.id = $1
            ${leaseCondition}
          FOR UPDATE
        `,
        params,
      );

      const item = itemResult.rows[0];
      if (!item?.target_account_id) {
        throw new Error("Migration target account is missing");
      }

      if (item.target_account_id === item.source_account_id) {
        throw new Error("Migration target account matches source account");
      }

      const resourceResult = await client.query<{
        id: string;
        name: string;
        size: string | null;
        storage_key: string | null;
      }>(
        `
          SELECT id, name, size, storage_key
          FROM resources
          WHERE storage_key IN ($1, $2)
            AND storage_provider = 'google_drive'
            AND storage_status = 'synced'
          ORDER BY CASE WHEN storage_key = $1 THEN 0 ELSE 1 END
          LIMIT 1
          FOR UPDATE
        `,
        [item.source_file_id, input.targetFileId],
      );

      const resource = resourceResult.rows[0];
      if (!resource) {
        throw new Error(
          `Source resource mapping for ${item.source_file_id} is missing`,
        );
      }

      if (
        input.targetName &&
        resource.name !== input.targetName
      ) {
        throw new Error(
          "Target file name does not match the source resource",
        );
      }

      if (
        input.targetSize != null &&
        resource.size != null &&
        String(input.targetSize) !== String(resource.size)
      ) {
        throw new Error(
          "Target file size does not match the source resource",
        );
      }

      if (resource.storage_key !== input.targetFileId) {
        await client.query(
          `
            UPDATE resources
            SET
              storage_key = $1,
              storage_provider = 'google_drive',
              storage_status = 'synced',
              is_available = TRUE,
              updated_at = NOW()
            WHERE id = $2
          `,
          [input.targetFileId, resource.id],
        );
      }

      await client.query(
        `
          DELETE FROM google_drive_file_accounts
          WHERE file_id = $1
            AND account_id = $2
        `,
        [item.source_file_id, item.source_account_id],
      );

      await client.query(
        `
          INSERT INTO google_drive_file_accounts (file_id, account_id)
          VALUES ($1, $2)
          ON CONFLICT (file_id)
          DO UPDATE SET account_id = EXCLUDED.account_id
        `,
        [input.targetFileId, item.target_account_id],
      );

      if (input.leaseGeneration) {
        await client.query(
          `
            UPDATE google_drive_account_migration_items
            SET
              target_account_id = $1,
              updated_at = NOW()
            WHERE id = $2
              AND lease_generation = $3
              AND status = 'running'
          `,
          [
            item.target_account_id,
            input.itemId,
            input.leaseGeneration,
          ],
        );
      } else {
        await client.query(
          `
            UPDATE google_drive_account_migration_items
            SET
              target_account_id = $1,
              updated_at = NOW()
            WHERE id = $2
              AND status = 'completed'
          `,
          [item.target_account_id, input.itemId],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original database error.
      }
      throw error;
    }
  });
}
