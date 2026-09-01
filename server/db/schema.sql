CREATE TABLE IF NOT EXISTS departments (
    id SERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status INTEGER,
    last_successful_sync TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS resources (

    id BIGSERIAL PRIMARY KEY,

    department_id INTEGER NOT NULL
        REFERENCES departments(id)
        ON DELETE CASCADE,

    name TEXT NOT NULL,

    type TEXT NOT NULL
        CHECK (type IN ('file', 'folder')),

    path TEXT NOT NULL UNIQUE,

    url TEXT NOT NULL,

    parent_path TEXT,

    size BIGINT,

    source_modified_at TIMESTAMPTZ,

    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    is_available BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    crawl_status TEXT
        CHECK (
            crawl_status IN (
                'ok',
                'http_error',
                'fetch_error'
            )
        ),

    storage_provider TEXT
        CHECK (
            storage_provider IN (
                'college',
                'google_drive'
            )
        ),

    storage_key TEXT,

    storage_status TEXT
        CHECK (
            storage_status IN (
                'pending',
                'uploading',
                'synced',
                'failed'
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_resources_department
    ON resources(department_id);

CREATE INDEX IF NOT EXISTS idx_resources_name
    ON resources(name);

CREATE INDEX IF NOT EXISTS idx_resources_type
    ON resources(type);

CREATE INDEX IF NOT EXISTS idx_resources_source_modified_at
    ON resources(source_modified_at);

CREATE INDEX IF NOT EXISTS idx_resources_last_seen
    ON resources(last_seen_at);

CREATE TABLE IF NOT EXISTS google_drive_accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    provider_account_id TEXT NOT NULL,
    client_id_encrypted TEXT NOT NULL,
    client_secret_encrypted TEXT NOT NULL,
    access_token_encrypted TEXT NOT NULL,
    refresh_token_encrypted TEXT NOT NULL,
    token_expires_at TIMESTAMPTZ,
    redirect_uri TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disabled', 'authorization_invalid')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS google_drive_file_accounts (
    file_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL
        REFERENCES google_drive_accounts(id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_google_drive_file_accounts_account
    ON google_drive_file_accounts(account_id);

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
);

CREATE TABLE IF NOT EXISTS sync_runs (
    id BIGSERIAL PRIMARY KEY,

    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,

    status TEXT NOT NULL
        CHECK (status IN ('running', 'completed', 'failed')),

    resources_found INTEGER NOT NULL DEFAULT 0,
    resources_added INTEGER NOT NULL DEFAULT 0,
    resources_updated INTEGER NOT NULL DEFAULT 0,
    resources_removed INTEGER NOT NULL DEFAULT 0,

    errors INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_errors (
    id BIGSERIAL PRIMARY KEY,

    sync_run_id BIGINT
        REFERENCES sync_runs(id)
        ON DELETE CASCADE,

    department TEXT,
    path TEXT,
    status INTEGER,

    message TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'admin'
        CHECK (role IN ('owner', 'admin')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_users_status
    ON admin_users(status);

CREATE INDEX IF NOT EXISTS idx_admin_users_role
    ON admin_users(role);

CREATE TABLE IF NOT EXISTS admin_sessions (
    id TEXT PRIMARY KEY,
    admin_user_id BIGINT NOT NULL
        REFERENCES admin_users(id)
        ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
    ON admin_sessions(expires_at);

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

CREATE TABLE IF NOT EXISTS google_drive_account_migrations (
    id TEXT PRIMARY KEY,
    source_account_id TEXT NOT NULL
        REFERENCES google_drive_accounts(id)
        ON DELETE RESTRICT,
    target_account_id TEXT NOT NULL
        REFERENCES google_drive_accounts(id)
        ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','waiting_for_storage','completed','failed','cancelled')),
    file_limit INTEGER,
    total_files BIGINT NOT NULL DEFAULT 0,
    completed_files BIGINT NOT NULL DEFAULT 0,
    failed_files BIGINT NOT NULL DEFAULT 0,
    current_file_id TEXT,
    error_message TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    CHECK (source_account_id <> target_account_id)
);

CREATE INDEX IF NOT EXISTS idx_google_drive_account_migrations_status
    ON google_drive_account_migrations(status);

CREATE INDEX IF NOT EXISTS idx_google_drive_account_migrations_source
    ON google_drive_account_migrations(source_account_id);

CREATE INDEX IF NOT EXISTS idx_google_drive_account_migrations_target
    ON google_drive_account_migrations(target_account_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_google_drive_account_migrations_active_source
    ON google_drive_account_migrations(source_account_id)
    WHERE status IN ('pending', 'running', 'waiting_for_storage');

CREATE TABLE IF NOT EXISTS google_drive_account_migration_items (
    id TEXT PRIMARY KEY,
    migration_id TEXT NOT NULL
        REFERENCES google_drive_account_migrations(id)
        ON DELETE CASCADE,

    source_file_id TEXT NOT NULL,
    target_file_id TEXT,
    target_account_id TEXT,
    size_bytes BIGINT NOT NULL DEFAULT 0,

    lease_generation BIGINT NOT NULL DEFAULT 0,
    lease_expires_at TIMESTAMPTZ,
    reconciliation_deadline TIMESTAMPTZ,

    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','reconciling','reconciliation_expired','ambiguous_identity','cancelled')),
    source_delete_status TEXT NOT NULL DEFAULT 'pending' CHECK (source_delete_status IN ('pending','failed','deleted','blocked_target_missing')),
    source_delete_error TEXT,

    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_retry_at TIMESTAMPTZ,
    next_retry_at TIMESTAMPTZ,
    cleanup_attempt_count INTEGER NOT NULL DEFAULT 0,
    cleanup_next_attempt_at TIMESTAMPTZ,
    reserved_bytes BIGINT NOT NULL DEFAULT 0,
    speed_bytes_per_second DOUBLE PRECISION NOT NULL DEFAULT 0,
    target_recovery_required BOOLEAN NOT NULL DEFAULT FALSE,

    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (migration_id, source_file_id)
);

CREATE INDEX IF NOT EXISTS idx_google_drive_account_migration_items_migration
    ON google_drive_account_migration_items(migration_id);

CREATE INDEX IF NOT EXISTS idx_google_drive_account_migration_items_status
    ON google_drive_account_migration_items(migration_id, status);

CREATE INDEX IF NOT EXISTS idx_gd_migration_items_quota_reservations
    ON google_drive_account_migration_items(target_account_id, status, reserved_bytes)
    WHERE reserved_bytes > 0;