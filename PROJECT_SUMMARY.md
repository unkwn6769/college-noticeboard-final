# College Noticeboard — Full Project Summary

## 1. What the project is

College Noticeboard is a college-facing document/noticeboard application that crawls the college's noticeboard directories, stores a normalized catalogue in PostgreSQL, exposes a public searchable web interface, and provides an authenticated administration console for Google Drive-backed storage operations.

The project has two major planes:

- **Public noticeboard:** departments, folders/resources, file pages, search, and file status/viewing.
- **Admin/storage operations:** Google Drive account management, live Drive browsing, inventory search/filtering, storage health/type reporting, activity auditing, recycle-bin operations, migration, and source-retention cleanup operations.

## 2. Core data flow

1. The crawler starts from configured department noticeboard roots on the college server.
2. Directories are fetched and parsed into files/folders.
3. Resource metadata is synchronized into PostgreSQL.
4. File resources can be queued for Google Drive storage synchronization.
5. Public pages read the normalized database catalogue.
6. Admin pages operate on the managed Google Drive accounts and migration/storage state.

The crawler intentionally processes departments sequentially to avoid creating a burst of simultaneous requests against the college server.

## 3. Core public application

### Public routes

- `/` — department/noticeboard home and overview.
- `/search` — search results.
- `/department/:slug` — department resources.
- `/file/:slug` — file viewer/details.

### Public backend APIs

- `/api/health`
- `/api/browse`
- `/api/file-status`
- `/api/file`
- `/api/overview`
- `/api/search`

The frontend API base is configurable through `VITE_API_URL` and defaults to `http://localhost:3001` for local development.

## 4. Department crawler and synchronization

The crawler knows the configured department noticeboard slugs and recursively scans directories up to a bounded depth.

Important behavior:

- Request timeouts protect the crawler from hung source directories.
- HTTP and network/fetch failures are recorded separately.
- Sync runs are persisted.
- Removed resources are detected during reconciliation.
- The storage sync layer can download source files and place them into managed Google Drive storage.
- Source 404s are explicitly classified instead of being treated as generic failures.

## 5. Google Drive account management

The admin console supports multiple connected Google Drive accounts through OAuth.

Account operations include:

- Connect/add a Drive account.
- Reconnect/update account authorization.
- Enable/disable an account.
- Browse its files.
- Inspect storage/quota state.
- Remove an account only when the application has no mapped files and no unresolved migration cleanup obligations.

The backend keeps Drive credentials encrypted in the application data model rather than treating OAuth tokens as ordinary resource metadata.

## 6. Live Drive browser

The Drive browser uses the actual Google Drive API rather than only the application's local inventory.

Features include:

- Root-folder browsing.
- Real Drive folder IDs.
- Nested folders.
- Real parent/child breadcrumb navigation.
- Drive pagination through page tokens.
- Real file metadata such as MIME type, size, modified time, and Drive URL.
- Additional application metadata for managed files when a matching local resource exists.

The older mapped-inventory endpoints remain useful for search and operational inventory tasks.

## 7. Storage reporting and health

The admin storage area contains:

### Combined storage

Aggregates connected Google Drive account quota usage without double-counting shared data between accounts where the application's account model requires a normalized total.

### File-type reporting

`/admin/storage/file-types` groups files into stable categories such as:

- PDF/documents
- spreadsheets
- presentations
- images
- video/audio
- archives
- code/text
- other/unknown

The aggregation path is BigInt-safe for large byte totals and tracks unknown-size files separately.

### Storage health

Accounts are classified using freshness and authorization/quota state. A fresh connected account can be healthy, while stale refresh data and authorization failures are surfaced distinctly instead of being flattened into zero usage.

## 8. Admin activity log

The admin panel records important successful administrative actions in PostgreSQL and exposes a paginated activity view at `/admin/activity`.

Recorded categories include:

- Admin login/logout.
- Google Drive account connect/reconnect, enable, disable, and removal.
- Storage quota refresh.
- Migration creation and cancellation requests.
- Admin account management.
- Recycle-bin restore/permanent-delete operations.
- Source-cleanup retries.

Logging is non-blocking: a log-write failure is reported server-side instead of converting an otherwise successful primary admin action into a failed request.

## 9. Recycle Bin

The admin recycle bin surfaces managed files that are currently trashed in Google Drive.

Operations:

