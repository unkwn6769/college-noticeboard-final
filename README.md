# College Noticeboard

A React/Vite frontend plus Express/PostgreSQL backend for a college noticeboard, Google Drive-backed storage, admin operations, and safe multi-account Drive migration.

## Run locally

```bash
npm install
npm run dev:all
```

Frontend: `http://localhost:5173`

Backend: `http://localhost:3001`

Copy `.env.example` to `.env` and provide the required credentials/secrets. Never commit the real `.env`.

## Build

```bash
npm run build
```

## Tests

```bash
npm test
```

The backend test suite uses the configured PostgreSQL environment.

## Admin areas

- `/admin`
- `/admin/accounts`
- `/admin/accounts/:accountId/files`
- `/admin/storage`
- `/admin/storage/health`
- `/admin/storage/file-types`
- `/admin/file-search`
- `/admin/activity`
- `/admin/recycle-bin`
- `/admin/source-retention`

## Migration batch selection

The admin migration modal supports all files, a custom count, or size-based selection with:

- target total size,
- minimum and maximum file size,
- minimum and maximum file count.

Files in size mode are selected largest-first from the configured size range until both the target size and minimum file count are reached, subject to the maximum file count.

## Migration reliability

Migration items use durable target identity, per-item lease generations, worker heartbeats, reconciliation, retry delays, scheduler leasing, stale-item recovery, and guarded source deletion.

See `MIGRATION_FIXES.md` and `PROJECT_SUMMARY.md` for the full design and the fixes finalized during the migration work.
