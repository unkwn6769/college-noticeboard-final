import { pool } from "./db/database.js";

export const ACTIVITY_EVENT_TYPES = Object.freeze({
  ADMIN_LOGIN: "admin.login",
  ADMIN_LOGOUT: "admin.logout",
  ADMIN_CREATED: "admin.created",
  ADMIN_UPDATED: "admin.updated",
  ADMIN_REMOVED: "admin.removed",
  DRIVE_ACCOUNT_CONNECTED: "drive_account.connected",
  DRIVE_ACCOUNT_ENABLED: "drive_account.enabled",
  DRIVE_ACCOUNT_DISABLED: "drive_account.disabled",
  DRIVE_ACCOUNT_REMOVED: "drive_account.removed",
  STORAGE_REFRESHED: "storage.refreshed",
  DRIVE_FILE_RESTORED: "drive_file.restored",
  DRIVE_FILE_PERMANENTLY_DELETED: "drive_file.permanently_deleted",
  MIGRATION_CREATED: "migration.created",
  MIGRATION_CANCEL_REQUESTED: "migration.cancel_requested",
  SOURCE_CLEANUP_RETRY: "migration.source_cleanup_retry",
});

function cleanMetadata(metadata) {
  if (metadata === undefined || metadata === null) return {};

  try {
    const serialized = JSON.stringify(metadata);
    if (serialized === undefined) return {};
    return JSON.parse(serialized);
  } catch {
    return { value: String(metadata) };
  }
}

function getRequestContext(req) {
  if (!req) {
    return { ipAddress: null, userAgent: null };
  }

  const forwarded = String(req.headers?.["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();

  return {
    ipAddress: forwarded || req.ip || req.socket?.remoteAddress || null,
    userAgent: String(req.headers?.["user-agent"] || "") || null,
  };
}

export async function logAdminActivity({
  req = null,
  admin = null,
  eventType,
  entityType = null,
  entityId = null,
  description,
  metadata = {},
} = {}) {
  if (!eventType || !description) {
    throw new Error("Activity eventType and description are required");
  }

  const { ipAddress, userAgent } = getRequestContext(req);

  try {
    await pool.query(
      `
      INSERT INTO admin_activity_logs (
        admin_user_id,
        actor_email,
        event_type,
        entity_type,
        entity_id,
        description,
        metadata,
        ip_address,
        user_agent
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
      `,
      [
        admin?.id ?? null,
        admin?.email ?? null,
        eventType,
        entityType,
        entityId === null || entityId === undefined ? null : String(entityId),
        description,
        JSON.stringify(cleanMetadata(metadata)),
        ipAddress,
        userAgent,
      ]
    );
  } catch (error) {
    // Activity logging must never turn a successful primary admin action into
    // a failed request. Keep the failure observable in server logs.
    console.error("Admin activity log write failed:", error);
  }
}

export async function getAdminActivity({
  page = 1,
  pageSize = 50,
  eventType = null,
} = {}) {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const safePageSize = Number.isInteger(pageSize)
    ? Math.min(100, Math.max(1, pageSize))
    : 50;
  const normalizedEventType = String(eventType || "").trim();

  const params = [];
  const where = [];

  if (normalizedEventType) {
    params.push(normalizedEventType);
    where.push(`event_type = $${params.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countResult = await pool.query(
    `
    SELECT COUNT(*)::bigint AS total
    FROM admin_activity_logs
    ${whereSql}
    `,
    params
  );

  const total = Number(countResult.rows[0]?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const effectivePage = Math.min(safePage, totalPages);
  const offset = (effectivePage - 1) * safePageSize;

  const rows = await pool.query(
    `
    SELECT
      id,
      admin_user_id,
      actor_email,
      event_type,
      entity_type,
      entity_id,
      description,
      metadata,
      ip_address,
      user_agent,
      created_at
    FROM admin_activity_logs
    ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
    `,
    [...params, safePageSize, offset]
  );

  return {
    entries: rows.rows.map((row) => ({
      id: Number(row.id),
      adminUserId: row.admin_user_id === null ? null : Number(row.admin_user_id),
      actorEmail: row.actor_email,
      eventType: row.event_type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      description: row.description,
      metadata: row.metadata || {},
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      createdAt: row.created_at,
    })),
    pagination: {
      page: effectivePage,
      pageSize: safePageSize,
      total,
      totalPages,
    },
  };
}
