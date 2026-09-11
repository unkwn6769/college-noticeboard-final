# Feature 6 — Recycle Bin

The admin Recycle Bin shows managed Google Drive files that are currently in Drive trash.

- `GET /api/admin/recycle-bin` lists trashed managed files across connected accounts.
- `POST /api/admin/recycle-bin/:fileId/restore` restores a trashed managed file and marks its application resource available again.
- `DELETE /api/admin/recycle-bin/:fileId` permanently deletes the file from Drive; this operation is restricted to owners and removes the local file-account mapping while marking the resource unavailable.
- Activity log entries are recorded for restore and permanent deletion actions.
