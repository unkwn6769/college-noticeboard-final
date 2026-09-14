import { withDatabase } from "../db/postgres";

export const MAX_MIGRATION_SEED_BATCH = 100;

export type MigrationKickoffMessage = {
  type: "migration_kickoff";
  migrationId: string;
};

export type SourceCleanupRetryMessage = {
  type: "source_cleanup_retry";
  itemId: string;
};

export type NormalMigrationMessage = {
  migrationId: string;
  itemId: string;
};

export type MigrationQueueMessage =
  | NormalMigrationMessage
  | MigrationKickoffMessage
  | SourceCleanupRetryMessage;

export function isSourceCleanupMessage(
  value: unknown,
): value is SourceCleanupRetryMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === "source_cleanup_retry" &&
    typeof message.itemId === "string" &&
    message.itemId.length > 0
  );
}

export function isMigrationKickoffMessage(
  value: unknown,
): value is MigrationKickoffMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === "migration_kickoff" &&
    typeof message.migrationId === "string" &&
    message.migrationId.length > 0
  );
}

export function isNormalMigrationMessage(
  value: unknown,
): value is NormalMigrationMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.migrationId === "string" &&
    message.migrationId.length > 0 &&
    typeof message.itemId === "string" &&
    message.itemId.length > 0 &&
    !("type" in message)
  );
}

export async function seedPendingMigrationItems(
  env: Env,
  migrationId: string,
): Promise<{ queued: number; hasMore: boolean }> {
  const items = await withDatabase(env, async (client) => {
    const result = await client.query<{ id: string }>(
      `
        SELECT id
        FROM google_drive_account_migration_items
        WHERE migration_id = $1
          AND status = 'pending'
          AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        ORDER BY created_at ASC, id ASC
        LIMIT $2
      `,
      [migrationId, MAX_MIGRATION_SEED_BATCH + 1],
    );

    return result.rows;
  });

  const hasMore = items.length > MAX_MIGRATION_SEED_BATCH;
  const batch = items.slice(0, MAX_MIGRATION_SEED_BATCH);

  if (batch.length > 0) {
    await env.MIGRATION_QUEUE.sendBatch(
      batch.map((item) => ({
        body: {
          migrationId,
          itemId: item.id,
        },
      })),
    );
  }

  return {
    queued: batch.length,
    hasMore,
  };
}
