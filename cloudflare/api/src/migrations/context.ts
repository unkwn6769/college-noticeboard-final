import {
  getGoogleDriveAccount,
  type GoogleDriveAccount,
} from "../google/accounts";
import {
  getMigration,
  getMigrationItem,
  type Migration,
  type MigrationItem,
} from "./queries";

export type MigrationContext = {
  migration: Migration;
  item: MigrationItem;
  sourceAccount: GoogleDriveAccount;
  targetAccount: GoogleDriveAccount;
};

export async function loadMigrationContext(
  env: Env,
  migrationId: string,
  itemId: string,
): Promise<MigrationContext> {
  const migration = await getMigration(
    env,
    migrationId,
  );

  if (!migration) {
    throw new Error("Migration not found");
  }

  const item = await getMigrationItem(
    env,
    itemId,
  );

  if (!item) {
    throw new Error("Migration item not found");
  }

  if (item.migration_id !== migrationId) {
    throw new Error(
      "Migration item does not belong to migration",
    );
  }

  const sourceAccount =
    await getGoogleDriveAccount(
      env,
      migration.source_account_id,
    );

  if (!sourceAccount) {
    throw new Error(
      "Source Google Drive account not found",
    );
  }

  if (sourceAccount.status !== "connected") {
    throw new Error(
      "Source Google Drive account is not connected",
    );
  }

  const targetAccountId =
    item.target_account_id ??
    migration.target_account_id;

  if (!targetAccountId) {
    throw new Error(
      "Target Google Drive account is not assigned",
    );
  }

  if (targetAccountId === migration.source_account_id) {
    throw new Error(
      "Source and target Google Drive accounts must differ",
    );
  }

  const targetAccount =
    await getGoogleDriveAccount(
      env,
      targetAccountId,
    );

  if (!targetAccount) {
    throw new Error(
      "Target Google Drive account not found",
    );
  }

  if (targetAccount.status !== "connected") {
    throw new Error(
      "Target Google Drive account is not connected",
    );
  }

  return {
    migration,
    item,
    sourceAccount,
    targetAccount,
  };
}
