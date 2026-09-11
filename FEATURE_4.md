# Feature 4 — Storage Usage by File Type

Adds an authenticated admin endpoint and page for storage usage by file type.

- GET /api/admin/storage/file-types
- Groups synced Google Drive files by extension/category.
- Uses BigInt-safe byte aggregation.
- Tracks unknown-size files separately.
- Adds `/admin/storage/file-types` and a link from Combined Total Storage.
