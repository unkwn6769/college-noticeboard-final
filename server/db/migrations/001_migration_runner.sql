CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS migration_scheduler_leases (
  id INTEGER PRIMARY KEY,
  owner_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE google_drive_account_migrations
  ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE google_drive_account_migration_items
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cleanup_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cleanup_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bytes_transferred BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transfer_phase TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS target_recovery_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reserved_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS speed_bytes_per_second DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS upload_session_uri_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS upload_bytes_committed BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS upload_total_bytes BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_gd_migration_items_due
  ON google_drive_account_migration_items(migration_id, status, next_retry_at, created_at, id);
CREATE INDEX IF NOT EXISTS idx_gd_migration_items_cleanup_due
  ON google_drive_account_migration_items(status, source_delete_status, cleanup_next_attempt_at, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_gd_migration_items_claim
  ON google_drive_account_migration_items(migration_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_gd_migrations_waiting
  ON google_drive_account_migrations(status, updated_at, created_at, id);
CREATE INDEX IF NOT EXISTS idx_resources_storage_key
  ON resources(storage_key);
