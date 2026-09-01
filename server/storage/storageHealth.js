import { pool } from "../db/database.js";
import { ensureQuotaSnapshotSchema } from "./storageQuota.js";

export function classifyStorageHealth({ status, capacityBytes, usageBytes, lastSuccessfulRefreshAt, lastError }) {
  if (status === "authorization_invalid") return "authorization_invalid";
  if (status === "disabled") return "disabled";

  const hasSnapshot = capacityBytes != null && usageBytes != null && lastSuccessfulRefreshAt != null;
  if (status === "connected" && lastError && hasSnapshot) return "stale";
  if (status === "connected" && hasSnapshot && !lastError) return "healthy";
  if (status === "connected") return "unavailable";
  return "unknown";
}

export async function getStorageHealth() {
  await ensureQuotaSnapshotSchema();

  const result = await pool.query(`
    SELECT
      a.id,
      a.email,
      a.status,
      a.updated_at,
      q.capacity_bytes,
      q.usage_bytes,
      q.last_successful_refresh_at,
      q.last_error,
      q.updated_at AS snapshot_updated_at
    FROM google_drive_accounts a
    LEFT JOIN google_drive_account_quota_snapshots q
      ON q.account_id = a.id
    ORDER BY a.email
  `);

  const accounts = result.rows.map((row) => {
    const capacityBytes = row.capacity_bytes == null ? null : row.capacity_bytes.toString();
    const usageBytes = row.usage_bytes == null ? null : row.usage_bytes.toString();

    return {
      id: row.id,
      email: row.email,
      status: row.status,
      health: classifyStorageHealth({
        status: row.status,
        capacityBytes,
        usageBytes,
        lastSuccessfulRefreshAt: row.last_successful_refresh_at,
        lastError: row.last_error,
      }),
      capacityBytes,
      usageBytes,
      lastSuccessfulRefreshAt: row.last_successful_refresh_at,
      lastError: row.last_error,
      snapshotUpdatedAt: row.snapshot_updated_at,
      accountUpdatedAt: row.updated_at,
    };
  });

  const counts = accounts.reduce(
    (acc, account) => {
      acc[account.health] = (acc[account.health] || 0) + 1;
      return acc;
    },
    {}
  );

  const lastSuccessfulRefreshAt = accounts
    .map((account) => account.lastSuccessfulRefreshAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  return {
    totalAccounts: accounts.length,
    healthyAccounts: counts.healthy ?? 0,
    staleAccounts: counts.stale ?? 0,
    unavailableAccounts: counts.unavailable ?? 0,
    authorizationInvalidAccounts: counts.authorization_invalid ?? 0,
    disabledAccounts: counts.disabled ?? 0,
    lastSuccessfulRefreshAt,
    accounts,
  };
}
