import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

export const pool = new Pool({
  connectionString,

  // Supabase/Supavisor is remote in both local development and production.
  // Always use TLS so the same connection behavior is used everywhere.
  ssl: {
    rejectUnauthorized: false,
  },

  // Prevent a dead network path from hanging a worker indefinitely.
  connectionTimeoutMillis: Number(
    process.env.DB_CONNECTION_TIMEOUT_MS || 10_000
  ),

  // Recycle idle sockets before network middleboxes have a chance to leave
  // them half-open. This is intentionally long enough to preserve pooling
  // efficiency while avoiding stale connections during long migrations.
  idleTimeoutMillis: Number(
    process.env.DB_IDLE_TIMEOUT_MS || 15_000
  ),

  // Keep DB concurrency bounded independently from the 25 Drive workers.
  max: Number(process.env.DB_POOL_MAX || 10),

  // TCP keepalive reduces stale long-lived socket failures.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,

  // Periodically recycle clients to avoid long-lived pooler/NAT state.
  maxLifetimeSeconds: Number(
    process.env.DB_MAX_LIFETIME_SECONDS || 300
  ),
});

pool.on("error", (error) => {
  const code = error?.code;

  if (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE"
  ) {
    console.error(
      `[DATABASE] Transient PostgreSQL connection error: ${code}`
    );
    return;
  }

  console.error("Unexpected PostgreSQL error:", error);
});

export async function ensureAdminManagementSchema() {
  await pool.query(`
    ALTER TABLE admin_users
      ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';
    ALTER TABLE admin_users
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE admin_users
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'admin_users_role_check'
      ) THEN
        ALTER TABLE admin_users
          ADD CONSTRAINT admin_users_role_check
          CHECK (role IN ('owner', 'admin'));
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'admin_users_status_check'
      ) THEN
        ALTER TABLE admin_users
          ADD CONSTRAINT admin_users_status_check
          CHECK (status IN ('active', 'disabled'));
      END IF;
    END $$;

    -- Ensure exactly one bootstrap owner exists when an older database has
    -- administrators but no role-aware owner yet.
    UPDATE admin_users
    SET role = 'owner',
        updated_at = NOW()
    WHERE id = (
      SELECT id
      FROM admin_users
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    )
      AND NOT EXISTS (
        SELECT 1
        FROM admin_users
        WHERE role = 'owner'
      );

    CREATE INDEX IF NOT EXISTS idx_admin_users_status
      ON admin_users(status);
    CREATE INDEX IF NOT EXISTS idx_admin_users_role
      ON admin_users(role);
  `);
}

export async function ensureActivityLogSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_activity_logs (
      id BIGSERIAL PRIMARY KEY,
      admin_user_id BIGINT
        REFERENCES admin_users(id)
        ON DELETE SET NULL,
      actor_email TEXT,
      event_type TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      description TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_admin_activity_logs_created_at
      ON admin_activity_logs(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_activity_logs_event_type
      ON admin_activity_logs(event_type, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_activity_logs_admin_user
      ON admin_activity_logs(admin_user_id, created_at DESC, id DESC);
  `);
}

export async function ensureMigrationSafetySchema() {
  await pool.query(`
    ALTER TABLE google_drive_account_migrations
      ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE google_drive_account_migration_items
      ADD COLUMN IF NOT EXISTS size_bytes BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE google_drive_account_migration_items
      ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE google_drive_account_migration_items
      ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ;
    ALTER TABLE google_drive_account_migration_items
      ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
    ALTER TABLE google_drive_account_migration_items
      ADD COLUMN IF NOT EXISTS cleanup_attempt_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE google_drive_account_migration_items
      ADD COLUMN IF NOT EXISTS cleanup_next_attempt_at TIMESTAMPTZ;
    ALTER TABLE google_drive_account_migration_items
      ADD COLUMN IF NOT EXISTS reserved_bytes BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE google_drive_account_migration_items
      ADD COLUMN IF NOT EXISTS speed_bytes_per_second DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE google_drive_account_migration_items
      ADD COLUMN IF NOT EXISTS target_recovery_required BOOLEAN NOT NULL DEFAULT FALSE;

    DROP INDEX IF EXISTS idx_google_drive_account_migrations_active_source;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_google_drive_account_migrations_active_source
      ON google_drive_account_migrations(source_account_id)
      WHERE status IN ('pending', 'running', 'waiting_for_storage');

    CREATE INDEX IF NOT EXISTS idx_gd_migration_items_retry_due
      ON google_drive_account_migration_items(status, next_retry_at, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_gd_migration_items_cleanup_due
      ON google_drive_account_migration_items(status, source_delete_status, cleanup_next_attempt_at, updated_at, id);

    CREATE INDEX IF NOT EXISTS idx_gd_migration_items_quota_reservations
      ON google_drive_account_migration_items(target_account_id, status, reserved_bytes)
      WHERE reserved_bytes > 0;
    CREATE INDEX IF NOT EXISTS idx_gd_migrations_cancel_requested
      ON google_drive_account_migrations(cancel_requested, status, updated_at, id);

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'google_drive_account_migrations_status_check'
      ) THEN
        ALTER TABLE google_drive_account_migrations
          ADD CONSTRAINT google_drive_account_migrations_status_check
          CHECK (status IN ('pending','running','waiting_for_storage','reconciling','reconciliation_expired','completed','failed','cancelled'));
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'google_drive_account_migration_items_status_check'
      ) THEN
        ALTER TABLE google_drive_account_migration_items
          ADD CONSTRAINT google_drive_account_migration_items_status_check
          CHECK (status IN ('pending','running','reconciling','reconciliation_expired','completed','failed','cancelled','ambiguous_identity'));
      END IF;
    END $$;
  `);
}

export async function ensureMigrationPerformanceIndexes() {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_gd_migration_items_claim
      ON google_drive_account_migration_items(migration_id, status, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_gd_migration_items_cleanup
      ON google_drive_account_migration_items(status, source_delete_status, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_gd_migrations_waiting
      ON google_drive_account_migrations(status, updated_at, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_resources_storage_key
      ON resources(storage_key);
  `);
}