- List trashed managed files.
- Restore a trashed file and restore its local application availability.
- Permanently delete a trashed Drive file, remove its local mapping, and mark the resource unavailable.

Permanent deletion is owner-restricted.

## 10. Drive inventory search

`/admin/file-search` searches the managed Drive inventory server-side.

Search/filter dimensions include:

- Filename.
- Stored path.
- Drive file ID.
- Google Drive account.
- File type/category.
- Storage status.
- Availability.

Results are paginated in PostgreSQL so the browser does not load the entire inventory into memory.

## 11. Migration system — the most complex subsystem

The migration system moves managed files from one connected Google Drive account to another.

Its safety model is intentionally conservative:

1. Select actual available mapped files.
2. Create a durable migration row and durable per-file migration items.
3. Claim items with a fenced lease generation.
4. Download from the source Drive.
5. Upload to the assigned target Drive with a migration marker in `appProperties`.
6. Persist the target file ID before allowing destructive source cleanup.
7. Verify target identity/metadata.
8. Switch the application's mapping.
9. Delete the source file only after the target and application mapping are verified.
10. Record source-delete outcome and complete the migration item.

The migration database model tracks item state separately from overall migration state, allowing crash recovery, retries, reconciliation, and partial progress visibility.

## 12. Size-based migration selection

The admin migration modal supports three selection modes:

- **All files**
- **Custom file count**
- **Total size**

Size mode accepts:

- Target total size in MB.
- Minimum file size in MB.
- Maximum file size in MB.
- Minimum file count.
- Maximum file count.

Candidates are restricted to the configured file-size interval and selected largest-first until both the target total size and minimum-file requirement are met, while never exceeding the maximum file count.

This is the mechanism intended for batches such as approximately **500 MB–1 GB**, **50–100 files**, with a preferred per-file range around **5–20 MB**.

The implementation intentionally allows the selected total to overshoot the target because the unit of selection is a whole file, not a byte range.

## 13. Migration concurrency and throughput

Migration processing uses a worker pool instead of serially waiting for one file at a time.

Current controls:

- `MIGRATION_FILE_WORKERS` configures the per-migration file-worker count.
- The scheduler clamps this value to a maximum of 60.
- The scheduler can process up to three migrations concurrently.
- Workers immediately claim additional eligible items rather than waiting for a full batch wave to finish.

This removes a major source of throughput loss when file sizes vary significantly.

## 14. Scheduler lease / Render deployment overlap

The migration scheduler uses a PostgreSQL lease row so two application instances do not process migrations simultaneously.

Previously, a new Render instance could see the previous scheduler's lease and permanently give up scheduling.

The finalized behavior is:

- Attempt to acquire the lease.
- If another instance owns it, wait and retry.
- Once the old heartbeat expires or the old instance releases the lease, the new scheduler takes ownership.
- The scheduler keeps a heartbeat while running.

This is specifically designed for Render deployment overlap/restarts.

## 15. Crash recovery and reconciliation

Migration items have durable target identity and lease-generation fencing.

If a process dies after Drive accepted an upload but before PostgreSQL recorded the result, the next worker does **not** blindly create a second target file. It first checks for the migration marker on the assigned target account and adopts a valid existing target after verification.

If reconciliation cannot find a target:

- The item remains in `reconciling` rather than uploading a blind duplicate.
- A retry delay is stored in `next_retry_at`.
- The original reconciliation deadline is preserved rather than extended on every retry.
- The worker lease is released so another file is not needlessly blocked.
- When the deadline expires, the item becomes `reconciliation_expired` and requires operator attention.

The finalized claim logic also preserves `next_retry_at` for reconciling items so they cannot be immediately reclaimed in a tight loop.

## 16. Cancellation behavior

Migration cancellation is treated as a request, not an unsafe instant database deletion.

Running workers observe the cancellation request through their abort path. Once no migration items remain actively running, the migration is finalized as `cancelled` and pending/reconciling items are cancelled cleanly.

This avoids deleting the migration record while a worker may still be performing Drive operations.

## 17. Source-retention / cleanup visibility

`/admin/source-retention` is the operational view for files whose source copy is intentionally still retained.

It shows:

- Retained-source count.
- Pending cleanup.
- Cleanup failures.
- Blocked target-missing cases.
- Sources retained before migration completion.
- Source and target Drive links.
- Cleanup attempt counters and next cleanup times.

Search supports migration item IDs, source/target file IDs, and account email.

