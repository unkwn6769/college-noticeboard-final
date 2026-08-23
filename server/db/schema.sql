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
