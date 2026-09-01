import { pool } from "../db/database.js";
import {
  getGoogleDriveClientForAccount,
} from "./googleClient.js";

const QUOTA_REFRESH_LOCK = "college-noticeboard:storage-quota-refresh";

import { aggregateQuota } from "./storageQuotaMath.js";
export async function ensureQuotaSnapshotSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS google_drive_account_quota_snapshots (
      account_id TEXT PRIMARY KEY
        REFERENCES google_drive_accounts(id)
        ON DELETE CASCADE,
      capacity_bytes BIGINT,
      usage_bytes BIGINT,
      last_successful_refresh_at TIMESTAMPTZ,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (capacity_bytes IS NULL OR capacity_bytes >= 0),
      CHECK (usage_bytes IS NULL OR usage_bytes >= 0)
    )
  `);
}

async function refreshOneAccount(accountRecord) {
  try {
    const drive = await getGoogleDriveClientForAccount(accountRecord);
    const about = await drive.about.get({ fields: "storageQuota" });
    const quota = about.data.storageQuota;

    if (!quota?.limit || quota.usage == null) {
      throw new Error("Google Drive did not provide a complete storage quota");
    }

    const capacityBytes = BigInt(quota.limit);
    const usageBytes = BigInt(quota.usage);

    await pool.query(
      `
      INSERT INTO google_drive_account_quota_snapshots (
        account_id, capacity_bytes, usage_bytes,
        last_successful_refresh_at, last_error, updated_at
      )
      VALUES ($1, $2, $3, NOW(), NULL, NOW())
      ON CONFLICT (account_id)
      DO UPDATE SET
        capacity_bytes = EXCLUDED.capacity_bytes,
        usage_bytes = EXCLUDED.usage_bytes,
        last_successful_refresh_at = EXCLUDED.last_successful_refresh_at,
        last_error = NULL,
        updated_at = NOW()
      `,
      [accountRecord.connected_account_id, capacityBytes.toString(), usageBytes.toString()]
    );

    return {
      limitBytes: capacityBytes.toString(),
      usageBytes: usageBytes.toString(),
      lastSuccessfulRefreshAt: new Date().toISOString(),
      lastError: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `
      INSERT INTO google_drive_account_quota_snapshots (
        account_id, last_error, updated_at
      )
      VALUES ($1, $2, NOW())
      ON CONFLICT (account_id)
      DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = NOW()
      `,
      [accountRecord.connected_account_id, message]
    );

    return {
      limitBytes: null,
      usageBytes: null,
      lastSuccessfulRefreshAt: null,
      lastError: message,
    };
  }
}

export async function getStorageSummary({ refresh = false } = {}) {
  await ensureQuotaSnapshotSchema();

  if (refresh) {
    const lockClient = await pool.connect();
    try {
      const lockResult = await lockClient.query(
        `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
        [QUOTA_REFRESH_LOCK]
      );
      if (!lockResult.rows[0]?.acquired) {
        const snapshots = await readStorageSummary();
        return { ...snapshots, refreshing: true };
      }

      try {
        const result = await pool.query(`
          SELECT
            id AS connected_account_id,
            email,
            status,
            created_at,
            updated_at,
            client_id_encrypted,
            client_secret_encrypted,
            access_token_encrypted,
            refresh_token_encrypted,
            token_expires_at,
            redirect_uri
          FROM google_drive_accounts
          WHERE status = 'connected'
          ORDER BY email
        `);

        await Promise.all(result.rows.map((account) => refreshOneAccount(account)));
      } finally {
        await lockClient.query(
          `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
          [QUOTA_REFRESH_LOCK]
        );
      }
    } finally {
      lockClient.release();
    }
  }

  return readStorageSummary();
}

async function readStorageSummary() {
  const result = await pool.query(`
    SELECT
      a.id,
      a.email,
      a.status,
      q.capacity_bytes,
      q.usage_bytes,
      q.last_successful_refresh_at,
      q.last_error,
      a.created_at,
      a.updated_at
    FROM google_drive_accounts a
    LEFT JOIN google_drive_account_quota_snapshots q
      ON q.account_id = a.id
    ORDER BY a.email
  `);

  return aggregateQuota(
    result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      status: row.status,
      limitBytes: row.capacity_bytes?.toString() ?? null,
      usageBytes: row.usage_bytes?.toString() ?? null,
      lastSuccessfulRefreshAt: row.last_successful_refresh_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  );
}