Source cleanup retry is owner-only because it can trigger a destructive Drive deletion. A `blocked_target_missing` state is visible but is not retried blindly.

## 18. PostgreSQL connection control

The project uses the `pg` connection pool.

The default pool limit is set to **6** in the finalized code and remains configurable through `DB_POOL_MAX`.

This was lowered specifically to prevent the application's own connection demand from colliding with Supabase/Supavisor session-mode limits observed during concurrency tests.

Other connection controls include configurable connection timeout, idle timeout, and connection lifetime settings.

## 19. Security / authorization boundaries

The backend distinguishes normal authenticated-admin operations from owner-only destructive operations.

Examples of owner-restricted actions:

- Permanent recycle-bin deletion.
- Source cleanup retry.
- Other high-impact administration paths governed by `requireOwner`.

Migration source deletion is never supposed to be triggered merely because an upload was attempted. It is tied to durable target identity, target verification, and application mapping state.

## 20. Current project structure

### Frontend

- `src/App.jsx` — route composition.
- `src/pages/Home.jsx` — public home/overview.
- `src/pages/SearchResults.jsx` — search UI.
- `src/pages/Department.jsx` — department browser.
- `src/pages/FileViewer.jsx` — file page.
- `src/pages/admin/*` — admin console pages.
- `src/config/api.js` — API base URL configuration.
- `src/data/departments.js` — department display metadata.
- `src/components/*` — shared public UI pieces.

### Backend

- `server/server.js` — Express API and application wiring.
- `server/adminAuth.js` — admin session/authentication helpers.
- `server/driveAccountOAuth.js` — Google Drive OAuth handling.
- `server/migrationWorker.js` — per-file migration state machine.
- `server/migrationRunner.js` — worker-pool execution.
- `server/migrationScheduler.js` — global scheduling/lease/recovery.
- `server/activityLog.js` — admin audit logging.
- `server/recycleBin.js` — recycle-bin operations.
- `server/sourceRetention.js` — source-retention reporting.
- `server/driveFileSearch.js` — inventory search.
- `server/storage/*` — Drive storage, quota, health, and file-type reporting.
- `server/crawler/*` — college noticeboard crawling and synchronization.
- `server/db/schema.sql` — PostgreSQL schema.

## 21. Deployment model

### Frontend

Vite builds the React application into `dist`.

### Backend

The server is an Express service. The Render deployment used `npm start`, with the backend binding to Render's supplied port.

### Local development

From the project root:

```bash
npm install
npm run dev:all
```

The combined development script starts:

- Vite frontend at `http://localhost:5173`
- Express backend at `http://localhost:3001`

## 22. Important environment variables

See `.env.example`.

Key groups:

- Frontend API URL.
- PostgreSQL connection.
- Database pool tuning.
- Token-encryption secret.
- Admin Google OAuth.
- Drive-account Google OAuth.
- Frontend/production callback URLs.
- Migration worker count.

A real `.env` file is deliberately **not included** in the final ZIP.

## 23. Known verification boundary for this final archive

The archive was assembled from the latest available project snapshot plus the migration/source-retention changes represented in the conversation history.

Static validation performed during finalization:

- Node syntax checks for the modified backend modules.
- JavaScript test-file syntax checks.
- Package JSON consistency checks.
- Secret-file exclusion from the archive.
- Final-file cleanup of backup artifacts and `node_modules`.

The full dependency-based Vite build and PostgreSQL-backed integration test suite could not be re-executed inside this environment because npm registry DNS/network access is unavailable here. Earlier local logs from the project show successful Vite builds and most backend tests, while the previously observed failing fencing test was caused by the Supavisor session-mode connection ceiling rather than a JavaScript syntax error.

## 24. Recommended production startup sequence

1. Install dependencies with network access.
2. Provide production `.env` values outside the repository.
3. Run the database preflight/schema initialization.
4. Run the backend.
5. Confirm only one scheduler owns the database lease.
6. Start a small migration test first.
7. Confirm target verification, mapping switch, source cleanup, and cancellation/reconciliation behavior.
8. Scale the worker count only after observing aggregate MB/s and database pressure.

## 25. Final intent of the project

The project has evolved from a straightforward college noticeboard browser into an operational content-storage platform: the public side provides discoverable college resources, while the admin side manages multi-account Google Drive storage, inventory, auditing, recovery, and safe account/file migration.
