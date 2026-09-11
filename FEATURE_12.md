# Feature 12 — Cleanup / Source-Retention Visibility

## Added
- `/admin/source-retention` operational view for migration-source retention.
- Summary counts for retained sources, pending cleanup, cleanup failures, blocked targets, and sources retained before migration completion.
- Search by migration item, source/target file ID, or account email.
- Filters for source-cleanup state and migration state.
- Direct Source/Target Google Drive links.
- Owner-only source-cleanup retry for completed items in pending/failed cleanup state.
- Activity Log event for cleanup retries.
- Admin dashboard card.

## Safety boundary
- The read-only view is available to authenticated admins.
- Retrying source cleanup is owner-only because it can trigger a destructive source deletion after the worker's target verification protocol.
- Items with `blocked_target_missing` are visible but cannot be retried blindly.
- Items leave the view once `source_delete_status = 'deleted'`.
