import { pool } from "./db/database.js";

const RETENTION_STATUSES = new Set([
  "pending",
  "failed",
  "blocked_target_missing",
  "deleted",
]);

function safePositiveInt(value, fallback, max = 100) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function clean(value) {
  return String(value ?? "").trim();
}

export function normalizeSourceRetentionFilters(query = {}) {
  const sourceDeleteStatus = clean(query.sourceDeleteStatus);
  const itemStatus = clean(query.itemStatus);
  const accountId = clean(query.accountId);
  const search = clean(query.search);

  return {
    page: safePositiveInt(query.page, 1, 1000000),
    pageSize: safePositiveInt(query.pageSize, 50, 100),
    sourceDeleteStatus: RETENTION_STATUSES.has(sourceDeleteStatus)
      ? sourceDeleteStatus
      : "",
    itemStatus,
    accountId,
    search,
  };
}

function retentionReason(row) {
  if (row.source_delete_status === "deleted") {
    return "Source cleanup completed";
  }

  if (row.item_status !== "completed") {
    return "Source retained because migration item is not completed";
  }

  if (row.source_delete_status === "blocked_target_missing") {
    return "Source retained because the verified target is missing";
  }

  if (row.source_delete_status === "failed") {
    return row.source_delete_error || "Source deletion previously failed";
  }

  return "Target migration completed; source cleanup is pending";
}

export async function getSourceRetentionVisibility(filters = {}) {
  const normalized = normalizeSourceRetentionFilters(filters);
  const params = [];
  const where = ["i.source_delete_status <> 'deleted'"];

  if (normalized.sourceDeleteStatus) {
    params.push(normalized.sourceDeleteStatus);
    where.push(`i.source_delete_status = $${params.length}`);
  }

  if (normalized.itemStatus) {
    params.push(normalized.itemStatus);
    where.push(`i.status = $${params.length}`);
  }

  if (normalized.accountId) {
    params.push(normalized.accountId);
    where.push(`(m.source_account_id = $${params.length} OR i.target_account_id = $${params.length})`);
  }

  if (normalized.search) {
    const searchTerm = normalized.search.replace(/[!%_]/g, (character) => `!${character}`);
    params.push(`%${searchTerm}%`);
    const idx = params.length;
    where.push(`(
      i.source_file_id ILIKE $${idx} ESCAPE '!'
      OR i.target_file_id ILIKE $${idx} ESCAPE '!'
      OR i.migration_id ILIKE $${idx} ESCAPE '!'
      OR source.email ILIKE $${idx} ESCAPE '!'
      OR target.email ILIKE $${idx} ESCAPE '!'
    )`);
  }

  const whereSql = where.join(" AND ");

  const countResult = await pool.query(
    `
      SELECT COUNT(*)::bigint AS total
      FROM google_drive_account_migration_items i
      JOIN google_drive_account_migrations m
        ON m.id = i.migration_id
      JOIN google_drive_accounts source
        ON source.id = m.source_account_id
      LEFT JOIN google_drive_accounts target
        ON target.id = i.target_account_id
      WHERE ${whereSql}
    `,
    params
  );

  const total = Number(countResult.rows[0]?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / normalized.pageSize));
  const page = Math.min(normalized.page, totalPages);
  const offset = (page - 1) * normalized.pageSize;

  const rows = await pool.query(
    `
      SELECT
        i.id,
        i.migration_id,
        i.source_file_id,
        i.target_file_id,
        i.target_account_id,
        i.status AS item_status,
        i.source_delete_status,
        i.source_delete_error,
        i.cleanup_attempt_count,
        i.cleanup_next_attempt_at,
        i.created_at,
        i.updated_at,
        i.finished_at,
        i.size_bytes,
        source.id AS source_account_id,
        source.email AS source_email,
        target.email AS target_email
      FROM google_drive_account_migration_items i
      JOIN google_drive_account_migrations m
        ON m.id = i.migration_id
      JOIN google_drive_accounts source
        ON source.id = m.source_account_id
      LEFT JOIN google_drive_accounts target
        ON target.id = i.target_account_id
      WHERE ${whereSql}
      ORDER BY i.updated_at DESC, i.id DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `,
    [...params, normalized.pageSize, offset]
  );

  const summaryResult = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE source_delete_status <> 'deleted')::int AS retained_sources,
      COUNT(*) FILTER (
        WHERE source_delete_status = 'pending'
          AND status = 'completed'
      )::int AS pending_cleanup,
      COUNT(*) FILTER (
        WHERE source_delete_status = 'failed'
      )::int AS cleanup_failed,
      COUNT(*) FILTER (
        WHERE source_delete_status = 'blocked_target_missing'
      )::int AS blocked_target_missing,
      COUNT(*) FILTER (
        WHERE status <> 'completed'
          AND source_delete_status <> 'deleted'
      )::int AS retained_before_completion
    FROM google_drive_account_migration_items
  `);

  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      migrationId: row.migration_id,
      sourceFileId: row.source_file_id,
      targetFileId: row.target_file_id,
      targetAccountId: row.target_account_id,
      sourceAccountId: row.source_account_id,
      sourceEmail: row.source_email,
      targetEmail: row.target_email,
      itemStatus: row.item_status,
      sourceDeleteStatus: row.source_delete_status,
      sourceDeleteError: row.source_delete_error,
      cleanupAttemptCount: Number(row.cleanup_attempt_count || 0),
      cleanupNextAttemptAt: row.cleanup_next_attempt_at,
      sizeBytes: String(row.size_bytes ?? 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
      retentionReason: retentionReason(row),
      sourceDriveUrl: row.source_file_id
        ? `https://drive.google.com/file/d/${encodeURIComponent(row.source_file_id)}/view`
        : null,
      targetDriveUrl: row.target_file_id
        ? `https://drive.google.com/file/d/${encodeURIComponent(row.target_file_id)}/view`
        : null,
    })),
    summary: {
      retainedSources: Number(summaryResult.rows[0]?.retained_sources || 0),
      pendingCleanup: Number(summaryResult.rows[0]?.pending_cleanup || 0),
      cleanupFailed: Number(summaryResult.rows[0]?.cleanup_failed || 0),
      blockedTargetMissing: Number(summaryResult.rows[0]?.blocked_target_missing || 0),
      retainedBeforeCompletion: Number(summaryResult.rows[0]?.retained_before_completion || 0),
    },
    pagination: {
      page,
      pageSize: normalized.pageSize,
      total,
      totalPages,
    },
  };
}
