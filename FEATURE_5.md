# Feature 5 — Activity Log

The admin panel now records important successful administrator actions in PostgreSQL and exposes them at `/admin/activity`.

## Logged events

- Admin login/logout
- Google Drive account connect/reconnect, enable, disable, remove
- Storage quota refresh
- Migration creation and cancellation requests
- Admin account creation, update, and removal

## API

`GET /api/admin/activity?page=1&pageSize=50&eventType=...`

The endpoint requires an authenticated admin session and returns paginated activity entries ordered newest-first.

## Database

`admin_activity_logs` stores actor identity, event type, entity identity, description, metadata, request IP, user agent, and timestamp. The runtime schema initializer creates the table and indexes automatically; `server/db/schema.sql` contains the same definition for clean databases.

Activity logging is intentionally non-blocking: failure to write a log entry is reported to server logs but does not turn a successful primary admin action into a failed request.
